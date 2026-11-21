#!/usr/bin/env python3
import argparse
import json
import os
import re
import stat
from datetime import datetime
from pathlib import Path

LIMIT = 64 * 1024 * 1024

def open_evidence(path):
    """Walk parents by descriptor: never follow links or open a blocking leaf."""
    parts = Path(os.path.abspath(path)).parts
    parent = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
        os.close(fd)
        raise ValueError('ERROR evidence file must be regular and bounded')
    return fd, info

def read_text(path):
    fd, _ = open_evidence(path)
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('ERROR evidence file exceeds byte bound')
    return data.decode('utf-8')

class Journal:
    """Consume complete appended JSONL records once; retain a partial last line."""
    def __init__(self, path):
        self.path, self.offset, self.identity, self.pending, self.records = path, 0, None, b'', []

    def poll(self):
        fd, info = open_evidence(self.path)
        with os.fdopen(fd, 'rb') as stream:
            identity = (info.st_dev, info.st_ino)
            if self.identity is not None and (identity != self.identity or info.st_size < self.offset):
                raise ValueError('ERROR evidence file replaced or truncated')
            self.identity = identity
            stream.seek(self.offset)
            data = stream.read(LIMIT - self.offset + 1)
        self.offset += len(data)
        if self.offset > LIMIT:
            raise ValueError('ERROR evidence file exceeds byte bound')
        lines = (self.pending + data).split(b'\n')
        self.pending = lines.pop()
        self.records.extend(json.loads(line) for line in lines if line.strip())
        return self.records

def timestamp(record):
    # The plugin log stamps `at`, transcripts `timestamp`, auto-effort `ts`.
    value = next((record[k] for k in ('at', 'timestamp', 'ts') if k in record), None)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    raise ValueError('NOT RUN: evidence timestamp missing')

def validity(lane, require_debug=True):
    # API/auth errors are rejected before missing evidence or any cache assertion.
    if any(r.get('message', {}).get('model') == '<synthetic>' or r.get('isApiErrorMessage') for r in lane.get('transcript', [])):
        raise ValueError('VOID API/auth error: synthetic/error model response')
    if '[ERROR] API' in lane.get('debug', ''):
        raise ValueError('VOID API/auth error in debug log')
    if require_debug and not isinstance(lane.get('debug'), str):
        raise ValueError('NOT RUN: debug validity evidence missing')

def compactions(rows):
    """Split the plugin log's compact rows into real compactions of the lane's own main session and recorded others.
    Claude Code also dispatches session.compact as `precompute`, which installs nothing, and for a sub-agent's own loop
    (`agentId`), which leaves the main prefix: both are recorded only, as is one whose outcome is `skipped` (a
    plugin's veto) or `failed`, which installs nothing. A row without its trigger, or without its outcome (a log from
    before the plugin recorded them), counts as real, so a legacy compaction still voids."""
    real, recorded = [], []
    for r in rows:
        if r.get('event') != 'compact':
            continue
        trigger, agent = r.get('trigger'), r.get('agentId')
        if isinstance(trigger, str) and (trigger == 'precompute' or isinstance(agent, str) and agent or r.get('outcome') in ('skipped', 'failed')):
            recorded.append({k: r[k] for k in ('at', 'trigger', 'agentId', 'outcome') if k in r})
        else:
            real.append(r)
    return real, recorded

def compaction_verdict(rows):
    """The first real main-session compaction as its verdict text, or None."""
    real, _ = compactions(rows)
    if not real:
        return None
    trigger = real[0].get('trigger')
    return f"compaction during the lane: {trigger if isinstance(trigger, str) else 'unrecorded'} compaction of the main session"

