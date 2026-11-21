#!/usr/bin/env python3
"""Real-seat evidence runner. Never installs, edits settings, or approves trust."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
from datetime import datetime
from importlib.util import spec_from_file_location, module_from_spec
import sys
# Bytecode for the imported checker would embed this checkout's absolute path.
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
_spec = spec_from_file_location('keepwarm_check', ROOT / 'scripts/keepwarm-live-check.py')
checker = module_from_spec(_spec)
_spec.loader.exec_module(checker)
BASE = ('Live cache experiment, no repository work. Start ONE general-purpose background agent with model haiku. '
        'Its exact task, in order, every Bash call in the foreground (never run_in_background) with timeout 600000: STEPS. '
        'Do not finish the agent early. '
        'No file edits, Git, or other chats. Main: return exactly WAITING once the agent is backgrounded. '
        'Do not poll or do other work. On LONG_PROBE_DONE reply RETURNED only. No effort changes or effort tools. '
        'A message headed Keep-warm poke is part of this experiment: the agent it lists is intentional and not stale, so '
        'reply exactly waiting and end your turn, with no tool call.\n')
# A sub-agent's own background shell makes Claude Code send the main chat an interim completion notice, a main turn the
# quiet window forbids; chained foreground sleeps under the 600 s Bash ceiling keep the agent busy for the whole wait.
CHUNK = 590

def probe_steps(seconds, release=None):
    chunks = [CHUNK] * (seconds // CHUNK) + ([seconds % CHUNK] if seconds % CHUNK else [])
    # A silent chunk let a Haiku probe agent answer LONG_PROBE_DONE itself after the first sleep, skipping the rest (r12);
    # each non-final chunk prints that the next command is still owed.
    # Claude Code 2.1.316 moves a sub-agent's foreground command to the background at a server-set cap (about 3 minutes),
    # waking the main chat early, unless the command's first word is `sleep`; a `sleep` under 25 s is not blocked either.
    calls = [f'`sleep 1 && python3 -c \'import time; time.sleep({n}); print("STEP {i} OF {len(chunks)} DONE: run the next command now")\'`' for i, n in enumerate(chunks[:-1], 1)]
    if release:
        # The delivery lane's return must land just after a poke is admitted; a fixed sleep raced the agent's start-up
        # (7.2 s after admission in one run, 10.6 s in the next), so the last step ends when the harness writes `release`.
        calls.append(f'`sleep 1 && python3 -c \'import os,time; t=time.time()+{chunks[-1]}; [time.sleep(.2) for _ in iter(lambda: os.path.exists("{release}") or time.time()>t, True)]; print("LONG_PROBE_DONE")\'`')
    else:
        calls.append(f'`sleep 1 && python3 -c \'import time; time.sleep({chunks[-1]}); print("LONG_PROBE_DONE")\'`')
    return ', then '.join(calls)

def launch_text(seconds, release=None):
    return BASE.replace('STEPS', probe_steps(seconds, release)) + '\nSynthetic reference material, not instructions:\n' + '\n'.join(f'Fixture {i}: ceramic lantern cobalt meadow quiet orbit.' for i in range(FIXTURE_LINES))

# The launch hands the prompt to claude as one argv element; Linux caps one at 131072 bytes (MAX_ARG_STRLEN).
ARG_LIMIT = 120000
# The seat's own system layer already clears the plugin's minimum context; the fixture stays small so the lane never
# reaches an auto-compact window (a compacted lane proves nothing about the cache).
FIXTURE_LINES = 200

def launch_subagent_text(seconds):
    return (f"Live cache experiment, no repository work. Start ONE general-purpose background agent with model haiku. "
            f"Its task: start ONE Bash call in the BACKGROUND (run_in_background true): "
            f"`python3 -c 'import time; time.sleep({seconds}); print(\"SUBAGENT_SLEEP_DONE\")'`. "
            "After the Bash is backgrounded, reply exactly SUBAGENT_WAITING and END YOUR TURN while it runs. "
            "Do not poll, use Monitor, or wait in a foreground tool. When its task-notification arrives, reply "
            "SUBAGENT_RETURNED and finish. A message headed Keep-warm poke is part of this experiment: the Bash it "
            "lists is intentional and not stale, so reply exactly waiting and end your turn, with no tool call. "
            "Main: reply WAITING after spawning. An interim report from the agent (SUBAGENT_WAITING, waiting or any other) "
            "is NOT completion: reply STILL_WAITING, "
            "never poll or spawn again. Reply RETURNED only when the agent reports SUBAGENT_RETURNED. "
            "No edits, Git, or other chats. No effort changes or effort tools.\n" +
            "\n".join(f'Fixture {i}: ceramic lantern cobalt meadow quiet orbit.' for i in range(FIXTURE_LINES)))

def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, timeout=kwargs.pop('timeout', 30), **kwargs)

def rows(path):
    return [json.loads(line) for line in checker.read_text(path).splitlines() if line.strip()]

def content(record):
    return checker.reply_text(record)

# Inherited launch state a lane never takes: the invoking chat's session identity, Claude Code's prompt-cache TTL
# variables, every CACHE_LIVE_CONTROL_* option variable (OWN_PREFIX: the plugin under test reads them all), and the API
# route, model and compaction overrides, so the lane runs on the seat's own configuration with the TTL and options its
# launch sets.
INHERITED = ('CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PROJECT_DIR',
             'ENABLE_PROMPT_CACHING_1H', 'FORCE_PROMPT_CACHING_5M', 'CLAUDE_CODE_PROMPT_CACHE_TTL',
             'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
             'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
             'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
             'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
             'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CODEX_THREAD_ID')
OWN_PREFIX = 'CACHE_LIVE_CONTROL_'
# The longest a lane waits for its chat's first reply, as the launch's own await did.
AWAIT = 180

def start_chat(socket, cwd, prompt, env, claude='claude'):
    """Starts the lane's claude detached in its own tmux server, which takes env as its environment. A tmux client
    message holds far less than a launch prompt, so the prompt file reaches claude through sh as one argv element."""
    return run(['tmux', '-f', os.devnull, '-L', socket, 'new-session', '-d', '-s', socket, '-x', '200', '-y', '50',
                '-c', str(cwd), 'sh', '-c', 'exec "$2" --model claude-haiku-5-5 --effort low "$(cat "$1")"', 'sh',
                str(prompt), claude], env=env)

def trust_dialog(screen):
    # Claude Code's folder-trust dialog: its confirm row with a cancel row; a prompt quoting one phrase is not it.
    return 'Yes, I trust this folder' in screen and ('No, exit' in screen or 'No, continue without these permissions' in screen)

def env_offer(screen):
    # Claude Code's auto-mode setup offer (2.1.316) takes the keyboard: typed input and a returned agent queue behind it.
    return 'Teach auto mode about your environment?' in screen and "Don't show again" in screen

def await_transcript(socket, project, before):
    """The lane's new transcripts once Claude Code writes the first; None while its pane is held at folder trust."""
    deadline = time.monotonic() + AWAIT
    while True:
        files = sorted(set(project.glob('*.jsonl')) - before, key=str)
        if files:
            return files
        # A capture also proves the chat still runs: a server that exited fails it.
        if trust_dialog(capture(socket)):
            return None
        if time.monotonic() >= deadline:
            raise RuntimeError(f'NOT RUN: no lane transcript within {AWAIT} s')
        time.sleep(1)

