<div align="center">

# cache-live-control

**Change the prompt-cache TTL of one Claude Code chat, instantly, with no model turn: `/cache 5m`, `/cache main 1h`, `/cache 1h agents`, words in any order, for the main chat, its sub-agents or both, with a one-line warning when a switch touches a warm cache.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.3.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-124%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
/cache                →  cache-live-control: main 1h (set at launch, warm 41m) · agents automatic (5m, unless subagentPromptCacheTtl or the agent's frontmatter sets it, cold)
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

An option applies once, when the session starts, and never over a variable
already set at launch (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h claude` keeps 1h)
or a launcher's handoff (below). A bad value is ignored, and `/cache` names it.

`ttlNotice` (opt-in, off by default) puts a short note beside the main chat's
prompt, which the model reads and you never see: on the first prompt, and on
the first one after the main TTL changes or the chat compacts or `/clear`s.
Sub-agents never get it. The note names the TTL and where it comes from, and
what it means for the chat's work:

- **1h**: a wait of up to an hour (a sub-agent's run, a background job) keeps
  the cache warm, while every token written costs 2× the base input price
  (1.25× at 5m), so the model keeps its context lean and delegates multi-step
  work to sub-agents.
- **5m**: any wait over 5 minutes lets the cache expire and the next request
  writes the whole context again, so the model does what fits in the chat
  itself and never waits, polls or schedules a wake-up past 5 minutes
  expecting the cache to hold.

An automatic main chat is assumed 1h, the subscription default (an API-key
plan runs 5m), and the note says so; `FORCE_PROMPT_CACHING_5M` makes it 5m;
a main variable Claude Code does not take gets no note.

```json
{
  "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" },
  "pluginConfigs": {
    "cache-live-control@cache-live-control": {
      "options": { "mainTtl": "1h", "subagentTtl": "5m" }
    }
  }
}
```

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
npm test              # unit tests (vitest) and function-hook tests (claude plugin test)
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
| `parse.ts` | `/cache` words, in any order, to an action |
| `status.ts` | Each party's TTL and source, and the lines `/cache` prints |
| `options.ts` | The `mainTtl` / `subagentTtl` / `ttlNotice` options, read and checked |
| `notice.ts` | The `ttlNotice` note: the main TTL it names, its text, and which compaction takes it out |
| `handoff.ts` | Session start: a launch variable, a launcher's handoff variable, then the option, per party |
| `warmth.ts` | Each party's latest request, whether its cache is warm, and the warning a switch of a warm cache prints |
| `launch.ts` | `ENABLE_PROMPT_CACHING_1H` at launch: its 1h kept for the main chat only, so sub-agents default to 5m |

## 🎓 Built with Professor

cache-live-control is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. Professor runs long orchestrations of sub-agents, and choosing their cache TTL per chat is where this plugin came from.

## License

MIT

<sub>Keywords: Claude Code prompt cache TTL · prompt caching 1 hour · 5 minute cache · CLAUDE_CODE_PROMPT_CACHE_TTL · CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL · promptCacheTtl · subagentPromptCacheTtl · ENABLE_PROMPT_CACHING_1H · FORCE_PROMPT_CACHING_5M · sub-agent cache · Claude Code plugin · function hooks · Claude Mods · token cost</sub>