def prefix_kept(lane):
    """Each main-thread request record re-sends `keep` of its base request's messages and appends `tail`. One keeping
    fewer than its base sent means Claude Code rewrote the conversation's prefix mid-lane (measured: a plugin reload
    re-rendered the environment message), which drops the cache for the warm and the chat alike: the lane is VOID."""
    requests = [r for r in lane.get('transcript', []) if r.get('type') == 'api-request' and r.get('querySource') == 'repl_main_thread']
    if any(not isinstance(r.get('keep'), int) or not isinstance(r.get('tail'), list) for r in requests):
        raise ValueError('NOT RUN: main-thread request record malformed')
    sent = {r.get('id'): r['keep'] + len(r['tail']) for r in requests}
    extended = [r for r in requests if r.get('base') in sent]
    if not extended:
        raise ValueError('NOT RUN: main-thread request records missing')
    for r in extended:
        if r['keep'] < sent[r['base']]:
            raise ValueError('VOID prefix rewritten mid-lane: request ' + str(r.get('id')) + ' kept ' + str(r['keep']) + ' of ' + str(sent[r['base']]) + ' messages')

def reply_text(record):
    """The reply's own text blocks: a tool call's input (an Agent prompt quoting the instructions) is never a reply."""
    content = record.get('message', {}).get('content', [])
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')

POKE = 'Keep-warm poke '
POKE_FOOTER = 'If any of these is stale or was started by accident, stop it now. Otherwise reply with the single word `waiting` and nothing else: this turn only keeps the cache warm, and the plugin reads nothing from your reply.'
# A poke opens with its header on a line of its own; a prompt that only names the header (the lane's launch) is never a poke.
POKE_HEAD = re.compile(r'^Keep-warm poke \d+/\d+: ', re.M)
BULLET = re.compile(r'^- (agent|command|Monitor|workflow) `([^`]+)`: (.+), pending (\d+m|\d+h\d\dm)$')

def prompt_row(record):
    """A user row that opens a turn: text, not only tool results."""
    if record.get('type') != 'user':
        return False
    content = record.get('message', {}).get('content', [])
    return isinstance(content, str) or any(isinstance(b, dict) and b.get('type') == 'text' for b in content)

def poke_turns(records):
    """Each visible poke the plugin submitted: its prompt row, its text from the poke header through the footer, and the
    rows of its whole turn (the prompt up to the next prompt), which are the plugin's own traffic, never the chat's."""
    turns = []
    for i, record in enumerate(records):
        text = reply_text(record) if prompt_row(record) else ''
        head = POKE_HEAD.search(text)
        if not head:
            continue
        start = head.start()
        end = text.find(POKE_FOOTER, start)
        end = len(text) if end < 0 else end + len(POKE_FOOTER)
        last = next((j for j in range(i + 1, len(records)) if prompt_row(records[j])), len(records))
        turns.append({'index': i, 'text': text[start:end], 'rows': range(i, last)})
    return turns

def poke_items(text, n, total):
    """The ids one poke names, after its exact header, one well-formed bullet per pending item and its exact footer."""
    lines = text.split('\n')
    header = f'{POKE}{n}/{total}: your prompt cache was about to expire, so this message keeps it warm while you wait on:'
    if len(lines) < 3 or lines[0] != header or lines[-1] != POKE_FOOTER:
        raise ValueError('FAIL poke text: ' + json.dumps(text[:400]))
    found = [BULLET.match(line) for line in lines[1:-1]]
    if not all(found):
        raise ValueError('FAIL poke bullet: ' + json.dumps(text[:400]))
    return [m.group(2) for m in found]

def handback(record):
    """The task id a sub-agent's hand-back message names, None for any other record."""
    origin = record.get('origin') if isinstance(record.get('origin'), dict) else {}
    return origin.get('senderTaskId') if origin.get('kind') == 'peer' and origin.get('handback') is True else None

