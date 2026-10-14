<div align="center">

# cache-live-control

**Change the prompt-cache TTL of one Claude Code chat, instantly, with no model turn: `/cache 5m`, `/cache main 1h`, `/cache 1h agents`, words in any order, for the main chat, its sub-agents or both, with a one-line warning when a switch touches a warm cache.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.6.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-234%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
/cache                →  cache-live-control: main 1h (set at launch, warm 41m) · agents automatic (5m, unless subagentPromptCacheTtl or the agent's frontmatter sets it, cold) · auto-raise off · resume-guard off · summaries on
/cache 1h agents      →  cache-live-control: main 1h · agents 1h
/cache main 5m        →  cache-live-control: switched; main's cache was warm (41m left), the next request may rewrite it: main 5m · agents 1h
/cache auto main      →  cache-live-control: main automatic · agents 1h
```

---

Claude Code caches the prompt for 5 minutes or for 1 hour. A 1-hour write
costs more than a 5-minute one, and pays off only when the next request
comes after the 5 minutes are up: a chat you step away from, a sub-agent
that runs long. Claude Code picks the TTL for the whole process, from
environment variables and settings read at launch.

**cache-live-control** lets you change it for this chat, while it runs.

- ⚡ **Instant.** The TTL changes at the next request, even mid-turn: the
  command runs at once while a turn streams.
- 🤫 **No model turn.** `/cache` prints one line and never reaches the
  model, so it costs nothing.
- 🎯 **Main chat and sub-agents apart, words in any order.** `/cache main 1h`,
  `/cache 1h main` and `/cache main 1h agents 5m` all read; `/cache 5m` sets both.
- 🔥 **Warns when it touches a warm cache.** A new TTL may make the next
  request write the whole cache again, so a switch of a party whose cache is
  still warm applies at once and says so in its reply.
- 🛡️ **Sub-agents stay 5m by default.** `ENABLE_PROMPT_CACHING_1H=1` at
  launch turns 1h on for every sub-agent too; the plugin keeps that 1h for
  the main chat only, so a sub-agent runs 5m unless its own frontmatter,
  `subagentPromptCacheTtl` or `/cache agents 1h` says otherwise.
- 🧊 **Sub-agent cache protection, all opt-in.** A sub-agent whose cache
  expired re-writes its whole context at its next request. The plugin
  [warns or blocks](#-sub-agent-cache-protection) a `SendMessage` to a cold, large sub-agent
  (naming the cost in tokens). Every threshold is set live:
  `/cache guard block`. Nothing raises a sub-agent's TTL on its own.
- 🔇 **Sub-agent progress summaries, opt-in.** While a sub-agent runs, Claude
  Code asks its model, about every 30 s over the agent's whole conversation,
  for a 3-5 word status line. `/cache summaries off` marks every request so a
  [gateway that honours the mark](#sub-agent-progress-summaries) answers that
  request itself; fork mode and background sub-agents are untouched.
- 🧭 **Status with sources.** `/cache` alone shows each TTL, where it
  comes from and whether its cache is warm, and warns when `FORCE_PROMPT_CACHING_5M` overrides everything.
- 🔒 **This chat only.** Nothing is written to a settings file; another chat,
  or the next session, is untouched.

## 🚀 Quick start

```sh
# 1. Turn on function hooks
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

# 2. Install
claude plugin marketplace add rezzminator/cache-live-control
claude plugin install cache-live-control@cache-live-control
```

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` also works in the `env` block of
`settings.json`. Then type `/cache` in any chat.

> **Early access.** This plugin is built on Claude Code's function hooks,
> an early-access surface that may change between releases. It is tested on
> Claude Code 2.1.283.

## 🧭 Commands

`/cache` takes words in any order: parties (`main`; `agents`, also `agent`,
`subagents`, `sub-agents`; `both` or `all`) and TTLs (`5m`, `1h`, `auto`).
Commas count as spaces.

| Command | Main chat | Sub-agents |
| --- | --- | --- |
| `/cache` | shown | shown |
| `/cache 5m` / `/cache 1h` | set | set |
| `/cache auto` | automatic | automatic |
| `/cache main 1h` / `/cache 1h main` | set | unchanged |
| `/cache agents 5m` / `/cache 5m sub-agents` | unchanged | set |
| `/cache main agents 1h` / `/cache 1h all` | set | set |
| `/cache main 1h agents 5m` / `/cache 1h main 5m agents` / `/cache main 1h, agents 5m` | 1h | 5m |

How words group: a group is some parties and one TTL. A group that starts
with a party runs to its TTL (`main 1h`); one that starts with a TTL takes
the parties after it, up to the next TTL (`1h main agents`). A lone TTL
with no party sets both. A party with no TTL (`/cache main`), two TTLs
with nothing between them (`/cache 1h 5m`), a party given two TTLs
(`/cache main 1h main 5m`), a TTL left with no party beside another group
(`/cache 1h main agents 5m`) or an unknown word prints one
`nothing changed: …` line with the usage, and changes nothing.

"Sub-agents" covers everything Claude Code does not run as the main chat:
sub-agents, workflows, and background helper requests.

### Settings words

Setting words change a threshold for the rest of the chat, with no config
edit. They are lifted out first, key first, and mix with TTL groups in any
order (`/cache main 5m raise 2 guard block`, `/cache guard floor 80k agents 1h`).
A value that does not read prints one `nothing changed: …` line with the
usage, and changes nothing. A party word that keys a setting (`main raise`)
is no party of a TTL beside it, so a TTL left without its own party is
refused rather than widened to both: `/cache 1h main raise 2` changes
nothing and asks for `/cache main 1h main raise 2`.
The reply names the pieces the command touched; a TTL write that fails still
applies the settings beside it, and the reply says both.

| Command | Sets | Option |
| --- | --- | --- |
| `/cache raise N` / `raise off` (also `main raise …`) | the main chat's auto-raise: expired wakes before main goes to 1h | `raiseAfterExpiries` |
| `/cache guard off` / `warn` / `block` | the cold-resume guard | `resumeGuard` |
| `/cache guard floor N` (`60000`, `60k`, `1.5k`) | the context below which a cold resume passes | `resumeGuardMinTokens` |
| `/cache guard price N` / `price off` | USD per million base input tokens, to show dollars | `resumeGuardPrice` |
| `/cache summaries off` / `on` | stop the sub-agent progress summaries (needs a gateway, [below](#sub-agent-progress-summaries)) / keep Claude Code's | `summaries` (`block` / `allow`) |

Each word replaces the option's value for this chat; the option stays what
starts the next one, and a plugin reload starts again from the options
(with `summaries` at `block`, a reload puts the mark back after a typed `on`).

## 🔥 Warm-cache warning

The TTL is part of every request's `cache_control` (Claude Code 2.1.285
tracks a `cacheControlHash` per request to detect cache breaks), so a new
TTL can make the next request write the cached prefix again at the new TTL.
Measured with `npm run live` on Claude Code 2.1.285 (Haiku, a subscription),
the first request after a switch mostly still read the whole prefix: 1h to
5m read about 33,000 tokens and wrote only the new turn, in all three runs;
5m to 1h read it in two runs and, in the first, read nothing and rewrote
33,055 tokens at 1h. Across the proof runs, 11 of 12 warm switches kept the
cache (the next request still read about 33,000 tokens); the one rewrite was
that first 5m-to-1h raise, and it did not repeat.

The plugin notes each party's latest model request: when, and the TTL its
variable held. A party is **warm** until that request's time plus its TTL.
An automatic TTL counts as 1h for the main chat (the subscription default;
the plugin cannot see your plan, so it assumes the longer lifetime and says
"may") and as 5m for sub-agents (row 6 below, measured).

A switch always applies at once. When it changed the TTL of a warm party,
the reply says so in one line:

```text
switched; main's cache was warm (41m left), the next request may rewrite it: main 5m · agents automatic
switched; main's (41m left) and agents' (3m left) caches were warm, the next request may rewrite them: main 5m · agents 1h
```

It reads `may have been warm` when the TTL is assumed (an automatic main
chat) or the new value is `auto`, and `under a minute left` for the last
minute. No warning when the party is cold, when the variable already holds
the value, or when the new TTL is the one the warm cache was written at.
Mid-turn, Claude Code draws a command's reply only once the turn ends, so
the warning also shows at once as a toast.

`/cache` warns rather than asks because the cache is usually kept, and a
question would stop `/cache` working where it matters most: mid-turn, while
a turn streams, and under another dialog.

## 🧠 How it works

Claude Code decides the TTL of every request in one place, reading its
environment afresh each time. The first source that is set wins:

| # | Source | Main chat | Sub-agents |
| --- | --- | --- | --- |
| 1 | `FORCE_PROMPT_CACHING_5M` | 5m | 5m |
| 2 | Environment variable, `5m` or `1h` | `CLAUDE_CODE_PROMPT_CACHE_TTL` | `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` |
| 3 | Setting | `promptCacheTtl` | `subagentPromptCacheTtl` |
| 4 | Agent frontmatter `experimental: { cacheTtl }` | the agent's | the agent's |
| 5 | `ENABLE_PROMPT_CACHING_1H` | 1h | 1h, but never with this plugin: see below |
| 6 | Automatic | 1h on a subscription within its limits; 5m on an API key, Bedrock, Vertex or Foundry | 5m (Claude Code's own `subagentPromptCacheTtl` description: "5 minutes unless ENABLE_PROMPT_CACHING_1H=1"), measured on a subscription with Claude Code 2.1.283 |

At session start the plugin takes row 5 away from the sub-agents: when
`ENABLE_PROMPT_CACHING_1H` is set, it sets `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`
(unless that is already set) and unsets `ENABLE_PROMPT_CACHING_1H`. The main
chat keeps the 1h the launch asked for; a sub-agent falls to rows 3, 4 and 6,
so it runs 5m unless a setting or its own frontmatter raises it. `/cache main
auto` returns the main chat to that launch 1h. The variable is unset in the
whole process, so a program the chat starts afterwards no longer inherits it.

`/cache` sets or unsets the variables of row 2 in this Claude Code process,
so it beats every setting and frontmatter below it, and `/cache auto` hands
the choice back to them. Row 1 beats the plugin: when
`FORCE_PROMPT_CACHING_5M` is set, every line `/cache` prints says so.

A setting changed mid-session does not reach a running chat: Claude Code
does not re-read a `--settings` file, and `.claude/settings.local.json`
applies to every chat in that directory. A variable set from inside the
process is the one per-chat switch.

> **Cost on overage.** Claude Code ignores a 1-hour `cacheTtl` in agent
> frontmatter while you are on overage, but it honours a variable: a `1h`
> set with `/cache` stays 1h on overage, and every 1-hour cache write bills
> above a 5-minute one. Use `/cache auto` to hand the choice back.

## ⚙️ Configuration

Set these through `/config`, or under
`pluginConfigs["cache-live-control@cache-live-control"].options` in
`settings.json`. The key must be the full plugin id: Claude Code silently
ignores options under any other key.

| Option | Default | Meaning |
| --- | --- | --- |
| `mainTtl` | empty | The main chat's TTL at session start: `5m`, `1h`, or empty to leave it automatic. |
| `subagentTtl` | empty | The sub-agents' TTL at session start, the same way. |
| `ttlNotice` | `false` | Tell the main chat's model which TTL it runs on, and how to delegate on it (below). |
| `raiseAfterExpiries` | empty (off) | A whole number of 1 or more: on a main chat at 5m, the Nth wake-up to an expired cache goes out at 1h, and main stays 1h (below). |
| `resumeGuard` | empty (off) | `off`, `warn` or `block`: what to do with a `SendMessage` to a cold, large sub-agent ([below](#-sub-agent-cache-protection)). |
| `resumeGuardMinTokens` | `60000` | The context, in tokens (`60000` or `60k`), below which a cold resume passes: it costs about what a fresh agent does. |
| `resumeGuardPrice` | empty | USD per million base input tokens. Set it to see dollars beside the tokens; the plugin owns no price table. |
| `summaries` | empty (allow) | `block`, `allow` or empty: `block` starts the session with the sub-agent progress summaries stopped ([below](#sub-agent-progress-summaries)); empty or `allow` keeps Claude Code's behaviour. |

An option applies once, when the session starts, and never over a variable
already set at launch (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h claude` keeps 1h)
or a launcher's handoff (below). A bad value is ignored, and `/cache` names it.

`ttlNotice` (opt-in, off by default) puts a short note beside the main chat's
prompt, which the model reads and you never see: on the first prompt, and on
the first one after the main TTL changes or the chat compacts or `/clear`s.
Sub-agents never get it. The note is an order with a threshold:

- **1h**: delegate any task past about 30 tool calls to a sub-agent and wait
  for its return; waiting is free on a 1-hour cache, and every token the chat
  writes costs 2× the base input price (1.25× at 5m).
- **5m**: work directly, delegate only work that cannot fit in the chat, and
  keep every wait under 4 minutes; a longer one expires the cache and the next
  request writes the whole context again.

An automatic main chat is assumed 1h, the subscription default (an API-key
plan runs 5m); `FORCE_PROMPT_CACHING_5M` makes it 5m;
a main variable Claude Code does not take gets no note.

With `raiseAfterExpiries` set, the note stays true: a wake that raises main to
1h is weighed before the note is built, so the note on that same prompt names 1 hour,
the TTL the request goes out at. A wake with no prompt of yours carries the note
only when the wake passes through the prompt hook: a background task's or
sub-agent's return does, and its note names the TTL the request goes out at. A
wake the plugin itself injects (a self-inject by a hook or tool) fires no prompt
hook, and no other hook can add context to it, so that turn gets no note; the raise
still happens, and the next prompt you type carries the 1h note.

### Auto-raise

`raiseAfterExpiries` (off by default; the author runs it at `2`) turns a 5m
chat into a 1h chat once it has shown that it sleeps past its cache. An
**expired wake** is a main chat turn that starts when main's previous request
went out at 5m and is now 5 minutes old or more: the cache that request wrote is
gone, and the new turn pays to write the whole context again. The plugin counts
them per session; when the count reaches the option's value, that turn's
request goes out at 1h (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, set before the request
is sent), and main stays at 1h for the rest of the session. The wake that
raises writes its cache at 1h at once: the first expired wake of `2` writes at
5m, the second writes at 1h.

- Only the main chat: the sub-agents' variable is never touched, and sub-agent
  requests are never counted.
- A main chat already at 1h, or automatic (assumed 1h), counts nothing and
  changes nothing. With `FORCE_PROMPT_CACHING_5M` set, Claude Code takes no
  1h, so the plugin does nothing and `/cache` says so.
- It raises a 5m main whatever set it: the option `mainTtl`, a variable set
  at launch, a launcher's handoff or another plugin. Only `/cache main 5m`
  typed in the session keeps a 5m from it.
- A wake is a turn that starts from an idle chat: a prompt you type, a
  background task's or sub-agent's return, a self-inject. A prompt queued into a
  turn that is already running is no wake.
- An explicit `/cache` that sets main (`/cache main …`, `/cache 1h`, …)
  resets the count. `/cache main 5m` (or `/cache 5m`) also switches the
  auto-raise off for the rest of the session: it never overrides what you typed. A
  `/cache` that sets only the agents leaves the count alone.
- `/clear` and a resumed session start the count again, but the variable outlives
  them: a typed `/cache main 5m` still keeps the raise off, and a raise that fired
  stands. A compaction or a `/clear` does not count the first wake after it: its request carries
  a new prefix, so its cache miss is not an expiry.
- If the write to the 1h variable fails, `/cache` says `failed, the TTL may be
  unchanged`, the request goes out at whatever the variable held, and the next
  expired wake tries again.
- Limits: a request in the middle of a turn after a tool wait of more than 5
  minutes is not a wake (a turn starting is), so it is not counted; a plugin
  reload resets the count and the raise.
- A wake that has a prompt is weighed once, when the prompt is submitted, and that
  verdict is final for the turn the prompt starts: the note and the request cannot
  disagree, even when the 5 minutes run out between the prompt and its turn. A
  prompt whose weighing could not read the clock or the environment, or that did
  not enter (a hook blocked it), decides nothing: the next turn is weighed when it
  starts.
- A failure shows in `/cache` until what failed works again: a failed write, or a
  failed read of the clock or the environment, as `failed, the TTL may be
  unchanged`; a failed restart of the count after a compaction or `/clear` as
  `failed` alone, since it never touches the TTL. One failure, or its recovery,
  never hides another. Once the raise fired or `/cache main 5m` switched it off, a
  failed count restart changes nothing, so `/cache` does not show it.
- Not proven on a live Claude Code: a `/cache main …`, a compaction or a `/clear`
  in the very moment the raise writes 1h. The plugin keeps a typed word (the raise
  then claims nothing, and `/cache` names the typed one); a compaction or `/clear`
  leaves the 1h the raise's, and fired. The hook tests prove both by running the
  event inside the write; whether Claude Code ever runs it at that point, and in
  which order two writes land, is not shown.

`/cache` names the auto-raise after the TTLs:

| Segment | When |
| --- | --- |
| `auto-raise off` | `raiseAfterExpiries` is empty |
| `auto-raise counting 1 of 2 expiries` | main is at 5m and has seen 1 of 2 |
| `auto-raise fired 3m ago` | the raise ran; main is 1h (credited `auto-raise, option raiseAfterExpiries`) |
| `auto-raise idle: main is 1h` | main is not at 5m, so nothing is counted |
| `auto-raise off: /cache main 5m was typed this session` | the session switched it off |
| `auto-raise inactive: FORCE_PROMPT_CACHING_5M is set` | Claude Code would ignore a 1h |
| `auto-raise failed, the TTL may be unchanged: …` | the write or a read failed (a failed count restart is named after it) |
| `auto-raise failed: restarting the count failed: …` | only the count's restart after a compaction or `/clear` failed |

A bad value (`abc`, `0`, `1.5`) is ignored and named by `/cache`
(`option raiseAfterExpiries "abc" ignored: use a whole number of 1 or more, or empty`).

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" },
  "pluginConfigs": {
    "cache-live-control@cache-live-control": {
      "options": { "mainTtl": "5m", "subagentTtl": "5m", "raiseAfterExpiries": "2" }
    }
  }
}
```

## 🧊 Sub-agent cache protection

A sub-agent's prompt cache expires after its TTL, 5 minutes unless raised,
and its next request then writes its whole context again at the cache-write
price: 1.25× the base input price at 5m, 2× at 1h. Three things force that
rewrite on a sub-agent: a long tool (a shell it waited on, a sleep or
polling loop), the completion notice of a background child it waited on, and
a `SendMessage` to an agent that finished long ago. The plugin never raises
a sub-agent's TTL for the first two: sub-agents run 5m unless
`subagentPromptCacheTtl`, `subagentTtl`, a typed `/cache agents 1h` or the
agent's own frontmatter says otherwise. The pieces below cover the third and
the hand-over, and every one is off until you turn it on.

### Per-agent records

The plugin keeps one record per sub-agent, in memory and bounded (256, the
agent that asked longest ago goes first; with no guard, an agent whose cache
can no longer be warm is forgotten): when its latest request went out, the
TTL the agents' variable held then, its context (`input + cache read + cache
creation + output` of its latest response), and the name and parent it
came from. A record feeds the guard. A plugin reload or a resumed session starts with none, and an
agent with no record is never guarded.

### Cold-resume guard

`resumeGuard` (`off`, `warn`, `block`) watches every `SendMessage`. The
target is an agent id or a name; a name matches the records first and the
session's agent list after. A target **passes silently** when it is warm,
when the session's agent list shows it running (the message reaches it at its
next step, which rewrites nothing the message caused),
when its context is under `resumeGuardMinTokens` (a cold resume then costs
about what a fresh agent does), or when it has no record. A cold target above
the floor is warned about or blocked, with the gap, the context and the
rewrite in tokens times the write multiplier of the TTL the resume would
write at:

```text
agent researcher has been idle 20m and its prompt cache expired 15m ago (it was written at 5m), so resuming re-writes its whole context: ~187k tokens × 1.25 (a 5m cache write) = ~234k input-token equivalents ($0.70 at $3/M base input). Not sent. To resume it anyway (for example it holds uncommitted work), send the same message beginning with [resume-anyway].
```

- `block` refuses the call: the model reads the text as the tool's error.
  `warn` sends the message, adds the same text after the tool result for the
  model, and shows it as a toast.
- **Override.** A message that begins with `[resume-anyway]` is sent with the
  marker removed, whatever the guard says, `off` included; a block explains
  it every time. A bare marker with no message after it is no override.
  The marker is a deliberate act of the sender. A repeat of the same message
  inside a window would let a blind retry defeat the guard, so there is none.
- Measured with `npm run live` (Claude Code 2.1.296, Haiku, `block`; the
  script asserts the refusal, the delivery and the cache read, and prints the
  figures of the run, which are one run's): a
  worker idle for 330 s was refused as `idle 5m … expired under a minute ago
  … ~13k tokens`, and the message never reached it; the same message beginning
  `[resume-anyway]` reached it with the marker removed; the next message, to
  the now warm worker, passed and read its cache.
- Dollars appear only with `resumeGuardPrice` (`$0.70` above is 234k tokens
  at `3`). The plugin owns no price table, and the number is the base input
  price you give it, times the multiplier.
- A check that cannot run (the clock or the agent list failed) sends the
  message and `/cache` shows `could not check a resume of …: <reason>`.

### Sub-agent progress summaries

While a sub-agent runs, Claude Code forks its whole conversation about every
30 s (tools denied, one turn) and asks the model to describe the agent's latest
action in 3-5 words; the reply only feeds the agent panel's one-line status.
With several background sub-agents that is a steady stream of full-context
requests, and the setting that turns it off (`CLAUDE_CODE_FORK_SUBAGENT=false`)
also turns off fork mode and background sub-agents. No hook sees the request,
so the plugin cannot drop it itself.

`summaries` (`block`; `allow` or empty is Claude Code's behaviour, the default)
and `/cache summaries off|on` instead mark every request: the plugin adds the
line `x-cache-live-control-summaries: block` to `ANTHROPIC_CUSTOM_HEADERS`
(Claude Code re-reads it for each request, mid-session and for sub-agents
alike, measured on Claude Code 2.1.296; your other lines stay, and every line
of the mark's name is the plugin's: `off` replaces it and `on` removes it,
even one set at launch) and a gateway on `ANTHROPIC_BASE_URL` that honours the mark
answers the summary request itself, so it never reaches the API. A gateway that
does not read the mark changes nothing: the switch then costs and saves
nothing, and `/cache` shows only what the variable holds. A refused write at session
start is named by `/cache`. The mark is the
plugin's whole contract with a gateway; one that honours it is
[gpt-gateway](https://github.com/rezzminator/gpt-gateway)'s `status_label`
with its setting `answer` at `marked`. Measured on Claude Code 2.1.296: the
request never passes the `turn.step` hook, which sees only a turn's own
requests, so a hook alone cannot stop it.

### Status

`/cache` shows each piece after the TTLs, then the latest events, newest
first:

```text
… · auto-raise off · resume-guard block (floor 60k, $3/M) · summaries on · recent: blocked a resume of researcher (~187k tokens) 1m ago; resumed worker anyway 2m ago
```

| Segment | When |
| --- | --- |
| `resume-guard off` / `warn (floor 60k)` / `block (floor 60k, $3/M)` | the guard's mode, floor and price |
| `summaries on` / `off (sends x-cache-live-control-summaries: block; …)` | whether `ANTHROPIC_CUSTOM_HEADERS` holds `x-cache-live-control-summaries: block` now, whoever set it |
| `recent: …` | the last events: `blocked a resume of X (~187k tokens)`, `warned about a resume of X …`, `resumed X anyway`, `could not check a resume of X: …` |

A bad value of any of these options is ignored, named by `/cache`, and leaves
the piece off.

### Limits

- An agent whose frontmatter sets its own TTL is invisible to the plugin: it
  records the variable's value, so such an agent is assumed to run at the
  agents' TTL (5m when automatic) and the guard may call it cold early.
- `warn` puts its text in the tool result's `context`; it is proven by the
  hook tests and not on a live Claude Code (the live proof covers the block, the
  override and a warm target).
- The context a record keeps is the agent's latest response, not a count of
  what a resume would send; a resume adds the new message to it.
- Records and events live in memory: a plugin reload forgets them.

## 🧩 Launchers

A program that starts Claude Code (Professor's `pfm` does; any launcher
may) hands the plugin its starting TTLs through two variables the plugin
owns, never through Claude Code's own, so the plugin stays the only writer
of `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`:

| Variable | Value |
| --- | --- |
| `CACHE_LIVE_CONTROL_MAIN_TTL` | The main chat's starting TTL: `5m`, `1h`, or `auto` for automatic (empty counts as not given) |
| `CACHE_LIVE_CONTROL_AGENTS_TTL` | The sub-agents', the same way |

```sh
CACHE_LIVE_CONTROL_MAIN_TTL=1h CACHE_LIVE_CONTROL_AGENTS_TTL=5m claude
```

At session start, once per process, per party, the first that is set wins:

1. Claude Code's own variable set at launch: kept.
2. The handoff variable: applied, and `/cache` credits it `set at launch`.
   `auto` leaves the party automatic.
3. The option (`mainTtl` / `subagentTtl`).
4. Main chat only: `ENABLE_PROMPT_CACHING_1H`, kept for the main chat (see
   How it works).

Both handoff variables are then unset in the process: a program the chat
starts never inherits them, and a plugin reload never applies them again. A
bad value is ignored and named by `/cache`
(`CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto`).

The plugin is standalone: it depends on no launcher, and Professor depends
on it.

## ❓ FAQ

<details>
<summary><b>How do I switch Claude Code's prompt cache between 5 minutes and 1 hour without restarting?</b></summary>

Install this plugin and type `/cache 5m` or `/cache 1h`. The next request
uses it. Without the plugin, the TTL comes from variables and settings read
when Claude Code starts.
</details>

<details>
<summary><b>How do I know it worked?</b></summary>

Each assistant message in the chat's transcript
(`~/.claude/projects/<project>/<session>.jsonl`) records its cache writes
under `message.usage.cache_creation`, as `ephemeral_5m_input_tokens` or
`ephemeral_1h_input_tokens`. A sub-agent's messages are in the session's
`subagents/` folder. `npm run live` in this repository checks exactly that.
</details>

<details>
<summary><b>Does <code>/cache</code> cost a model turn?</b></summary>

No. It prints its line locally and never reaches the model.
</details>

<details>
<summary><b>Why does <code>/cache</code> say 5m even after <code>/cache 1h</code>?</b></summary>

`FORCE_PROMPT_CACHING_5M` is set in your environment. It overrides every
other source, and `/cache` warns you about it on every line.
</details>

## 🛠️ Development

```sh
npm install
npm test              # unit tests (vitest), function-hook tests (claude plugin test) and the option variants (scripts/test-hook-variants.sh)
scripts/test-hook-variants.sh guard-block   # one option variant (hook-tests/<name>/): the kit cannot pass options, so each runs on a copy of the plugin with its defaults set
npm run typecheck
npm run validate:plugin
npm run live          # live proof in tmux, spends a few cents of Haiku
```

To try a checkout in a real session, load it with `--plugin-dir plugins/cache-live-control` (its options key is `cache-live-control@inline`), as `npm run live` does. A local directory marketplace whose plugin folder is a symlink into this checkout loads no hooks: Claude Code refuses a hooks module that resolves outside the marketplace (`Path escapes plugin directory: ./cache-live-control.ts (hooks)`, in the `--debug-file` log).

Work lands on `develop`; `main` holds only releases, and each one is tagged `cache-live-control--vX.Y.Z` with its notes in [CHANGELOG.md](./CHANGELOG.md). Pull requests go to `develop`.

`plugins/cache-live-control/hooks/cache-live-control.ts` is a thin adapter over `plugins/cache-live-control/src/`:

| Module | Role |
| --- | --- |
| `ttl.ts` | The TTL values, the two parties and their variables |
| `parse.ts` | `/cache` words, in any order, to an action: TTL groups and the settings words |
| `status.ts` | Each party's TTL and source, and the lines `/cache` prints |
| `options.ts` | Every option (`mainTtl`, `subagentTtl`, `ttlNotice`, `raiseAfterExpiries`, the guard and the summaries), read and checked |
| `notice.ts` | The `ttlNotice` note: the main TTL it names, its text, and which compaction takes it out |
| `handoff.ts` | Session start: a launch variable, a launcher's handoff variable, then the option, per party |
| `warmth.ts` | Each party's latest request, whether its cache is warm, and the warning a switch of a warm cache prints |
| `raise.ts` | The auto-raise: the expired-wake count, when it fires, what a `/cache` command, a compaction and a `/clear` do to it, and the status segment |
| `launch.ts` | `ENABLE_PROMPT_CACHING_1H` at launch: its 1h kept for the main chat only, so sub-agents default to 5m |
| `agents.ts` | The per-agent records: latest request, TTL, context, name and parent; their bounds |
| `guard.ts` | The cold-resume guard: the target, the override marker, the verdict and its text, the TTL a resume writes at |
| `summaries.ts` | The mark in `ANTHROPIC_CUSTOM_HEADERS`: adding and removing the line, reading it back, its status segment |
| `events.ts` | The short log `/cache` shows beside the protection pieces |

## 🎓 Built with Professor

cache-live-control is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. Professor runs long orchestrations of sub-agents, and choosing their cache TTL per chat is where this plugin came from.

## License

MIT

<sub>Keywords: Claude Code prompt cache TTL · prompt caching 1 hour · 5 minute cache · CLAUDE_CODE_PROMPT_CACHE_TTL · CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL · promptCacheTtl · subagentPromptCacheTtl · ENABLE_PROMPT_CACHING_1H · FORCE_PROMPT_CACHING_5M · sub-agent cache · Claude Code plugin · function hooks · Claude Mods · token cost</sub>


## Logs

Errors, warnings and session-start readiness are appended to
`$PLUGIN_LOG_DIR/cache-live-control/{errors,warnings,info}.jsonl`.
When `PLUGIN_LOG_DIR` is unset, they go to
`$HOME/.local/state/cache-live-control/logs/`. Each JSONL row names its event,
component and session when known. Files past 20 MiB move aside to `.1` on
write, with a `log-capped` warning. A failed write reports once through the
existing debug log per failing streak and never changes the cache operation.
Existing notices and `/cache` replies are unchanged.
