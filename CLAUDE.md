# cache-live-control

A Claude Code function-hooks plugin: `/cache` sets this chat's prompt-cache
TTL for the main chat and sub-agents by setting Claude Code's TTL variables
in its own process, and keep-warm (`/keepwarm`) sends a visible poke before
the cache expires while the main chat or a waiting sub-agent waits on tracked
background work, at most `keepwarmMaxPokes` per unchanged wait, each admitted
by a budget forecast against the rewrite it saves. `README.md` is the
behavioural spec.

## Layout

- `plugins/cache-live-control/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it; `tests/` there is the exception `claude plugin test` requires.
- `plugins/cache-live-control/hooks/plugin.ts`: the one hooks module `hooks.json` loads; it calls `registerCache` and `registerKeepwarm` and registers the events both hook.
- `plugins/cache-live-control/hooks/cache-live-control.ts`: the TTL control's adapter; `plugins/cache-live-control/hooks/keepwarm.ts` keep-warm's; `plugins/cache-live-control/hooks/keepwarm-state-file.mjs` the session state file writer, run as a child of Claude Code.
- `plugins/cache-live-control/src/`: every decision, pure and unit-tested; root `tests/` holds one vitest file per concern.
- `plugins/cache-live-control/src/keepwarm/`: keep-warm's decisions, one concept per file; `decision.ts` is the one fire decision and `budget.ts` the one producer of spend, allowance and ledger.
- `tests/keepwarm/`: one same-stem vitest file per `plugins/cache-live-control/src/keepwarm/` file; the adapter tests run over the stand-in `$` in `tests/keepwarm/stand-in.ts`, the live-checker tests over `tests/keepwarm/live-fixtures.ts`.
- `plugins/cache-live-control/tests/`: the function-hook tests on the `claude-code/testing` kit; `hook-tests/{variant}/` runs more of them under a variant's option defaults (`scripts/test-hook-variants.sh`).
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/cache-live-control/.claude-plugin/`: `plugin.json` (manifest, `userConfig`) and `icon.svg`; the plugin installs as `cache-live-control@professor`.
- `scripts/keepwarm-live-proof.sh`: keep-warm's live lanes, over `scripts/keepwarm-live-proof.py` and its checker `scripts/keepwarm-live-check.py`.
- `THIRD-PARTY-NOTICES`: the licences of keep-warm's two credited predecessors.

## Commands

- `npm test` (vitest, `claude plugin test`, then `scripts/test-hook-variants.sh`), `npm run typecheck`, `npm run validate:plugin` and `npm run check:structure` all pass before a commit; the hook tests and validation need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, and a machine without `claude` on `PATH` reports them `NOT RUN`, never passed.
- `tests/keepwarm/live-launch.test.ts` drives a real `tmux` server and finds the lane's processes through `/proc` on Linux, `ps -E` on macOS; it skips without `tmux`.
- `npm run check:structure` (`scripts/keepwarm-check-structure.mjs`) scans every tracked, untracked and staged file for machine-absolute paths and email addresses, and holds keep-warm's structure: `plugins/cache-live-control/src/keepwarm/` pure (no `$`, type-only imports), no `professor` or `pfm` in keep-warm's code, `plugins/cache-live-control/hooks/keepwarm.ts` at most 500 lines, each `plugins/cache-live-control/src/keepwarm/` and `tests/keepwarm/` file at most 300.
- `make release-check` runs every check `ci.yml` runs on a `develop → main` pull request, the same make targets (`check`, `release`) under Node 22.
- `npm run live` (`scripts/live-proof.sh`) drives a real Haiku session in tmux with `--plugin-dir plugins/cache-live-control` (options key `cache-live-control@inline`) and proves each TTL from the transcript's cache-write buckets; run it after any change to `plugins/cache-live-control/hooks/cache-live-control.ts` or `plugins/cache-live-control/hooks/plugin.ts`.
- `npm run live:keepwarm -- --lane {state|wait-return|cap|subagent-wait|ttl-1h|collision|stale}|--all --cwd <trusted-dir> --auto-effort-dir <path> --output <outside-repo-path>`: a real Haiku chat per lane on Claude Code 2.1.316, the plugin loaded through `CLAUDE_CODE_PLUGIN_DIRS`; `--all` is wait-return, cap, collision and stale; `state` takes no `--auto-effort-dir`; `--claude <binary>` names the Claude Code binary a `claude` launcher wraps. Run it after any change to `plugins/cache-live-control/hooks/keepwarm.ts`, `plugins/cache-live-control/hooks/plugin.ts` or `plugins/cache-live-control/src/keepwarm/`.