def reply_window(lane):
    """The unique WAITING -> RETURNED window outside the plugin's own poke turns, its quiet-window proof and the return's
    cache-read ratio."""
    records = lane['transcript']
    own = {i for turn in poke_turns(records) for i in turn['rows']}
    kept = [(i, r) for i, r in enumerate(records) if i not in own]
    replies = [(i, r) for i, r in kept if r.get('type') == 'assistant' and 'RETURNED' in reply_text(r)]
    waits = [(i, r) for i, r in kept if r.get('type') == 'assistant' and 'WAITING' in reply_text(r)]
    if len(replies) != 1 or len(waits) != 1:
        raise ValueError('NOT RUN: unique WAITING/return response missing')
    end, reply = replies[0]
    start, waiting = waits[0]
    # One API response can be written as several records (a thinking block, then the text); they share message.id.
    reply_id = reply.get('message', {}).get('id')
    # Claude Code's meta records (a tools-used reminder before a notification) ride the delivery's own request; the
    # delivery is a task notification or, since 2.1.316, a sub-agent's hand-back message (a meta record of origin peer).
    between = [r for i, r in kept if start < i < end and r.get('type') in ('user', 'assistant') and not (reply_id and r.get('type') == 'assistant' and r.get('message', {}).get('id') == reply_id) and not (r.get('isMeta') and not handback(r))]
    if start >= end or len(between) != 1 or between[0].get('type') != 'user' or not (handback(between[0]) or '<task-notification' in json.dumps(between[0].get('message', {}).get('content', []))):
        raise ValueError('FAIL transcript quiet window: extra main traffic or missing notification')
    task = handback(between[0]) or re.search(r'<task-id>([^<]+)</task-id>', json.dumps(between[0].get('message', {}).get('content', [])))
    message = reply['message']
    if message.get('model') != 'claude-haiku-5-5':
        raise ValueError('FAIL wrong model: ' + str(message.get('model')))
    usage = message.get('usage', {})
    counts = [usage.get(k) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')]
    if any(not isinstance(n, (int, float)) or not 0 <= n < float('inf') for n in counts) or sum(counts) <= 0:
        raise ValueError('FAIL return usage absent or invalid')
    ratio = usage['cache_read_input_tokens'] / sum(counts)
    lane['returnEvidence'] = {'path': lane.get('transcriptPath'), 'line': end + 1, 'usage': usage, 'ratio': ratio, 'taskId': task if isinstance(task, str) else task.group(1) if task else None}
    return (timestamp(waiting), timestamp(reply)), ratio

def main_log(lane):
    return [r for r in lane.get('log', []) if r.get('kind') != 'subagent']

def main_pokes(lane, window):
    """The main chat's pokes inside the wait: every admission settled by one charged poke row and one visible poke in the
    transcript, in order, each counting itself against the cap and naming exactly the ids the plugin tracked, admitted 4
    minutes after the main request before it, its own request read from cache."""
    log = main_log(lane)
    admits = [r for r in log if r.get('event') == 'admit']
    pokes = [r for r in log if r.get('event') == 'poke']
    turns = poke_turns(lane['transcript'])
    if len(admits) != len(pokes) or len(turns) != len(pokes):
        raise ValueError(f'FAIL poke evidence: {len(admits)} admitted, {len(pokes)} charged, {len(turns)} in the transcript')
    anchors = sorted(r['anchorAt'] for r in log if r.get('event') == 'step' and isinstance(r.get('anchorAt'), (int, float)))
    results = []
    for n, (admit, poke, turn) in enumerate(zip(admits, pokes, turns), 1):
        at = timestamp(admit)
        if not window[0] < at < window[1]:
            raise ValueError('FAIL poke admitted outside the wait')
        before = [a for a in anchors if a <= at]
        if not before or abs(at - before[-1] - 240000) > 5000:
            raise ValueError('FAIL poke admission timing')
        limit = poke.get('pokes') if isinstance(poke.get('pokes'), dict) else {}
        total = limit.get('max')
        if not isinstance(total, int) or limit.get('count') != n:
            raise ValueError('FAIL poke count: ' + str(limit))
        ids = poke_items(turn['text'], n, total)
        tracked = sorted(i.get('id') for i in admit.get('items', []) if isinstance(i, dict))
        if sorted(ids) != tracked:
            raise ValueError('FAIL poke ids ' + str(ids) + ' differ from the tracked ' + str(tracked))
        u = poke.get('usage', {})
        if poke.get('reason') != 'eligible' or u.get('cache_read_input_tokens', 0) < .9 * poke.get('context', float('inf')):
            raise ValueError('FAIL poke usage')
        results.append({'n': n, 'max': total, 'ids': ids, 'at': at, 'settledAt': timestamp(poke), 'line': turn['index'] + 1, 'usage': u})
    return results

def no_lapse(lane, window):
    """No 5-minute gap between the main requests of the wait, its last request before it through the return."""
    anchors = sorted(r['anchorAt'] for r in main_log(lane) if r.get('event') == 'step' and isinstance(r.get('anchorAt'), (int, float)))
    sent = [a for a in anchors if a <= window[0]][-1:] + [a for a in anchors if window[0] < a < window[1]] + [window[1]]
    gaps = [b - a for a, b in zip(sent, sent[1:])]
    if len(sent) < 2 or max(gaps) >= 300000:
        raise ValueError('FAIL cache lapsed during the wait: main request gaps ' + str(gaps))

def poke_windows(pokes):
    """Each poke is a real main turn: auto-effort may step inside it."""
    return [(p['at'] - 1000, p['settledAt'] + 5000) for p in pokes]

def lane_ready(lane):
    validity(lane, require_debug=False)
    if lane.get('trustBlocked'):
        raise ValueError('BLOCKED folder trust: no consent was synthesized')
    if not any(r.get('event') == 'LOADED' for r in lane.get('log', [])):
        raise ValueError('ERROR need plugin load marker')
    validity(lane)
    prefix_kept(lane)

def check(evidence):
    lanes = evidence.get('lanes', [])
    for lane in lanes:
        validity(lane, require_debug=False)
    for lane in lanes:
        lane_ready(lane)
    if len(lanes) != 2:
        raise ValueError('NOT RUN: warm/control pair incomplete')
    warm, control = lanes
    ratios, windows = [], []
    for lane in lanes:
        window, ratio = reply_window(lane)
        windows.append(window)
        ratios.append(ratio)
        if not isinstance(lane.get('effort'), list):
            raise ValueError('NOT RUN: auto-effort evidence missing')
    if ratios[0] < .9 or ratios[1] >= .9:
        raise ValueError('FAIL cache separation: ' + str(ratios))
    pokes = main_pokes(warm, windows[0])
    if not pokes:
        raise ValueError('FAIL no poke in the warm lane')
    no_lapse(warm, windows[0])
    task = warm['returnEvidence'].get('taskId')
    if not task or any(task not in p['ids'] for p in pokes):
        raise ValueError('FAIL poke does not name the real task id ' + str(task))
    if poke_turns(control['transcript']) or any(r.get('event') in ('admit', 'poke') for r in main_log(control)):
        raise ValueError('FAIL control lane poked with warming off')
    effort_quiet(warm['effort'], windows[0], poke_windows(pokes))
    effort_quiet(control['effort'], windows[1])
    for lane in lanes:
        if compaction_verdict(lane['log']):
            raise ValueError('FAIL unexpected ' + compaction_verdict(lane['log']))
    if not isinstance(warm.get('waitingState'), dict) or warm['waitingState'].get('state') != 'warming':
        raise ValueError('FAIL waiting session state not warming: ' + json.dumps(warm.get('waitingState')))
    if not isinstance(warm.get('returnedState'), dict):
        raise ValueError('NOT RUN: returned session state missing')
    if warm['returnedState'].get('state') == 'warming':
        raise ValueError('FAIL warming session state survived return')
    return {'verdict': 'PASS cache separation', 'ratios': ratios, 'pokes': pokes, 'lanes': lanes}

def check_cap(lane):
    """One warm lane capped at 2 pokes over a wait long enough for 3 or more: exactly 2 pokes, a recorded poke-limit stop
    shown in the session state, and no poke after it while the wait went on past when a third was due."""
    lane_ready(lane)
    window, ratio = reply_window(lane)
    if not isinstance(lane.get('effort'), list):
        raise ValueError('NOT RUN: auto-effort evidence missing')
    pokes = main_pokes(lane, window)
    if [(p['n'], p['max']) for p in pokes] != [(1, 2), (2, 2)]:
        raise ValueError('FAIL cap: pokes ' + str([(p['n'], p['max']) for p in pokes]) + ', expected 1/2 and 2/2')
    last = pokes[-1]['settledAt']
    limits = [r for r in main_log(lane) if r.get('event') == 'decision' and r.get('reason') == 'poke-limit' and r.get('pokes') == {'count': 2, 'max': 2} and timestamp(r) >= last]
    if not limits:
        raise ValueError('FAIL cap: no poke-limit decision after the second poke')
    if window[1] - pokes[-1]['at'] < 300000:
        raise ValueError('NOT RUN: the wait ended before a third poke was due')
    effort_quiet(lane['effort'], window, poke_windows(pokes))
    if compaction_verdict(lane['log']):
        raise ValueError('FAIL unexpected ' + compaction_verdict(lane['log']))
    limit = lane.get('limitState')
    if not isinstance(limit, dict) or (limit.get('state'), limit.get('reason'), limit.get('pokes')) != ('stopped', 'poke-limit', {'count': 2, 'max': 2}):
        raise ValueError('FAIL poke limit session state absent: ' + json.dumps(limit))
    return {'verdict': 'PASS cap: 2 pokes, then none', 'pokes': pokes, 'limitAt': timestamp(limits[0]), 'returnRatio': ratio, 'waitMs': window[1] - window[0]}

def effort_quiet(rows, window, allowed=()):
    """No auto-effort step of any turn but the WAITING turn and the plugin's own poke turns inside the wait: a request's
    step row is written just after its response, so the WAITING turn's own row can land a few milliseconds past the
    WAITING timestamp."""
    closing = [r for r in rows if r.get('event') == 'turn' and timestamp(r) >= window[0] - 1000]
    waiting_turn = closing[0].get('turnId') if closing else None
    if any(r.get('event') == 'step' and window[0] < timestamp(r) < window[1] and (waiting_turn is None or r.get('turnId') != waiting_turn) and not any(lo <= timestamp(r) <= hi for lo, hi in allowed) for r in rows):
        raise ValueError('FAIL auto-effort ran during the wait outside a poke')

def check_1h(lane, warm1h):
    """One 1h-TTL lane: with warm1h, one poke at 80% carries a >1h wait; without, a refusal and no poke."""
    lane_ready(lane)
    # The first step can precede the TTL hand-off (5m, assumed); every decision, admission and poke must see 1h from the env.
    judged = [r for r in main_log(lane) if r.get('event') in ('decision', 'admit', 'poke')]
    if not any(r.get('event') == 'decision' for r in judged) or any(r.get('ttl') != '1h' or r.get('ttlSource') != 'env' for r in judged):
        raise ValueError('ERROR need 1h rows from the env source: ' + str(sorted({(r.get('event'), r.get('ttl'), r.get('ttlSource')) for r in judged})))
    window, ratio = reply_window(lane)
    gap = window[1] - window[0]
    if not isinstance(lane.get('effort'), list):
        raise ValueError('NOT RUN: auto-effort evidence missing')
    admits = [r for r in judged if r.get('event') == 'admit']
    if not warm1h:
        effort_quiet(lane['effort'], window)
        if admits or any(r.get('event') == 'poke' for r in judged) or poke_turns(lane['transcript']):
            raise ValueError('FAIL 1h refusal admitted a poke')
        if not any(r.get('event') == 'decision' and r.get('reason') == '1h-unproven' for r in judged):
            raise ValueError('FAIL 1h refusal reason absent')
        if gap <= 300000 or ratio < .9:
            raise ValueError('FAIL 1h TTL not in effect: gap ' + str(gap) + ' ms, read ratio ' + str(ratio))
        return {'verdict': 'PASS ttl-1h refusal', 'ratio': ratio, 'gapMs': gap}
    if gap <= 3600000:
        raise ValueError('NOT RUN: main gap does not outlast 1h: ' + str(gap) + ' ms')
    anchors = [r['anchorAt'] for r in main_log(lane) if r.get('event') == 'step' and isinstance(r.get('anchorAt'), (int, float)) and r['anchorAt'] <= window[0]]
    pokes = [r for r in judged if r.get('event') == 'poke']
    if len(pokes) != 1 or len(admits) != 1 or not anchors:
        raise ValueError('FAIL prescribed 1h poke count/anchor absent')
    if abs(timestamp(admits[0]) - max(anchors) - 2880000) > 5000:
        raise ValueError('FAIL 1h admission timing')
    u = pokes[0].get('usage', {})
    if u.get('cache_read_input_tokens', 0) < .9 * pokes[0].get('context', float('inf')):
        raise ValueError('FAIL poke usage')
    effort_quiet(lane['effort'], window, [(timestamp(admits[0]) - 1000, timestamp(pokes[0]) + 5000)])
    if ratio < .9:
        raise ValueError('FAIL 1h refresh did not hold: read ratio ' + str(ratio))
    if compaction_verdict(lane['log']):
        raise ValueError('FAIL unexpected ' + compaction_verdict(lane['log']))
    return {'verdict': 'PASS ttl-1h refresh', 'ratio': ratio, 'gapMs': gap}

def cache_ratio(record):
    message = record.get('message', {})
    if message.get('model') != 'claude-haiku-5-5':
        raise ValueError('FAIL wrong sub-agent model')
    usage = message.get('usage', {})
    counts = [usage.get(k) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')]
    if any(not isinstance(n, (int, float)) or not 0 <= n < float('inf') for n in counts) or sum(counts) <= 0:
        raise ValueError('NOT RUN: sub-agent usage missing or invalid')
    return usage['cache_read_input_tokens'] / sum(counts)

def parent_wakes(lane, since):
    """The parent turns the sub-agent's pokes woke, as observed: Claude Code hands the spawning parent an interim
    notification for each sub-agent turn, a poke's included. They are recorded, never filtered or failed; the real return
    must still reach the parent as a normal request."""
    rows, agent = lane['transcript'], lane['agentId']
    def notice(row):
        text = reply_text(row)
        return row.get('type') == 'user' and '<task-id>' + agent + '</task-id>' in text and row.get('origin', {}).get('kind') == 'task-notification'
    def requests_after(index):
        end = next((j for j in range(index + 1, len(rows)) if rows[j].get('type') == 'user'), len(rows))
        return len({r.get('requestId') or r.get('message', {}).get('id') for r in rows[index + 1:end] if r.get('type') == 'assistant' and any(type(v) in (int, float) and v > 0 for v in r.get('message', {}).get('usage', {}).values())})
    returned = [i for i, row in enumerate(rows) if notice(row) and '<result>SUBAGENT_RETURNED</result>' in reply_text(row)]
    if len(returned) != 1 or not requests_after(returned[0]):
        raise ValueError('FAIL real child notification did not produce a normal parent request')
    wakes = [i for i, row in enumerate(rows) if notice(row) and i not in returned and since is not None and timestamp(row) > since]
    return {'parentWakes': len(wakes), 'parentWakeRequests': [requests_after(i) for i in wakes], 'parentReturnRequests': requests_after(returned[0])}

def check_subagents(evidence):
    lanes = evidence.get('lanes', [])
    if len(lanes) != 2:
        raise ValueError('NOT RUN: sub-agent warm/control pair incomplete')
    results = []
    for warm, lane in zip((True, False), lanes):
        validity(lane)
        prefix_kept(lane)
        records = lane.get('subagent', [])
        validity({**lane, 'transcript': records})
        if not any(r.get('event') == 'LOADED' for r in lane.get('log', [])) or not records or not lane.get('agentId') or not isinstance(lane.get('effort'), list):
            raise ValueError('NOT RUN: sub-agent load/ownership/effort evidence missing')
        if poke_turns(lane['transcript']) or any(r.get('event') in ('admit', 'poke') for r in main_log(lane)):
            raise ValueError('FAIL the main chat was poked in a sub-agent lane')
        calls = [b for r in records for b in r.get('message', {}).get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name') == 'Bash' and b.get('input', {}).get('run_in_background') is True]
        owned = [r.get('toolUseResult', {}).get('backgroundTaskId') for r in records if isinstance(r.get('toolUseResult'), dict) and any(b.get('tool_use_id') == c.get('id') for b in r.get('message', {}).get('content', []) if isinstance(b, dict) for c in calls)]
        owned = [i for i in owned if isinstance(i, str)]
        turns = poke_turns(records)
        own = {i for turn in turns for i in turn['rows']}
        waiting = [r for i, r in enumerate(records) if i not in own and r.get('type') == 'assistant' and 'SUBAGENT_WAITING' in reply_text(r)]
        returns = [r for i, r in enumerate(records) if i not in own and r.get('type') == 'assistant' and 'SUBAGENT_RETURNED' in reply_text(r)]
        notifications = [i for i, r in enumerate(records) if r.get('type') == 'user' and '<task-notification' in reply_text(r) and any('<task-id>' + task + '</task-id>' in reply_text(r) for task in owned)]
        if not owned or len(waiting) != 1 or len(returns) != 1 or len(notifications) != 1:
            raise ValueError('NOT RUN: unique owned background task/wait/notification/return absent')
        if timestamp(returns[0]) - timestamp(waiting[0]) <= 300000 or records.index(returns[0]) <= notifications[0]:
            raise ValueError('NOT RUN: sub-agent wait did not outlast 5m or return preceded notification')
        sub = [r for r in lane['log'] if r.get('kind') == 'subagent' and r.get('agentId') == lane['agentId']]
        admits = [r for r in sub if r.get('event') == 'admit' and r.get('reason') == 'eligible']
        warm_rows = [r for r in sub if r.get('event') == 'warm']
        if warm and (not turns or len(admits) != len(turns) or len(warm_rows) != len(turns)):
            raise ValueError('FAIL sub-agent native send/usage evidence absent')
        if not warm and (turns or admits or warm_rows):
            raise ValueError('FAIL subagents off still warmed')
        warm_ratios, spent, tools = [], 0, []
        keys = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
        for count, (turn, admit, row) in enumerate(zip(turns, admits, warm_rows), 1):
            i = turn['index']
            if not timestamp(waiting[0]) < timestamp(admit) < timestamp(returns[0]) or abs(timestamp(records[i]) - timestamp(admit)) > 10000:
                raise ValueError('FAIL sub-agent send outside waiting interval')
            limit = admit.get('pokes') if isinstance(admit.get('pokes'), dict) else {}
            if limit.get('count') != count or sorted(poke_items(turn['text'], count, limit.get('max'))) != sorted(owned):
                raise ValueError('FAIL sub-agent poke does not count itself or name the owned task ' + str(owned))
            replies = [records[j] for j in turn['rows'] if records[j].get('type') == 'assistant']
            if not replies:
                raise ValueError('FAIL sub-agent poke turn absent')
            # The poke may let the model stop stale work: its tool calls are recorded, never failed.
            tools += [b.get('name') for r in replies for b in r.get('message', {}).get('content', []) if isinstance(b, dict) and b.get('type') == 'tool_use']
            seen, total = set(), dict.fromkeys(keys, 0)
            for reply in replies:
                key = reply.get('requestId') or reply.get('message', {}).get('id')
                if key not in seen:
                    seen.add(key)
                    usage = reply.get('message', {}).get('usage', {})
                    if any(type(usage.get(k)) not in (int, float) or not 0 <= usage[k] < float('inf') for k in keys):
                        raise ValueError('NOT RUN: poke transcript output/usage missing or invalid')
                    for k in keys:
                        total[k] += usage[k]
                    ratio = cache_ratio(reply)
                    if ratio < .9:
                        raise ValueError('FAIL sub-agent poke cache read: ' + str(ratio))
                    warm_ratios.append(ratio)
            if any(type(row.get('usage', {}).get(k)) not in (int, float) or row['usage'][k] != total[k] for k in keys):
                raise ValueError('FAIL native poke usage differs from transcript')
            spent += total['input_tokens'] + total['output_tokens'] * 5 + total['cache_read_input_tokens'] * .1 + total['cache_creation_input_tokens'] * 2
            ledger = row.get('ledger', {})
            if any(type(v) not in (int, float) or abs(v - spent) > 1e-5 for v in (row.get('spent'), ledger.get('spent'))) or row.get('warms') != count or ledger.get('warms') != count:
                raise ValueError('FAIL native poke charge/ledger differs from transcript')
        ratio = cache_ratio(returns[0])
        if warm and ratio < .9 or not warm and ratio >= .2:
            raise ValueError('FAIL sub-agent return cache separation: ' + str(ratio))
        since = timestamp(admits[0]) if admits else None
        results.append({'path': lane.get('subagentPath'), 'agentId': lane['agentId'], 'pokes': len(turns), 'pokeRatios': warm_ratios, 'pokeTools': tools, 'returnRatio': ratio, **parent_wakes(lane, since)})
    return {'verdict': 'PASS subagent-wait cache separation', 'lanes': results}


def check_state(evidence):
    """One live chat: the public disk record before and after the immediate off command."""
    validity(evidence, require_debug=False)
    initial, off = evidence.get('initialState'), evidence.get('offState')
    fields = {'v', 'sessionId', 'pid', 'updatedAt', 'enabled', 'source', 'state', 'reason', 'pokes', 'nextAt', 'protectingTokensEq'}
    for record in [initial, off]:
        if not isinstance(record, dict) or set(record) != fields or record['v'] != 1:
            raise ValueError('FAIL incomplete v1 state record')
        if record['sessionId'] != evidence.get('sessionId') or type(record['pid']) is not int or record['pid'] <= 0:
            raise ValueError('FAIL state session/PID identity')
        if type(record['updatedAt']) is not int or record['updatedAt'] <= 0:
            raise ValueError('FAIL state timestamp')
        pokes = record['pokes']
        if pokes is not None and (not isinstance(pokes, dict) or set(pokes) != {'count', 'max'} or type(pokes['count']) is not int or type(pokes['max']) is not int or not 0 <= pokes['count'] <= pokes['max']):
            raise ValueError('FAIL state poke counters')
    if initial['enabled'] is not True or initial['source'] != 'launch' or initial['state'] != 'on':
        raise ValueError('FAIL initial enabled v1 state')
    if off['enabled'] is not False or off['source'] != 'session' or off['state'] != 'off' or off['reason'] != 'off' or off['nextAt'] is not None:
        raise ValueError('FAIL off v1 replacement')
    if off['pid'] != initial['pid'] or off['updatedAt'] < initial['updatedAt'] or evidence.get('pidAlive') is not True:
        raise ValueError('FAIL state liveness/replacement identity')
    return {'verdict': 'PASS v1 state write then /keepwarm off', 'sessionId': off['sessionId'], 'pid': off['pid']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    try:
        evidence = json.loads(read_text(args.evidence))
        mode = evidence.get('mode')
        if mode == 'cap' and len(evidence.get('lanes', [])) != 1:
            raise ValueError('NOT RUN: cap lane incomplete')
        result = check_state(evidence) if mode == 'state' else check_subagents(evidence) if mode == 'subagent-wait' else check_cap(evidence['lanes'][0]) if mode == 'cap' else check(evidence)
    except (ValueError, OSError) as error:
        print(str(error))
        return 2
    print(json.dumps(result, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
