# Changelog

Every release of cache-live-control. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `cache-live-control--v<version>`, with a GitHub release carrying the section below.

## [0.4.0] — 2026-10-11

### Added
- `raiseAfterExpiries` option (a whole number of 1 or more; empty = off, the default): a main chat at 5m whose cache has expired at the start of its Nth turn (the previous main request was at 5m and is 5 minutes old or more) sends that turn's request at 1h and stays at 1h for the rest of the session. The sub-agents' variable is never touched; a main chat already at 1h, or `FORCE_PROMPT_CACHING_5M`, changes nothing. `/cache main …` resets the count and `/cache main 5m` switches the raise off for the session; `/clear` starts the count again but keeps a typed `/cache main 5m` and a fired raise. A bad value is ignored and named by `/cache`.
- `/cache` prints an auto-raise segment: off, counting (`1 of 2 expiries`), fired (`3m ago`), idle, off after `/cache main 5m`, inactive under `FORCE_PROMPT_CACHING_5M`, or failed (`the TTL may be unchanged` for the write or a read of the clock or the environment; `failed` alone for the restart of the count after a compaction or `/clear`). Each failure goes away once that kind works again, never through another; a failed count restart after the raise fired or was switched off is not shown.
- With `ttlNotice` on, the note on a prompt that wakes an expired cache names the TTL the request goes out at (the raise is weighed before the note, and that verdict is final for the turn that prompt starts; a prompt that did not enter, or whose weighing could not read, leaves the turn to be weighed when it starts). A wake that carries no prompt of yours gets the note when it passes through the prompt hook (a background task's or sub-agent's return); a wake the plugin itself injects fires no prompt hook, so no hook can carry a note into it, and the next prompt you type carries it.

- Sub-agent cache protection, every piece off by default and set live by `/cache` words (`raise N|off`, `agents raise N|off`, `agents waiting on|off`, `guard off|warn|block`, `guard floor N|Nk`, `guard price N|off`, `handoff on|off`, in any order and mixed with TTL groups):
  - Per-agent records: the latest request, the TTL it was written at, the context (input + cache read + cache creation + output) and the expired-request count of each sub-agent, bounded.
  - Cold-resume guard (`resumeGuard` off|warn|block, `resumeGuardMinTokens` default 60000, `resumeGuardPrice` optional): a `SendMessage` to a cold sub-agent whose context is above the floor is warned about or blocked, naming the gap, the context and the rewrite in tokens × the write multiplier (dollars only when a price is set, and the handoff file when one exists). A message beginning with `[resume-anyway]` is sent with the marker removed, whatever the guard says. A warm, small or running target, or one never seen, passes silently.
  - Agents' auto-raise to 1h (`agentRaiseWaiting`, `agentRaiseAfterExpiries`), an explicit opt-in that holds `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` at 1h for every sub-agent while an agent that launched background work waits (or one whose own cache expired N times lives), then hands back the prior value. A per-agent raise races (measured on 2.1.296: a value set around one agent's request reached 5 of 9 requests of other agents), so the raise is shared and its cost, 2× writes for all sub-agents meanwhile, is documented. A typed `/cache agents …` outranks it; `FORCE_PROMPT_CACHING_5M` stops it; the main variable is never touched.
  - Handoff (`handoff`, `handoffDir`, an absolute path): a spawned sub-agent is asked to write a handoff file before its final answer, named by its spawn call's id; the guard points to it.
  - `/cache` shows `agent-raise`, `resume-guard` and `handoff` segments and the recent events.

### Changed
- `npm run live` gains two phases that read the sub-agents' cache-write buckets from their transcripts: (h) a sub-agent that launches a background child writes the request that ends its turn at 1h (`agentRaiseWaiting`) and its wake reads that cache, and (i) the guard (`block`) refuses a `SendMessage` to a cold worker, passes one beginning `[resume-anyway]` with the marker removed, and passes one to the now warm worker.
- `/cache` status lines gain the segments `agent-raise …`, `resume-guard …` and `handoff …` after `auto-raise …`.
- `npm test` also runs hook tests on a copy of the plugin whose option defaults are set per test variant (`hook-tests/`, `scripts/test-hook-variants.sh`), since the test kit cannot pass options. The adapter reads time from `$.clock`, so hook tests can move it.

## [0.3.1] — 2026-10-02

### Added
- `ttlNotice` option (opt-in, off by default): the main chat's first prompt, and the first one after its TTL changes or the chat compacts or `/clear`s, carries a note the model reads and the user never sees, ordering how to work on the main TTL (1h: delegate any task past about 30 tool calls and wait for its return; 5m: work directly and keep every wait under 4 minutes). Sub-agents never get it.

## [0.3.0] — 2026-10-01

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

[Unreleased]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.3.0...develop
[0.3.0]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.2.0...cache-live-control--v0.3.0
[0.2.0]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.1.0...cache-live-control--v0.2.0
[0.1.0]: https://github.com/rezzminator/cache-live-control/releases/tag/cache-live-control--v0.1.0
