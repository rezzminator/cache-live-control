<div align="center">

# cache-live-control

**Change the prompt-cache TTL of one Claude Code chat, instantly, with no model turn: `/cache 5m`, `/cache 1h`, `/cache auto`, for the main chat, its sub-agents or both.**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code/plugins)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-45%20passing-brightgreen)](#development)
[![Built with Professor](https://img.shields.io/badge/built%20with-Professor-8A2BE2)](https://github.com/rezzminator/professor)

</div>

```text
/cache                →  cache-live-control: main 1h (set by /cache) · agents automatic (settings, agent frontmatter or plan default)
/cache 5m             →  cache-live-control: main 5m · agents 5m
/cache agents 1h      →  cache-live-control: main 5m · agents 1h
/cache main auto      →  cache-live-control: main automatic · agents 1h
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
- 🎯 **Main chat and sub-agents apart.** `/cache main …` and
  `/cache agents …` set each on its own; `/cache 5m` sets both.
- 🧭 **Status with sources.** `/cache` alone shows each TTL and where it
  comes from, and warns when `FORCE_PROMPT_CACHING_5M` overrides everything.
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

| Command | Main chat | Sub-agents |
| --- | --- | --- |
| `/cache` | shown | shown |
| `/cache 5m` / `/cache 1h` | set | set |
| `/cache auto` | automatic | automatic |
| `/cache main 5m\|1h\|auto` | set / automatic | unchanged |
| `/cache agents 5m\|1h\|auto` | unchanged | set / automatic |

"Sub-agents" covers everything Claude Code does not run as the main chat:
sub-agents, workflows, and background helper requests. Anything else prints
one usage line and changes nothing.

## 🧠 How it works

Claude Code decides the TTL of every request in one place, reading its
environment afresh each time. The first source that is set wins:

| # | Source | Main chat | Sub-agents |
| --- | --- | --- | --- |
| 1 | `FORCE_PROMPT_CACHING_5M` | 5m | 5m |
| 2 | Environment variable, `5m` or `1h` | `CLAUDE_CODE_PROMPT_CACHE_TTL` | `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` |
| 3 | Setting | `promptCacheTtl` | `subagentPromptCacheTtl` |
| 4 | Agent frontmatter `experimental: { cacheTtl }` | the agent's | the agent's |
| 5 | `ENABLE_PROMPT_CACHING_1H` | 1h | 1h |
| 6 | Automatic | 1h on a subscription within its limits; 5m on an API key, Bedrock, Vertex or Foundry | 5m for a built-in sub-agent, measured on a subscription with Claude Code 2.1.283 |

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

An option applies once, when the session starts, and never over a variable
already set at launch (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h claude` keeps 1h).
A bad value is ignored, and `/cache` names it.

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

Work lands on `develop`; `main` holds only releases, and each one is tagged `cache-live-control--vX.Y.Z` with its notes in [CHANGELOG.md](./CHANGELOG.md). Pull requests go to `develop`.

`plugins/cache-live-control/hooks/cache-live-control.ts` is a thin adapter over `plugins/cache-live-control/src/`:

| Module | Role |
| --- | --- |
| `ttl.ts` | The TTL values, the two parties and their variables |
| `parse.ts` | `/cache` arguments to an action |
| `status.ts` | Each party's TTL and source, and the lines `/cache` prints |
| `options.ts` | The `mainTtl` / `subagentTtl` options and what they set at session start |

## 🎓 Built with Professor

cache-live-control is built and maintained with [Professor](https://github.com/rezzminator/professor), a fleet controller and discipline layer for Claude Code, Codex and OpenCode: chats that message each other, agents held to the project's rules, and gated releases. Professor runs long orchestrations of sub-agents, and choosing their cache TTL per chat is where this plugin came from.

## License

MIT

<sub>Keywords: Claude Code prompt cache TTL · prompt caching 1 hour · 5 minute cache · CLAUDE_CODE_PROMPT_CACHE_TTL · CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL · promptCacheTtl · subagentPromptCacheTtl · ENABLE_PROMPT_CACHING_1H · FORCE_PROMPT_CACHING_5M · sub-agent cache · Claude Code plugin · function hooks · Claude Mods · token cost</sub>