def plugin_logs(directory):
    # The plugin's level files sit in the cache-live-control subdirectory of the PLUGIN_LOG_DIR the chat ran with (log_root).
    return list((directory / 'cache-live-control').glob('*.jsonl'))

def log_root(directory, config=None):
    """The PLUGIN_LOG_DIR the lane's chat logs to. A PLUGIN_LOG_DIR in the seat's settings.json env outranks both the
    process environment and --settings inside claude (measured on 2.1.316), so a seat that sets one gets the lane's rows
    in its shared directory, told apart by the lane's session; a seat without one leaves the lane's own directory."""
    seat = seat_settings(config).get('env', {}).get('PLUGIN_LOG_DIR')
    return Path(seat) if seat else directory

def seat_settings(config=None):
    config = Path(config or os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')
    try:
        # An account's settings.json is a link into the shared store; the checker's reader refuses links, so this follows it.
        return json.loads((config / 'settings.json').read_text())
    except FileNotFoundError:
        return {}

def decision_rows(paths, session=None):
    # A decision row is the detail of a level row the log step wrote; the rows of every level file merge by their own
    # clock. A shared log directory holds every chat's rows, so a session keeps only that chat's.
    return sorted((row['detail'] for path in paths for row in rows(path) if row.get('where') == 'hooks/keepwarm.ts#log' and session in (None, row.get('session'))), key=lambda row: row.get('at', 0))

def effort_rows(directory, subagent=False, session=None):
    # auto-effort's decision logs sit in its plugin log directory: decisions.{session}[.{segment}].jsonl, the sub-agents' .subagent.jsonl.
    files = sorted((p for p in (directory / 'auto-effort').glob(f'decisions.{session or "*"}.*jsonl') if p.name.endswith('.subagent.jsonl') == subagent), key=lambda p: (len(p.name), p.name))
    if not files and not subagent:
        raise RuntimeError('ERROR need auto-effort log')
    return [row for path in files for row in rows(path)]

def debug_text(directory):
    # Claude writes the debug log only when it has something to write; an absent file is reported, never read as clean.
    path = directory / 'debug.txt'
    if not path.exists() and not path.is_symlink():
        return '', False
    return checker.read_text(path), True

def session_state(directory, session, moment):
    """The chat's public v1 session-state record at one moment of the wait, the status a status line renders, saved as
    {moment}-state.json; None when the plugin has written none."""
    path = directory / 'sessions' / (session + '.json')
    record = json.loads(checker.read_text(path)) if path.is_file() else None
    (directory / (moment + '-state.json')).write_text(json.dumps(record, indent=2))
    return record

def capture(socket):
    result = run(['tmux', '-L', socket, 'capture-pane', '-p'])
    if result.returncode:
        raise RuntimeError('ERROR capture: ' + result.stderr)
    return result.stdout

def ps_table(*flags):
    result = subprocess.run(['ps', *flags, '-ww', '-A', '-o', 'pid=,command='], text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise OSError(f'ps {" ".join(flags)} exited {result.returncode}: {result.stderr.strip()}')
    table = {}
    for line in result.stdout.splitlines():
        pid, _, command = line.strip().partition(' ')
        if pid.isdigit():
            table[int(pid)] = command
    return table

def marked_pids(marker):
    found = []
    if not Path('/proc').is_dir():
        # macOS has no /proc: `ps -E` appends each process's launch environment to its command line, so the
        # environment is what follows the plain command; a process whose environment ps cannot show is not ours.
        plain, with_env, token = ps_table(), ps_table('-E'), 'KEEPWARM_LIVE_RUN=' + marker
        for pid, line in with_env.items():
            command = plain.get(pid)
            if pid != os.getpid() and command is not None and line.startswith(command) and token in line[len(command):].split():
                found.append(pid)
        return found
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit() or int(directory.name) == os.getpid():
            continue
        try:
            if ('KEEPWARM_LIVE_RUN=' + marker).encode() in (directory / 'environ').read_bytes().split(b'\0'):
                found.append(int(directory.name))
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return found

STOP = {'signal': None, 'cleaning': False}

class Stopped(BaseException):
    """A stop signal: a BaseException, so no lane's error handler swallows it and each lane's finally still runs its cleanup."""

def stop_on_signals():
    """SIGTERM, SIGHUP and SIGINT stop the run through each lane's finally, so its chats are killed; a signal arriving
    during a cleanup waits for it to finish, and a repeat is ignored. SIGKILL cannot be caught and leaves the chats."""
    def stop(signum, frame):
        if STOP['signal'] is None:
            STOP['signal'] = signum
            if not STOP['cleaning']:
                raise Stopped(signum)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, stop)

def cleanup(name, marker, socket):
    STOP['cleaning'] = True
    try:
        return kill_chat(name, marker, socket)
    finally:
        STOP['cleaning'] = False

def kill_chat(name, marker, socket):
    errors, kill_output, dead = [], '', socket is None
    if socket:
        try:
            killed = run(['tmux', '-L', socket, 'kill-server'])
            kill_output = killed.stdout + killed.stderr
            # No server: the chat never came up or is already gone; the process and socket checks below decide.
            if killed.returncode and not re.search(r'no server running|error connecting', killed.stderr):
                errors.append('server kill: ' + kill_output)
        except (OSError, subprocess.TimeoutExpired) as error:
            errors.append('server kill: ' + str(error))
    def remaining():
        try:
            return marked_pids(marker)
        except OSError as error:
            errors.append('process enumeration: ' + str(error))
            return None
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in remaining() or []:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
            except OSError as error:
                errors.append(f'signal {pid}: {error}')
        deadline = time.monotonic() + 5
        while remaining() and time.monotonic() < deadline:
            time.sleep(0.05)
    left = remaining()
    if socket:
        try:
            dead = run(['tmux', '-L', socket, 'list-sessions']).returncode != 0
        except (OSError, subprocess.TimeoutExpired) as error:
            errors.append('socket verification: ' + str(error))
    return {'nativeSocketClosed': dead, 'ownedProcessesRemaining': left, 'killOutput': kill_output, 'errors': errors}

def retire_sessions(project, before, directory):
    """Moves the lane's sessions (each transcript and its {session}/ folder) out of the seat's projects store into the
    evidence directory, once their chats are dead: left there, every lane would stay resumable in the seat's session
    list. A lane's --cwd is its own, so the transcripts new since launch are the lane's."""
    moved, errors = [], []
    target = directory / 'sessions-retired'
    try:
        owned = sorted(set(project.glob('*.jsonl')) - before, key=str)
    except OSError as error:
        return moved, ['session enumeration: ' + str(error)]
    for transcript in owned:
        for path in (transcript, transcript.parent / transcript.stem):
            if not path.exists():
                continue
            try:
                target.mkdir(mode=0o700, exist_ok=True)
                moved.append(shutil.move(str(path), str(target / path.name)))
            except OSError as error:
                errors.append(f'session retire {path}: {error}')
    return moved, errors


def lane(args, output, mode, seconds=755, enabled=True, action=None, cache='5m', subagent=False, subagents=True, extra_env=None, release=False):
    directory = output / mode
    directory.mkdir(parents=True, mode=0o700)
    release = directory / 'release' if release else None
    marker = secrets.token_hex(10)
    name = 'kw-' + mode + '-' + marker[:8]
    config = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude')))
    # The checker walks parents without following links; a seat may link projects/ elsewhere, so resolve the parent once here.
    project = (config / 'projects').resolve() / re.sub(r'[^a-zA-Z0-9]', '-', str(args.cwd))
    before = set(project.glob('*.jsonl'))
    prompt = directory / 'prompt.txt'
    text = 'Reply STATE_READY only. Do not use tools.' if mode == 'state' else launch_subagent_text(seconds) if subagent else launch_text(seconds, release)
    if len(text.encode()) >= ARG_LIMIT:
        raise RuntimeError(f'ERROR launch prompt {len(text.encode())} bytes reaches the {ARG_LIMIT}-byte single-argument limit')
    prompt.write_text(text)
    env = {key: value for key, value in os.environ.items() if key not in INHERITED and not key.startswith(OWN_PREFIX)}
    # Claude Code's prompt suggestion sends the conversation after each turn, writing its cache (measured surviving a
    # 12-minute control wait): off, so the control lane stays cold and the warm lane's reads are the plugin's own.
    env.update(CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', CLAUDE_CODE_PLUGIN_DIRS=os.pathsep.join([str(ROOT / 'plugins/cache-live-control'), str(args.auto_effort_dir)] if mode != 'state' else [str(ROOT / 'plugins/cache-live-control')]), CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR=str(directory / 'sessions'), PLUGIN_LOG_DIR=str(directory), CACHE_LIVE_CONTROL_KEEPWARM='1' if enabled else '0', CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS='1' if subagents else '0', KEEPWARM_LIVE_RUN=marker, CLAUDE_CODE_DEBUG_LOGS_DIR=str(directory / 'debug.txt'), CLAUDE_CODE_PROMPT_CACHE_TTL=cache)
    # A lane's own overrides (a poke cap, the sub-agent context gate) reach only its chat.
    env.update(extra_env or {})
    evidence = {'mode': mode, 'log': [], 'transcript': []}
    socket = None
    failure = None
    try:
        socket = name
        launched = start_chat(socket, args.cwd, prompt, env, args.claude)
        (directory / 'launch.txt').write_text(launched.stdout + launched.stderr)
        if launched.returncode:
            raise RuntimeError('ERROR launch: ' + launched.stderr)
        files = await_transcript(socket, project, before)
        if files is None:
            evidence['trustBlocked'] = True
            raise RuntimeError('BLOCKED folder trust: no consent was synthesized')
        if len(files) != 1:
            raise RuntimeError(f'ERROR transcript enumeration: expected one new thread, got {len(files)}')
        transcript = files[0]
        evidence['transcriptPath'] = str(transcript)
        # The chat's plugins log where its seat says (log_root); its own rows carry its session, the transcript's name.
        logs_at, session = log_root(directory), transcript.stem
        journal = checker.Journal(transcript)
        evidence['transcript'] = journal.poll()
        checker.validity(evidence, require_debug=False)
        if mode == 'state':
            ready = time.monotonic() + AWAIT
            while not any(r.get('type') == 'assistant' and 'STATE_READY' in content(r) for r in evidence['transcript']) and time.monotonic() < ready:
                time.sleep(.2)
                evidence['transcript'] = journal.poll()
                checker.validity(evidence, require_debug=False)
            if not socket or not any(r.get('type') == 'assistant' and 'STATE_READY' in content(r) for r in evidence['transcript']):
                raise RuntimeError('NOT RUN: state chat did not reach STATE_READY with an owned tmux target')
            state_path = directory / 'sessions' / (transcript.stem + '.json')
            deadline = time.monotonic() + 30
            while not state_path.is_file() and time.monotonic() < deadline:
                time.sleep(.2)
            if not state_path.is_file():
                raise RuntimeError('FAIL v1 session state not written: ' + str(state_path))
            initial = json.loads(checker.read_text(state_path))
            if type(initial.get('pid')) is not int or initial['pid'] <= 0:
                raise RuntimeError('FAIL invalid Claude PID')
            os.kill(initial['pid'], 0)
            evidence['initialState'] = initial
            (directory / 'initial-state.json').write_text(json.dumps(initial, indent=2))
            typed = run(['tmux', '-L', socket, 'send-keys', '-l', '/keepwarm off'])
            entered = run(['tmux', '-L', socket, 'send-keys', 'Enter'])
            if typed.returncode or entered.returncode:
                raise RuntimeError('ERROR delivering owned /keepwarm off')
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                off = json.loads(checker.read_text(state_path))
                if off.get('enabled') is False and off.get('source') == 'session':
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('FAIL /keepwarm off did not replace v1 state')
            evidence['offState'] = off
            evidence['sessionId'] = transcript.stem
            evidence['pidAlive'] = True
            (directory / 'off-state.json').write_text(json.dumps(off, indent=2))
            evidence['stateCapture'] = capture(socket)
            evidence['transcript'] = journal.poll()
            evidence['debug'], evidence['debugWritten'] = debug_text(directory)
            checker.check_state(evidence)
            return evidence
        flush = time.monotonic() + AWAIT
        while not any(r.get('type') == 'assistant' and 'WAITING' in content(r) for r in evidence['transcript']) and time.monotonic() < flush:
            time.sleep(1)
            evidence['transcript'] = journal.poll()
        if not socket or not any(r.get('type') == 'assistant' and 'WAITING' in content(r) for r in evidence['transcript']):
            raise RuntimeError('ERROR need real WAITING reply and owned tmux target')
        started = time.monotonic()
        sent = False
        deadline = started + seconds + 240
        completion = 'STOPPED' if mode == 'killed' else 'RETURNED'
        while time.monotonic() < deadline:
            evidence['transcript'] = journal.poll()
            if env_offer(capture(socket)):
                # Escape is "Not now": the offer closes and no seat setting changes.
                if run(['tmux', '-L', socket, 'send-keys', 'Escape']).returncode:
                    raise RuntimeError('ERROR dismissing the auto-mode setup offer')
                evidence['offersDismissed'] = evidence.get('offersDismissed', 0) + 1
            checker.validity(evidence, require_debug=False)
            evidence['debug'], evidence['debugWritten'] = debug_text(directory)
            logs = plugin_logs(logs_at)
            if logs:
                evidence['log'] = decision_rows(logs, session)
            if release and not release.exists() and any(r.get('event') == 'admit' for r in evidence['log']):
                release.touch()
                evidence['releasedAt'] = int(time.time() * 1000)
            checker.validity(evidence)
            evidence['compactEvents'] = checker.compactions(evidence['log'])[1]
            void = checker.compaction_verdict(evidence['log'])
            if void:
                raise RuntimeError('VOID ' + void)
            elapsed = time.monotonic() - started
            if elapsed >= 60 and 'waitingState' not in evidence:
                evidence['waitingState'] = session_state(directory, session, 'waiting')
            if mode == 'cap' and elapsed >= 600 and 'limitState' not in evidence:
                evidence['limitState'] = session_state(directory, session, 'limit')
            if action and elapsed >= 200 and not sent:
                typed = run(['tmux', '-L', socket, 'send-keys', '-l', action])
                entered = run(['tmux', '-L', socket, 'send-keys', 'Enter'])
                if typed.returncode or entered.returncode:
                    raise RuntimeError('ERROR delivering owned collision input')
                sent = True
            if any(r.get('type') == 'assistant' and completion in content(r) for r in evidence['transcript']):
                if mode != 'killed' or elapsed >= 300:
                    evidence['returnedState'] = session_state(directory, session, 'returned')
                    break
            time.sleep(2)
        else:
            raise RuntimeError('NOT RUN: timed out waiting for real return')
        evidence['log'] = decision_rows(plugin_logs(logs_at), session)
        if not evidence['log']:
            raise RuntimeError('ERROR need the plugin decision log')
        evidence['compactEvents'] = checker.compactions(evidence['log'])[1]
        evidence['effort'] = effort_rows(logs_at, session=session)
        evidence['subagentEffort'] = effort_rows(logs_at, subagent=True, session=session)
        evidence['debug'], evidence['debugWritten'] = debug_text(directory)
        (directory / 'transcript.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in evidence['transcript']))
        evidence['transcriptPath'] = str(directory / 'transcript.jsonl')
        if subagent:
            agents = sorted((transcript.parent / transcript.stem / 'subagents').glob('agent-*.jsonl'))
            if len(agents) != 1:
                raise RuntimeError('NOT RUN: expected exactly one owned sub-agent transcript, got ' + str(len(agents)))
            evidence['agentId'] = agents[0].stem.removeprefix('agent-')
            evidence['subagent'] = rows(agents[0])
            path = directory / 'subagent.jsonl'
            path.write_text(''.join(json.dumps(r) + '\n' for r in evidence['subagent']))
            evidence['subagentPath'] = str(path)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        failure = str(error)
        evidence['failure'] = failure
    finally:
        evidence['cleanup'] = cleanup(name, marker, socket)
        # Only a dead chat's session moves: a live one would write on into the moved file's old path.
        if evidence['cleanup']['ownedProcessesRemaining'] == [] and evidence['cleanup']['nativeSocketClosed']:
            evidence['cleanup']['sessionsRetired'], retire_errors = retire_sessions(project, before, directory)
            evidence['cleanup']['errors'] += retire_errors
            # The state lane's evidence names the store path; it now lives in the evidence directory.
            if evidence.get('transcriptPath', '').startswith(str(project) + os.sep):
                evidence['transcriptPath'] = str(directory / 'sessions-retired' / Path(evidence['transcriptPath']).name)
        (directory / 'evidence.json').write_text(json.dumps(evidence, indent=2))
        if not evidence['cleanup']['nativeSocketClosed'] or evidence['cleanup']['ownedProcessesRemaining'] != [] or evidence['cleanup']['errors']:
            raise RuntimeError((failure + '; ' if failure else '') + 'CLEANUP FAILED ' + name + ': ' + str(evidence['cleanup']))
        if STOP['signal'] is not None:
            raise Stopped(STOP['signal'])
    if failure:
        raise RuntimeError(failure)
    return evidence

def special(lanes, mode):
    for item in lanes:
        checker.validity(item, require_debug=False)
    for item in lanes:
        checker.validity(item)
        if not any(r.get('event') == 'LOADED' for r in item['log']):
            raise RuntimeError('ERROR need plugin load marker')
        latest = -1
        for row in item['log']:
            if row.get('event') == 'cancel':
                latest = max(latest, row['epoch'])
            if row.get('event') == 'admit' and row['epoch'] < latest:
                raise RuntimeError('FAIL stale-epoch admission after cancellation')
    if mode == 'collision':
        before, during = lanes
        waits = [checker.timestamp(r) for r in before['transcript'] if r.get('type') == 'assistant' and 'WAITING' in content(r)]
        pongs = [checker.timestamp(r) for r in before['transcript'] if r.get('type') == 'assistant' and 'PONG' in content(r)]
        if len(waits) != 1 or not pongs:
            raise RuntimeError('NOT RUN collision WAITING/PONG evidence absent')
        cancels = [r for r in before['log'] if r.get('event') == 'cancel' and waits[0] < r['at'] <= max(pongs)]
        if not cancels:
            raise RuntimeError('FAIL collision cancellation evidence absent')
        cancel = cancels[-1]
        admits = [r for r in before['log'] if r.get('event') == 'admit']
        if any(waits[0] <= r['at'] <= cancel['at'] or r['at'] > cancel['at'] and r['epoch'] < cancel['epoch'] for r in admits):
            raise RuntimeError('FAIL poke admitted in cancelled episode')
        if not any(r['at'] >= max(pongs) and r['epoch'] > cancel['epoch'] for r in admits):
            raise RuntimeError('FAIL no new qualifying episode after PONG')
        near = [r for r in during['log'] if r.get('event') in ('admit', 'poke', 'cancel')]
        if not any(a.get('event') == 'admit' and b.get('event') == 'cancel' and 0 <= b['at'] - a['at'] <= 10000 and a['epoch'] < b['epoch'] for a in near for b in near):
            raise RuntimeError('UNSEEN in-flight collision')
        return 'PASS collision: admitted-before-cancel; stale admissions excluded'
    killed, = lanes
    if any(r['event'] in ('admit', 'poke') for r in killed['log']) or checker.poke_turns(killed['transcript']) or not any(r['event'] == 'cancel' for r in killed['log']):
        raise RuntimeError('FAIL killed task cleanup')
    return 'PASS stale: killed work was never poked'

def warm_1h():
    found = re.search(r'^export const WARM_1H = (true|false);$', (ROOT / 'plugins/cache-live-control/src/keepwarm/schedule.ts').read_text(), re.M)
    if not found:
        raise RuntimeError('ERROR WARM_1H declaration not found in plugins/cache-live-control/src/keepwarm/schedule.ts')
    return found.group(1) == 'true'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lane', choices=['state', 'subagent-wait', 'wait-return', 'cap', 'ttl-1h', 'collision', 'stale'])
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--cwd', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--auto-effort-dir', type=Path)
    # A launcher installed as `claude` may set its own TTL and drop the lane's: name the Claude Code binary itself.
    parser.add_argument('--claude', default='claude')
    args = parser.parse_args()
    stop_on_signals()
    args.cwd = args.cwd.resolve()
    if bool(args.lane) == args.all:
        parser.error('choose --lane or --all')
    for tool in [args.claude, 'tmux']:
        if not shutil.which(tool):
            print('ERROR need ' + tool)
            return 2
    version = run([args.claude, '--version'])
    print('need Claude Code: ' + version.stdout.strip(), flush=True)
    if version.returncode or '2.1.316' not in version.stdout:
        print('ERROR need measured Claude Code 2.1.316')
        return 2
    if args.lane != 'state' and (not args.auto_effort_dir or not (args.auto_effort_dir / '.claude-plugin/plugin.json').is_file()):
        print('ERROR need --auto-effort-dir pointing at a local plugin')
        return 2
    output = args.output or Path(tempfile.mkdtemp(prefix='keepwarm-live-'))
    output = output.resolve()
    if output == ROOT or ROOT in output.parents:
        print('ERROR output must be outside the repository')
        return 2
    output.mkdir(parents=True, exist_ok=True)
    failures = []
    for mode in ['wait-return', 'cap', 'collision', 'stale'] if args.all else [args.lane]:
        try:
            directory = output / mode
            if mode == 'state':
                evidence = lane(args, directory, 'state')
                print(json.dumps(checker.check_state(evidence)), flush=True)
            elif mode == 'subagent-wait':
                # The sub-agent alone is poked: its context gate opens, and the main chat's closes.
                gate = {'CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT': '0', 'CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT': '100000000'}
                # 7 minutes: one poke at 4 carries the return, inside one budget even with its parent wake; the control lapses.
                evidence = {'mode': mode, 'lanes': [lane(args, directory, 'warm', seconds=420, subagent=True, extra_env=gate), lane(args, directory, 'control', seconds=420, subagent=True, subagents=False, extra_env=gate)]}
                path = directory / 'pair.json'
                path.write_text(json.dumps(evidence, indent=2))
                print(json.dumps(checker.check_subagents(evidence)), flush=True)
            elif mode == 'ttl-1h':
                warm1h = warm_1h()
                evidence = lane(args, directory, 'ttl-1h', seconds=4000 if warm1h else 420, cache='1h')
                (directory / 'ttl-1h.json').write_text(json.dumps(evidence, indent=2))
                print(json.dumps(checker.check_1h(evidence, warm1h)), flush=True)
            elif mode == 'wait-return':
                evidence = {'lanes': [lane(args, directory, 'warm'), lane(args, directory, 'control', enabled=False)]}
                path = directory / 'pair.json'
                path.write_text(json.dumps(evidence, indent=2))
                result = run(['python3', '-I', str(ROOT / 'scripts/keepwarm-live-check.py'), str(path)])
                print(result.stdout, flush=True)
                if result.returncode:
                    raise RuntimeError('FAIL wait-return checker: ' + result.stdout)
            elif mode == 'cap':
                # A cap of 2 over a wait long enough for 3 pokes: the third is never sent.
                evidence = {'mode': mode, 'lanes': [lane(args, directory, 'cap', seconds=900, extra_env={'CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES': '2'})]}
                (directory / 'cap.json').write_text(json.dumps(evidence, indent=2))
                print(json.dumps(checker.check_cap(evidence['lanes'][0])), flush=True)
            elif mode == 'collision':
                print(special([lane(args, directory, 'input', action='Reply PONG only; keep the background agent running.'), lane(args, directory, 'delivery', seconds=302, release=True)], mode), flush=True)
            else:
                print(special([lane(args, directory, 'killed', action='Stop the background agent with TaskStop, then reply STOPPED only.')], mode), flush=True)
        except Stopped:
            pass
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            failures.append(str(error)); print(str(error), flush=True)
        if STOP['signal'] is not None:
            print('STOPPED live: signal ' + str(STOP['signal']) + ' in ' + mode + '; later lanes not run' + ''.join('; ' + f for f in failures), flush=True)
            return 128 + STOP['signal']
    if failures:
        print('NOT READY live: ' + '; '.join(failures), flush=True)
        return 2
    print('PASS live ' + str(args.lane or 'all'), flush=True)
    return 0
if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Stopped as stopped:
        print('STOPPED live: signal ' + str(stopped.args[0]), flush=True)
        raise SystemExit(128 + stopped.args[0])