## Keep-warm live lanes

- The harness needs `node`, `npm`, `claude`, `python3`, `tmux`, the seat's existing configuration and a `--cwd` with its own exact trust entry; Claude Code inherits no trust into subdirectories, so the checkout is usually untrusted, and a run held at the folder-trust prompt is `NOT RUN`, never bypassed.
- A missing need prints `ERROR {need}` and exits 2; a lane not run reads `NOT RUN`; an API or auth error, a real compaction of the lane's main session, or a prefix rewritten mid-lane (`prefix_kept()`) reads `VOID`, never a measured failure, and a voided lane counts toward no publish bar.
- `compactions()` in `scripts/keepwarm-live-check.py` records without voiding a `precompute` row, a sub-agent's (`agentId`), or one whose `outcome` is `skipped` or `failed`; a row missing its `trigger` or `outcome` voids.
- A lane stays below the seat's auto-compact window, and its launch prompt under 131,072 bytes, the single-argument limit.
- No plugin, setting or seat change runs on the machine during a lane: a plugin reload re-renders the environment block in `messages[1]`.
- Evidence goes to `--output` or a temporary directory outside the repository, never into it.
- A lane reads the chat's session state JSON (`session_state()`), never a pane capture; a poke turn (`poke_turns()`) is the plugin's own traffic, its text checked exactly.
- Every lane chat is killed at the end, pass or fail, and its session moved into `{output}/sessions-retired/` (`retire_sessions()`); a failed kill or move prints `CLEANUP FAILED {session}` and exits 2.
- SIGTERM, SIGHUP or SIGINT still runs each lane's cleanup (`stop_on_signals()`), starts no later lane, prints `STOPPED live: signal {n} in {mode}; later lanes not run` and exits 128+n; SIGKILL leaves the chats running: `ls "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)" | grep '^kw-'`, then `tmux -L {socket} kill-server` for each.
- Publish-ready needs three clean serial `--all` sequences plus one clean `--lane ttl-1h` (about 70 minutes, never part of `--all`), all on the final tree; fewer is a named gap, and a gate not watched running is never reported as run.

## Rules

