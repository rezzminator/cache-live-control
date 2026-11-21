<div align="center">

# cache-live-control

**Change the prompt-cache TTL of one Claude Code chat, instantly, with no model turn: `/cache 5m`, `/cache main 1h`, `/cache 1h agents`, words in any order, for the main chat, its sub-agents or both, with a one-line warning when a switch touches a warm cache.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.8.0--dev.1-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-732%20passing-brightgreen)](#development)
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
- ♨️ **Keep-warm, for waits.** While a chat or sub-agent waits on background work, it submits a visible, capped, budgeted poke before the cache lapses; `/keepwarm` controls it for this chat ([Keep-warm](#keep-warm)).
- 🔒 **This chat only.** Nothing is written to a settings file; another chat,
  or the next session, is untouched.

## 🚀 Quick start

```sh
# 1. Turn on function hooks
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

# 2. Install
claude plugin marketplace add rezzminator/cache-live-control
claude plugin install cache-live-control@professor
```

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` also works in the `env` block of
`settings.json`. Then type `/cache` in any chat.

> **Early access.** This plugin is built on Claude Code's function hooks,
> an early-access surface that may change between releases. It is tested on
> Claude Code 2.1.316, the version CI pins: `CLAUDE_CODE_VERSION` in
> [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

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
"may") and as 5m for sub-agents (row 6 below, measured). A variable holding
a value Claude Code does not take is assumed the same way, and says "may" for
either party.

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
`pluginConfigs["cache-live-control@professor"].options` in
`settings.json`. The key must be the full plugin id: Claude Code silently
ignores options under any other key.

| Option | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `mainTtl` | `CACHE_LIVE_CONTROL_MAIN_TTL` | empty | The main chat's TTL at session start: `5m`, `1h`, or empty to leave it automatic. |
| `subagentTtl` | `CACHE_LIVE_CONTROL_SUBAGENT_TTL` | empty | The sub-agents' TTL at session start, the same way. |
| `ttlNotice` | `CACHE_LIVE_CONTROL_TTL_NOTICE` | `false` | Tell the main chat's model which TTL it runs on, and how to delegate on it (below). |
| `raiseAfterExpiries` | `CACHE_LIVE_CONTROL_RAISE_AFTER_EXPIRIES` | empty (off) | A whole number of 1 or more: on a main chat at 5m, the Nth wake-up to an expired cache goes out at 1h, and main stays 1h (below). |
| `resumeGuard` | `CACHE_LIVE_CONTROL_RESUME_GUARD` | empty (off) | `off`, `warn` or `block`: what to do with a `SendMessage` to a cold, large sub-agent ([below](#-sub-agent-cache-protection)). |
| `resumeGuardMinTokens` | `CACHE_LIVE_CONTROL_RESUME_GUARD_MIN_TOKENS` | `60000` | The context, in tokens (`60000` or `60k`), below which a cold resume passes: it costs about what a fresh agent does. |
| `resumeGuardPrice` | `CACHE_LIVE_CONTROL_RESUME_GUARD_PRICE` | empty | USD per million base input tokens. Set it to see dollars beside the tokens; the plugin owns no price table. |
| `summaries` | `CACHE_LIVE_CONTROL_SUMMARIES` | empty (allow) | `block`, `allow` or empty: `block` starts the session with the sub-agent progress summaries stopped ([below](#sub-agent-progress-summaries)); empty or `allow` keeps Claude Code's behaviour. |
| `keepwarm` | `CACHE_LIVE_CONTROL_KEEPWARM` | `true` | [Keep-warm](#keep-warm) pokes at all; `/keepwarm` overrides it for one chat. |
| `keepwarmMinContext` | `CACHE_LIVE_CONTROL_KEEPWARM_MIN_CONTEXT` | `20000` | Keep-warm: the smallest main-chat context in tokens worth a poke. |
| `keepwarmMaxPokes` | `CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES` | `4` | Keep-warm: pokes per thread (the main chat, or one sub-agent) while its sorted set of pending ids is unchanged and nothing else happens; an integer of at least 1. |
| `keepwarmSubagents` | `CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENTS` | `true` | Keep-warm: poke waiting sub-agents in independent episodes; each poke also wakes the spawning parent for one real turn, which the forecast counts. Off leaves the main-chat path unchanged. |
| `keepwarmSubagentMinContext` | `CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT` | `100000` | Keep-warm: the smallest sub-agent context in tokens worth a poke and its parent wake. |
| (none; not a `/config` option) | `CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/cache-live-control/keepwarm/sessions` | Keep-warm: the directory of the session state JSON a status line reads (an absolute path, [below](#session-state-json)). Blank is absent. |

Every option is also read from the environment variable in its row, so one
`env` block configures it with no plugin settings: `CACHE_LIVE_CONTROL_` and
the option in upper snake case. The variable beats the option, the option
beats the default. A variable that is unset or blank is absent. A boolean
reads `1`, `0`, `true` or `false` in any case; every other option reads the
value its row describes, and `mainTtl` and `subagentTtl` also read `auto`
([Launchers](#-launchers)). A bad variable is named by `/cache`
(`CACHE_LIVE_CONTROL_RESUME_GUARD "maybe" ignored: use off, warn or block`)
and leaves the option at its default: the option does not stand in for it.

An option applies once, when the session starts, and never over a variable
already set at launch (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h claude` keeps 1h). A
bad option value is ignored, and `/cache` names it.

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
    "cache-live-control@professor": {
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

## Keep-warm

Keeps Claude Code prompt caches warm during background waits with visible pokes, for the main chat and waiting sub-agents, capped per wait and each under its own rewrite-saving budget. It is the standalone keep-warm plugin folded into this one, `/keepwarm` its command; two behaviours changed in the fold: a compaction inside a poke's own turn no longer ends the wait (§ What it does), and the poke's last line asks for the single word `waiting` (§ The poke). It is built against the plugin types of Claude Code 2.1.302 and needs a release with function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`); function hooks are early access and may change between releases.

### What it does

Claude Code caches the prompt for 5 minutes or 1 hour. A chat that waits on a long background agent or command goes idle, the cache lapses, and the next request writes the whole context again.

When the main chat ends a turn with tracked work pending, keep-warm arms one timer for 80% of the cache lifetime after the last request was sent. When it fires and the chat is still idle and still waiting, the plugin submits a poke into the chat through `$.prompt.submit`: a real prompt, shown in the transcript, which the model answers in one real turn at the chat's model and effort, thinking included. That request reads the cached prefix and so refreshes it. The poke turn re-anchors the timer, and the wait goes on.

It waits on four kinds of tracked work: agents, commands, Monitors and workflows. At most `keepwarmMaxPokes` pokes (default 4) go to one wait while its pending items stay the same and nothing else happens; real activity (your prompt, a real turn, an item finishing, a new item) starts a fresh count, so a chat that lives for days gets fresh pokes for each later wait. A completion notification or your prompt ends the episode before another poke can fire. A main-chat compaction ends the episode too, unless it runs inside a poke's own turn (Claude Code's automatic compaction before the poke's request): that episode keeps its poke count and spend, and its protected prefix, so its allowance, is retaken from the poke's first request after the compaction. A `precompute` compaction ends nothing, and a sub-agent's own compaction ends only that agent's episode.

Waiting sub-agents (`keepwarmSubagents`, on by default) have independent episodes, timers, budgets and poke counts: after an agent ends a turn with its own attributable background work pending, the same poke goes to the agent itself. The plugin re-checks the native roster immediately before sending and addresses only `waiting` agents, never finished, idle, failed or killed agents. Main-chat turns do not cancel an agent's episode. Each sub-agent poke makes Claude Code hand the spawning parent (the main chat or a nested agent) an interim task-notification, which starts one real parent turn per poke; the budget forecast counts that parent wake, and the plugin never filters it.

### The poke

The main chat and sub-agents get the same message, one bullet per pending item:

```text
Keep-warm poke 2/4: your prompt cache was about to expire, so this message keeps it warm while you wait on:
- agent `a1b2c3d4`: Audit the release notes, pending 8m
- command `b5e6f7a8`: npm run build, pending 3m
If any of these is stale or was started by accident, stop it now. Otherwise reply with the single word `waiting` and nothing else: this turn only keeps the cache warm, and the plugin reads nothing from your reply.
```

The kind is `agent`, `command`, `Monitor` or `workflow`; the id is the real task id Claude Code reports, so the model can stop that item. The label is sanitized to 40 characters (plus an ellipsis), with `your background work` when unknown; the elapsed time counts from the item's first sighting.

A poke is a real turn, so it costs what a turn costs at the chat's effort, and other plugins see it: it passes through their prompt and turn hooks with `origin` `{ kind: 'plugin', name: 'cache-live-control' }`, and an effort planner can change the poke turn's effort. The poke and its own reply are not activity: they neither end the wait nor reset its count.

### Commands

`/keepwarm` is answered by the plugin with no model turn and takes effect at once, for this chat only; nothing is written to a settings file.

| Form | Effect |
| --- | --- |
| `/keepwarm` | Print the state: on or off and whether that is the launch default or the override, the current wait, the latest decision (a reached cap as `poke limit reached 4/4`), actual spend against the allowance, and live sub-agent count, labels, pokes and spend |
| `/keepwarm status` | Same as no argument |
| `/keepwarm on` | Override a disabled launch default; a wait already standing is armed at once |
| `/keepwarm off` | Cancel all main and sub-agent timers and end their episodes; a poke already submitted still accounts its usage but cannot re-arm |

Any other argument prints the usage and changes nothing. A new session or `/clear` resets the override to the launch default (`keepwarm`).

### Session state JSON

External status-line readers get one metadata-only file per **main session**, never a sub-agent view:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/cache-live-control/keepwarm/sessions/{sessionId}.json
```

`CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR` overrides the sessions directory itself (an absolute path, not a parent). Blank is absent. A relative `CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR` or `XDG_STATE_HOME` is skipped for the next in line and named in the status, as `state directory: CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR not absolute; using {directory}`. This transport variable is not a `/config` option. Node.js 20+ must be on Claude Code's `PATH` for the file writer. A same-directory, exclusive temporary file (mode `0600`) is renamed atomically over the destination; new directories use `0700`. Writers serialize changes within the process, skip unchanged projections, and publish on main status changes and `/keepwarm on|off`. Files contain no task labels, command text, messages, or sub-agent views.

#### v1 fields

| Field | Contract |
| --- | --- |
| `v` | Schema version, exactly `1` |
| `sessionId` | Main Claude session id; filename is `{sessionId}.json` |
| `pid` | Claude Code process PID, not the temporary writer PID |
| `updatedAt` | Epoch milliseconds when this projection is published |
| `enabled` | Effective launch default or session override, boolean |
| `source` | `launch` or `session` |
| `state` | `warming`, `on`, `stopped`, or `off` as below |
| `reason` | Stable `ReasonCode` as below; disabled always reports `off` |
| `pokes` | `{count,max}` for the main wait, or `null` if unavailable |
| `nextAt` | Scheduled future main poke, epoch milliseconds; `null` without a future due time |
| `protectingTokensEq` | Gross hypothetical rewrite cost from the current budget ledger; number or `null`, never a realized saving |

#### State mapping

- `warming`: `eligible` or `in-flight`, only while the main view has waiting items. Without waiting items these reasons map to `on`.
- `stopped`: `poke-limit`, `budget`, `poke-failed`, `timer-failed`, `stale`, `ended`.
- `off`: `off`, or any view with `enabled: false` (its reason is normalized to `off`).
- `on`: `agent-not-waiting`, `busy`, `inventory-unknown`, `nothing-pending`, `usage-unknown`, `usage-invalid`, `small`, `1h-unproven`, `cache-cold`, `expiry-safety`, `wake-unknown`, `cannot-wake`, `imminent`, `marginal`, `resumed`, `idle`.

`on` means enabled, not currently warming; it does not promise a warm cache. `nextAt` is `null` unless the state is `warming` with a future timer. Session end deletes the file, and any temporary a killed writer left for the session, including before `/clear` or resume changes the id; the replacement session publishes its own view. Abrupt termination can leave a file: readers must check the Claude PID's liveness, not expire by age (a quiet `on` session is legitimate). A reused PID passes a liveness check alone: a reader also requires the process to have started before `updatedAt`. Resuming the same session in two processes shares one filename; the last atomic writer wins.

A write or deletion failure logs the full destination path and error through the plugin's debug log and never throws into chat. The next changed view retries. `/keepwarm status` remains the direct in-chat inspection path. After a returning wait, the closing toast gives elapsed time, actual cache-read percentage and explicitly estimated net saving; the last outcome stays in `/keepwarm`.

### When it pokes

Every timer fire is a decision made by one pure function; each outcome (poke, skip, stop) carries a short reason code that `/keepwarm status` shows and the log records. It does not poke:

- while a main turn runs; a draft in the prompt box neither stops nor delays a poke, which is submitted as its own prompt;
- when the cache is cold, or within 15 seconds of expiry, a window too close for a request to land;
- when nothing tracked is pending, when everything pending is finished, killed or failed, or when the only tracked work is of a kind not known to wake the chat (such an item is shown, and refuses with `wake-unknown`);
- when work is known to return before the cache expires: known timing comes from structured facts only, and an unknown return time is shown as unknown, never guessed from a task description or a command's text;
- once this wait has had `keepwarmMaxPokes` pokes with its pending items unchanged and nothing else happening (`poke-limit`);
- when the forecast saving is marginal, or the budget is spent (§ Budget and ledger);
- after a poke failed (Claude Code dropped or refused it, or its turn failed), with no retry.

The anchor for the timer is the last main request that read or wrote the cache; a response with no cache use invalidates earlier warmth instead of renewing it. The timer fires at 80% of the lifetime after that anchor; a candidate at or after the anchor plus the lifetime minus 15 seconds is refused as `expiry-safety`, and a fully expired cache as `cache-cold`.

### Status line

The plugin paints the line under the prompt only for a problem: a bad option or TTL variable, a relative state directory, or a failed log write, such as `bad options: CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES`; a wait paints nothing. A status line shows warming from the session state JSON (§ Session state JSON). `/keepwarm status` gives the whole state in words, its reason code in brackets:

- Warming: `warming [eligible]`, with the first waiting item, `+1 more`, and the elapsed time (`9m`, `1h05m`).
- Not warming: `not warming: context too small`, `not warming: no main request seen since the plugin loaded`, `not warming: 1h refresh unproven`.
- Stopped: `stopped: poke limit reached 4/4` · `stopped: next warm exceeds budget` · `stopped: work ended` · `stopped: poke failed ({cause})` · `stopped: timer failed ({message})` · `stopped: this Claude Code gives the Stop hook no background_tasks`.
- Log: `keep-warm: plugin log {directory} failed: {message}; {n} rows are kept for the next write` or `keep-warm: plugin log off: no PLUGIN_LOG_DIR and no HOME`, shown once per failing streak and re-armed by the next successful write; warming continues. Only an error reaches the screen.

Labels (an agent's description, a command line) are sanitized to 40 characters plus an ellipsis for display and the poke text. They never enter the metadata log. Sub-agent log rows carry `kind: "subagent"` and `agentId`, not message text.

### Configuration

Five options, `keepwarm`, `keepwarmMinContext`, `keepwarmMaxPokes`, `keepwarmSubagents` and `keepwarmSubagentMinContext`, set in the plugin's `/config` page or by variable; their rows are in § Configuration above.

Precedence is variable, then option, then default. A blank variable is absent; booleans read `1`, `0`, `true` or `false` in any case; `keepwarmMaxPokes` reads a whole number of at least 1. A bad variable or option is named in the status and the default applies, never the configured option. The log never contains a label, command or description.

The decision log is on by default and has no option or plugin variable: it writes under `$PLUGIN_LOG_DIR/cache-live-control` when `PLUGIN_LOG_DIR` is set, else `~/.local/state/cache-live-control/logs` (the plugin's own log directory, shared with the TTL control; keep-warm rows carry `plugin: "keep-warm"`), and is off, said once, when neither resolves. It appends one JSON row per decision to `errors.jsonl` (a failed poke, timer, inventory or store write), `warnings.jsonl` or `info.jsonl` (every other decision), the directory `0700` and the files `0600`, written through `$.process.run` because Claude Code's file write replaces a whole file. A row's keys are `ts`, `plugin`, `level`, `event`, `msg`, `where`, `session` and `detail`, at most 4096 bytes; `detail` is the metadata row the plugin used to write (event, epoch, items, ttl, context, spent, reason, pokes, usage, ledger, session ledger). A level file past 20 MiB moves to `{file}.1`, older generations shifting up to `.5`, and a `log-capped` row goes to `warnings.jsonl`. A failed write keeps its rows, up to 2,000, for the next write; past that the oldest go, and the next successful write logs a `plugin-log-rows-dropped` error row counting them. Writers share a lock in the log directory, waited on up to 10 seconds. The screen shows an error and one line per failing streak; every other row stays in its file. A directory that other users can write still leaves a gap between check and write.

Persistence keeps one snapshot per Claude Code process (`session:{session id}:{instance}`) of the last-use anchor and the numeric ledger, with its save time. A resumed session restores the newest valid snapshot for its own session id. Snapshots older than seven days by their save time are deleted when a session starts, valid or not; one this version cannot read (another version, a damaged record) stays until then, one with no save time stays, and one of the session's own id is shown as `resume refused (invalid-record)`. A snapshot never restores the `/keepwarm` override, a timer, an admission or a grant. The plugin store is one JSON file shared by all processes; how concurrent writes from two processes interleave is unmeasured.

### TTL resolution

The cache lifetime is resolved per episode, first match wins:

1. `FORCE_PROMPT_CACHING_5M=1`: 5m.
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` equal to `5m` or `1h`: that value. Any other non-blank value of it, or of `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, is skipped and named in the status: `CLAUDE_CODE_PROMPT_CACHE_TTL="30m" ignored: not 5m or 1h`.
3. The session's observed lifetime: a request sent 330,000 to 3,300,000 ms after the previous one that read at least 90% of the previous context means 1h; below 90% means 5m; outside that gap there is no evidence.
4. `ENABLE_PROMPT_CACHING_1H=1`: 1h.
5. Otherwise 5m, shown as `TTL assumed 5m`. An assumed 5m is never late, only more frequent.

Sub-agents resolve independently: `FORCE_PROMPT_CACHING_5M=1`, then `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` (`5m|1h`), then `ENABLE_PROMPT_CACHING_1H=1`, then that agent's observed lifetime using the same 90%-read rule, otherwise assumed 5m. The main-chat TTL variable does not set a sub-agent's TTL.

A poke is an ordinary request of the thread it goes to, so it refreshes that thread's entry at that thread's own lifetime.

### Budget and ledger

One producer owns the arithmetic. Costs are input-token equivalents (read 0.1, cache write 1.25 at 5m and 2.0 at 1h, plain input 1, output 5), not dollars; USD appears only if the engine exposes a verified price.

- Saved by one avoided rewrite: `context × (write − 0.1)`.
- Spent by a poke, from its own turn's usage: `read × 0.1 + creation × 2.0 + input × 1 + output × 5`, charged once at `turn.complete`, thinking and every request of the turn included.
- Forecast of the next poke: the actual spend of this thread's previous poke, never under a floor of `context × 0.1 + (tail + 150) × 2.0 + 1000 × 5` (the context read, the last response's `tail` and the poke written, a 1,000-token reply).
- A sub-agent poke adds its parent wake to the forecast and, once sent, to the spend: `parent context × 0.1 + (150 + 1000) × 2.0 + 1000 × 5`, the parent's last known context standing in for it.
- A poke is allowed while `spent + forecast ≤ saved` and `saved − spent − forecast ≥ 0.1 × forecast`, so a poke whose saving is marginal is declined.

Worked example, a 5m cache on Haiku with a 50,552-token context, a 3-token tail and pokes whose turns read 49,745 tokens, wrote 807, took 25 plain input tokens and produced 3 output tokens:

- One rewrite saved: 58,134.8.
- Every poke: forecast 10,361.2 (the floor, above the 6,628.5 a poke spent), actual spend 6,628.5.
- The default cap of 4 ends the wait first; on budget alone the ninth would reach 63,389.2, above 58,134.8, and is refused.
- The same wait in a sub-agent whose parent holds 50,552 tokens adds 12,355.2 per poke for the parent wake.

Each sub-agent uses the same ledger arithmetic independently. Claude Code 2.1.302 skips this plugin's start and step hooks for the plugin's own native send, so a sub-agent poke is charged and re-anchored only after the actual `turn.complete` and an exact own receipt in `session.messages` (a raw message or a measured coordinator envelope) are verified. A cold poke or unknown usage ends the episode rather than claiming cache protection.

The budget is an admission forecast plus actual accounting, not a hard realized-spend limit: a poke is a real turn, so an admitted poke can cost more than forecast (a longer reply, more thinking, a tool call), and the episode then stops at the next check. A wait that outlasts the budget or the cap still ends in a rewrite.

`/keepwarm`, the log and the closing toast show the same ledger: actual spend, the allowance (write minus read saving), and `protecting`, the gross cost of the rewrite the pokes may avoid. `protecting` is hypothetical, not a realized saving. The closing net is an estimate, not a measured counterfactual: it credits one avoided rewrite minus poke spend only for a same-prefix return after the original expiry with at least 90% cache read. A return before the original expiry, or a miss, closes at minus the spend; unknown usage closes as unknown, never zero.

### Limits

- No hang detection. Claude Code exposes no activity time for a task, so a pending item is never declared hung; each poke lists it with its elapsed time and asks the model to stop it if it is stale, and the cap bounds an unchanged wait.
- A poke is visible and real. It adds a prompt and a reply to the transcript, which compaction later carries, and costs a real turn at the chat's effort; the forecast learns from the previous poke, but an admitted poke has no output cap.
- Sub-agent poking reaches only idle loops held on attributable pending background work. A foreground tool call cannot be poked. Ownership comes from that agent's successful background tool results or native child-parent links, not the session-wide Stop task list. Missing attribution refuses the poke. A native send queues a message, not a guaranteed model response; a poke not settled within one minute stops that episode.
- The parent wake is accepted. Each sub-agent poke makes Claude Code send the spawning parent, main chat or nested agent, an interim task-notification, which starts one real parent turn; the forecast counts it, and every native delivery is preserved. The parent sees every sub-agent poke. The 100,000-token `keepwarmSubagentMinContext` keeps it to agents whose rewrite outweighs that turn.
- No wait on the user. Only tracked background work is kept warm.
- 1h: the decision admits a 1h cache (`WARM_1H`). A request at 80% of the 1h lifetime refreshing the entry was measured on Claude Code 2.1.302 (a 4,017-second wait held by one such request) and again on 2.1.316 (a 4,044-second wait whose return read 98.4% from cache); a 1h wait carried by a poke is not yet live-measured. A failed `ttl-1h` rerun turns 1h poking off, and a 1h episode then shows `not warming: 1h refresh unproven`.
- A plugin reload rewrites the cached prefix. When a plugin reloads mid-wait (observed after an installed plugin was updated), Claude Code re-renders the environment block near the start of every request (measured on 2.1.302: 48,126 to 49,901 characters), so the cache is lost for the chat and the poke alike; the poke then pays the rewrite, and the ledger accounts it.
- Unknown wake behaviour. Claude Code gives a task no expected return time and no flag saying whether it can wake the chat; the plugin treats the four known kinds as waking and refuses the rest.
- A shell or Monitor killed from the UI while the chat is idle may send no notification; its item is listed in each poke, where the model can see it, until the cap or the budget ends the wait.
- Poke counts live in memory per thread: a restarted Claude Code process starts every count over, as its background work died with it.
- Managed organizations: a Claude Code managed by an organization skips a user-installed plugin's `classic.Stop`, `session.compact` and `classic.PostModelSwitch` hooks unless the organization lists the plugin, so poking and episode ends do not run there.
- The live lanes are exercised on Linux only; macOS and Windows are untested.

### Live harness and measurements

```sh
npm run live:keepwarm -- --lane state --cwd <trusted-dir> --output <outside-repo-path> # one short chat: v1 write, then /keepwarm off
npm run live:keepwarm -- --lane wait-return --cwd <trusted-dir> --auto-effort-dir <path> --output <outside-repo-path>   # also cap, subagent-wait, ttl-1h, collision, stale; or --all
```

`--lane state` launches exactly one short real chat with prompt suggestions disabled, reads the v1 file, checks the live Claude PID, sends `/keepwarm off`, and proves an atomic v1 replacement with `enabled: false`, `source: session`, `state: off`, and `reason: off`. It uses only this plugin directory, needs no comparison plugin, and records both snapshots outside the repository. It does not run a cache experiment or another lane.

`--lane wait-return` runs a warm/control pair over a 755-second background agent: the checker requires every poke in the main transcript with its exact text and the real task id of the awaited agent, each admitted four minutes after the main request before it, each poke request and the return reading at least 90% from cache, no five-minute gap between main requests, and a control with warming off returning below 90%. `--lane cap` runs one lane with `CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES=2` over a 900-second wait: exactly two pokes, a `poke-limit` decision and `poke limit reached 2/2` in the status, and no poke after it. `--lane subagent-wait` runs a warm/control pair: each real Haiku sub-agent owns a 420-second background shell, with `CACHE_LIVE_CONTROL_KEEPWARM_SUBAGENT_MIN_CONTEXT=0` so a small lane qualifies and the main chat's gate closed; the checker requires each poke to name the owned task, poke turns and the return to read at least 90% from cache, native admission and usage rows, and a subagents-off control returning below 20%, and records the parent wakes it observes. Lane overrides reach only the lane's own chat. The lanes leave the seat's other installed plugins enabled.

One run of each lane on Claude Code 2.1.302, measured on 2026-10-19 (one run's measurements, not a release sequence): `wait-return` sent three visible pokes, 1/4 to 3/4, each naming the awaited agent's real task id, each poke request reading 99.3% to 99.5% from cache (about 55,000 tokens read, 286 to 383 written; the first poke's turn produced 102 output tokens with thinking, the next two 5); the return read 98.8% from cache, and the control with warming off returned at 0.0%. `cap` with `CACHE_LIVE_CONTROL_KEEPWARM_MAX_POKES=2` sent exactly pokes 1/2 and 2/2, recorded the `poke-limit` stop and sent nothing more over the rest of a 905-second wait, so its return read 0.0%. `subagent-wait` sent the waiting sub-agent one visible poke naming its own background shell; the poke read 99.6% and the sub-agent's return 99.0% from cache, against 0.0% for the subagents-off control, and the poke woke the main chat once (one interim task-notification, one real parent turn), as § Limits states.

The unit gates (decisions, and the function-hook tests on a stand-in and on the testing kit) are unit fidelity; there is no hermetic end-to-end tier. The live lanes boot a real Claude Code on the invoking user's own configuration with the plugin loaded through `CLAUDE_CODE_PLUGIN_DIRS` and Claude Code's prompt suggestion off (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`: its request after each turn writes the conversation's cache, so a control lane would not go cold), never copy credentials, and judge transcript usage and log rows, never a model's statement. The checker voids a lane, never passes or fails it, on an API or auth error, a real compaction of the lane's main session mid-lane (a `precompute`, a sub-agent's own compaction, or one a plugin vetoed or that failed is recorded, never voided), or a main request that keeps fewer messages of its base request than the base sent: Claude Code rewrote the prefix mid-lane (§ Limits, plugin reload), so the lane proves nothing about the cache. A release needs three clean serial `--all` sequences and one clean `--lane ttl-1h` on the final tree; a voided lane does not count.

The live harness needs `node`, `npm`, `claude`, `python3`, `tmux`, the user's existing Claude configuration, a working directory with its own trust entry in Claude Code passed as `--cwd`, and the directory of the second plugin used for the comparison. The evidence directory is the `--output` argument or a temporary directory outside the repository. The session state read after the return checks that warming ended. Each lane starts its own `claude` detached in its own tmux server (socket `kw-{lane}-{id}`), with the lane's environment and Claude Code's `CLAUDE_CODE_PROMPT_CACHE_TTL` set to the lane's TTL, and ends it by killing that server and every process carrying the lane's marker, then moves the dead chat's transcript and session folder out of the seat's projects store into the evidence directory's `sessions-retired/`, so no lane stays resumable; a run stopped by SIGKILL leaves it running, listed by `ls ${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/ | grep kw-` and ended with `tmux -L {socket} kill-server`.

### Credits

- [claude-cache-warm](https://github.com/FiredMosquito831/claude-cache-warm) (MIT): skip a warm once the cache has expired, a minimum context, supersede by newer activity.
- An earlier keep-warm plugin of the same name by mupamuc (MIT): the immediate `/keepwarm [on|off|status]` command, anchoring on a response that used the cache, the 15-second expiry safety, same-session restore.

Keep-warm differs from both by keeping caches warm only while tracked work is pending, through visible pokes to the main chat and waiting sub-agents, capped per wait and under independent budgets. Their licences are in `THIRD-PARTY-NOTICES`.

## 🧩 Launchers

A program that starts Claude Code may hand the plugin its starting TTLs
through variables the plugin owns, never through Claude Code's own, so the
plugin stays the only writer of
`CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`.
They are the environment variables of the options `mainTtl` and `subagentTtl`:

| Variable | Value |
| --- | --- |
| `CACHE_LIVE_CONTROL_MAIN_TTL` | The main chat's starting TTL: `5m`, `1h`, or `auto` for automatic (empty counts as not given) |
| `CACHE_LIVE_CONTROL_SUBAGENT_TTL` | The sub-agents', the same way |
| `CACHE_LIVE_CONTROL_AGENTS_TTL` | The sub-agents' variable under its earlier name; read when `CACHE_LIVE_CONTROL_SUBAGENT_TTL` is unset or blank |

```sh
CACHE_LIVE_CONTROL_MAIN_TTL=1h CACHE_LIVE_CONTROL_SUBAGENT_TTL=5m claude
```

At session start, once per process, per party, the first that is set wins:

1. Claude Code's own variable set at launch: kept.
2. The handoff variable: applied, and `/cache` credits it `set at launch`.
   `auto` leaves the party automatic.
3. The option (`mainTtl` / `subagentTtl`).
4. Main chat only: `ENABLE_PROMPT_CACHING_1H`, kept for the main chat (see
   How it works).

The handoff variables are then unset in the process: a program the chat
starts never inherits them, and a plugin reload never applies them again. A
bad value is named by `/cache`
(`CACHE_LIVE_CONTROL_MAIN_TTL "2h" ignored: use 5m, 1h or auto`) and that
party stays automatic: the option does not stand in for it.

The plugin is standalone: it depends on no launcher.

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
npm run check:structure   # keep-warm's file rules: no leaked paths or emails, size ceilings, pure modules, standalone files
npm run live          # live proof in tmux, spends a few cents of Haiku
npm run live:keepwarm -- --lane state --cwd <trusted-dir> --output <outside-repo-path>   # keep-warm's live lanes ([above](#live-harness-and-measurements))
```

To try a checkout in a real session, load it with `--plugin-dir plugins/cache-live-control` (its options key is `cache-live-control@inline`), as `npm run live` does. A local directory marketplace whose plugin folder is a symlink into this checkout loads no hooks: Claude Code refuses a hooks module that resolves outside the marketplace (`Path escapes plugin directory: ./cache-live-control.ts (hooks)`, in the `--debug-file` log).

Work lands on `develop`; `main` holds only releases. Merging the `develop → main` pull request is the release: [`publish.yml`](./.github/workflows/publish.yml) tags the merge commit `cache-live-control--vX.Y.Z` and publishes its notes from [CHANGELOG.md](./CHANGELOG.md). `make release-check` runs that pull request's checks locally first. Pull requests go to `develop`.

`plugins/cache-live-control/hooks/plugin.ts` is the plugin's one hooks module (Claude Code takes one per plugin): it registers the seven events both features hook once each, the TTL control outermost, and leaves every other hook to its adapter, `hooks/cache-live-control.ts` (the `/cache` control) and `hooks/keepwarm.ts` (keep-warm, with its session-state writer `hooks/keepwarm-state-file.mjs`). Each adapter is thin over `plugins/cache-live-control/src/`, keep-warm's decisions in `src/keepwarm/`:

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

Errors, warnings and actionable decisions are appended to
`$PLUGIN_LOG_DIR/cache-live-control/{errors,warnings,info}.jsonl`.
When `PLUGIN_LOG_DIR` is unset, they go to
`$HOME/.local/state/cache-live-control/logs/`. Each JSONL row names its event,
component and session when known. Files past 20 MiB move aside to `.1` on
write (five generations kept, `.1` newest), with a `log-capped` warning. The log is written by the plugin's own
logging module, `src/plugin-log.ts`.

The screen shows only an error's line, and one line per failing streak of the
log itself (`cache-live-control: plugin log {dir} failed: …`, or `plugin log
off` with no directory), said again only after a write succeeds; a warning or
info row never reaches the screen. A failing log never changes the cache
operation, and `/cache` replies are unchanged.
