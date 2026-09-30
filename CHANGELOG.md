# Changelog

Every release of cache-live-control. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `cache-live-control--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

### Added
- Order-free `/cache` words: parties (`main`, `agents` and its spellings `agent`, `subagents`, `sub-agents`, `both`, `all`) and TTLs (`5m`, `1h`, `auto`) in any order, several groups in one command (`/cache main 1h agents 5m`, `/cache 1h main 5m agents`, `/cache main 1h, agents 5m`). Every earlier form still parses.
- Warm-cache warning: a switch of a party whose cache is still warm applies at once and says so in one line (`switched; main's cache was warm (41m left), the next request may rewrite it: main 5m · agents 1h`), since the next request may write the whole cache again (measured on 2.1.285: 11 of 12 warm switches kept the cache; the one rewrite was a raise to 1h that did not repeat); mid-turn, Claude Code draws a command's reply only once the turn ends, so the warning also shows at once as a toast.
- Launcher handoff: `CACHE_LIVE_CONTROL_MAIN_TTL` and `CACHE_LIVE_CONTROL_AGENTS_TTL` set a session's starting TTLs (`5m`, `1h` or `auto`), after a TTL variable set at launch and before the options, and are unset once read.
- `/cache` status shows each party's warmth (`warm 41m`, `cold`).

## [0.2.0] — 2026-09-27

### Changed
- Sub-agents default to 5m. `ENABLE_PROMPT_CACHING_1H=1` at launch turned 1h on for every sub-agent as well as the main chat, billing each sub-agent cache write at 2× input instead of 1.25×. At session start the plugin now keeps that 1h for the main chat only (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`, unless already set) and unsets `ENABLE_PROMPT_CACHING_1H`; a sub-agent runs 5m unless `subagentPromptCacheTtl`, its own frontmatter or `/cache agents 1h` raises it. `/cache main auto` returns the main chat to the launch 1h, and `/cache` names `ENABLE_PROMPT_CACHING_1H` whenever it is still set. Nothing to migrate: to keep sub-agents at 1h, set `subagentTtl` to `1h`.

## [0.1.0] — 2026-09-27

### Added
- `/cache`: the prompt-cache TTL of one chat, `5m`, `1h` or automatic, for the main chat (`/cache main …`), its sub-agents (`/cache agents …`) or both, from the next request and with no model turn. `/cache` alone shows each TTL and where it comes from.
- Options `mainTtl` and `subagentTtl`: the TTL a session starts with.

[Unreleased]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.2.0...develop
[0.2.0]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.1.0...cache-live-control--v0.2.0
[0.1.0]: https://github.com/rezzminator/cache-live-control/releases/tag/cache-live-control--v0.1.0