- **Credentials stay in the seat:** a live run uses the invoking user's own Claude configuration. NEVER copy a credentials file and NEVER create an alternate `CLAUDE_CONFIG_DIR`; isolation is the lane's working directory and plugin directory.
- A new behaviour lands in `plugins/cache-live-control/src/` (keep-warm's in `plugins/cache-live-control/src/keepwarm/`) as a pure function with a test watched failing first; the adapters only wire it.
- An event both adapters hook under one matcher is registered once, in `plugins/cache-live-control/hooks/plugin.ts`, the TTL control outermost and keep-warm inside: Claude Code loads one hooks module per plugin and refuses an event registered twice under one matcher.
- A failed read or write of a variable prints a `failed, the TTL may be unchanged` line; it never claims a TTL it did not set.
- Every option is also a variable `CACHE_LIVE_CONTROL_{OPTION}`, upper snake, listed in the README configuration table: variable > option (`pluginConfigs`, `/config`) > default; unset or blank is absent; booleans `1|0|true|false`, any case. `CACHE_LIVE_CONTROL_MAIN_TTL` and `CACHE_LIVE_CONTROL_SUBAGENT_TTL` (`CACHE_LIVE_CONTROL_AGENTS_TTL` its earlier name) also take `auto` and are unset at session start.
- A bad option or variable is named by `/cache` (a keep-warm one by `/keepwarm` and the status line) and the option's default applies, never the configured option.
- A new option adds its variable to `ENV` (`plugins/cache-live-control/src/options.ts`) and its adapter's `readOptionEnv`, its `userConfig` key, its README row and its row in `tests/options.test.ts`, a keep-warm one also in `tests/keepwarm/options.test.ts`.
- Claude Code's TTL variables (`CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and the rest) are Claude Code's own, set by `/cache` and read by keep-warm, never plugin options. Claude Code's `subagentPromptCacheTtl` setting is invisible to a plugin: keep-warm times such a sub-agent as 5m, early, never late.
- `decision.ts` owns every fire, skip and stop, each with a stable reason code; `plugins/cache-live-control/hooks/keepwarm.ts` holds no policy condition that duplicates it.
- Spend, allowance, protected rewrite and estimated net come from `budget.ts` only; the session state JSON, `/keepwarm`, the log and the closing line render those numbers. Costs are input-token equivalents; no USD without a verified engine price; a closing net saving is labelled an estimate; unknown usage is unknown, never zero.
- Wait timing comes from structured facts only; an unknown ETA is `unknown`, never inferred from task or command text.
- A label enters the poke text only through `sanitizeLabel` (`plugins/cache-live-control/src/keepwarm/waits.ts`), and never the log, a reason code or the session state JSON.
- The poke text is `pokeMessage` (`plugins/cache-live-control/src/keepwarm/status.ts`); a change to it moves `POKE_FOOTER` in `scripts/keepwarm-live-check.py` with it.
- A poke is a real request of its thread, so it re-anchors at that thread's own lifetime; the main chat's poke goes through `$.prompt.submit`, and its turn, `turn.start` to `turn.complete`, charges its usage once.
- A poke counter is keyed per thread by the sorted set of pending ids (`pokeKey`, `plugins/cache-live-control/src/keepwarm/pokes.ts`); a poke and its reply never reset it, real activity always does.
- A main-chat `session.compact` inside the plugin's own poke turn keeps the episode, its poke count and ledger; any other main-chat compaction ends it, a `precompute` one resets nothing, a sub-agent's resets only that agent (`compactReset`, `plugins/cache-live-control/src/keepwarm/compact.ts`).
- Persistence restores only validated last-use and numeric ledger metadata for the same session id, never the `/keepwarm` override, a timer, an admission or a grant; a refused record or a failed store is shown, never silent.
- The session state file is status-line readers' contract: `{dir}/{sessionId}.json`, `dir` being `CACHE_LIVE_CONTROL_KEEPWARM_STATE_DIR` (the sessions directory itself), else `$XDG_STATE_HOME/cache-live-control/keepwarm/sessions`, else `$HOME/.local/state/cache-live-control/keepwarm/sessions`, an absolute path only (`stateDirectory`), schema `v: 1` (`sessionState`, both in `plugins/cache-live-control/src/keepwarm/status.ts`); a change to the path or a field moves README § Session state JSON with it.
- The 1h cache is admitted (`WARM_1H = true` in `plugins/cache-live-control/src/keepwarm/schedule.ts`), measured by `--lane ttl-1h` on Claude Code 2.1.316; on a release not re-measured the claim stays labelled "measured on 2.1.316", and a failed rerun sets `WARM_1H = false`, the status reading `not warming: 1h refresh unproven`.
- `$` is passed only to functions declared at the top level of a hooks file (`plugins/cache-live-control/hooks/plugin.ts`, `plugins/cache-live-control/hooks/cache-live-control.ts`, `plugins/cache-live-control/hooks/keepwarm.ts`) and always spelled `$.noun.event(...)`, and `$.env` names are string literals: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.
- Keep-warm's one glossary in code, tests and docs: wait, waiting item, episode, poke, request, epoch, send anchor, poke limit; no "ping", "keepalive" or "job".
- A claim about Claude Code's behaviour in the README, the precedence table and keep-warm's measurements included, states what was measured; a claim not re-measured on a new Claude Code release is labelled so.
- A version bump moves `plugins/cache-live-control/.claude-plugin/plugin.json`, `package.json` and the README badge together; installed copies update only on a new version.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file; `npm run check:structure` scans for them.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and no CI runs on a push. `.github/workflows/ci.yml` runs on the `develop → main` pull request only, and `.github/workflows/publish.yml` on its merge. `develop` is protected by the ruleset `develop keeps its history`: never force-push or delete it.
- `main` is release-only (ruleset `main is release-only`). It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history, and only after its `ci` check passes: never a direct push, never an admin override. Professor's marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in every place the version-bump rule under § Rules names, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. Every merge into `main` publishes, so a pre-release suffix (`-dev.N`, `-alpha`) becomes the real release version here.
  2. `make release-check` passes, after `git fetch origin main`.
  3. Open the `develop → main` pull request. Its `ci.yml` runs the same make targets, `check` on Linux and macOS and `release`, and its `ci` job passes only when every one succeeded; `release` requires the version to have moved past `main`'s and the CHANGELOG section to yield notes.
  4. Merge once `ci` is green. The merge is the release: `publish.yml`'s `publish` job tags the merge commit `cache-live-control--vX.Y.Z` and publishes the GitHub release from the CHANGELOG section. No tag is pushed by hand.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option or argument is a major, and its CHANGELOG entry says how to migrate.
- Publishing: code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
