# cache-live-control

A Claude Code function-hooks plugin: `/cache` sets this chat's prompt-cache
TTL for the main chat and sub-agents by setting Claude Code's TTL variables
in its own process. `README.md` is the behavioural spec.

## Layout

- `plugins/cache-live-control/`: everything that installs, and nothing else — the directory scans only this folder, so dev files never go in it; `tests/` there is the exception `claude plugin test` requires.
- `plugins/cache-live-control/hooks/cache-live-control.ts`: the adapter, the only file that touches `$`.
- `plugins/cache-live-control/src/`: every decision, pure and unit-tested; root `tests/` holds one vitest file per concern, `plugins/cache-live-control/tests/` the function-hook tests on the `claude-code/testing` kit.
- `types/claude-code.d.ts`: the plugin API (from `/plugin-types`), the truth for every hook's shape; grep it before using an event.
- `plugins/cache-live-control/.claude-plugin/`: `plugin.json` (manifest, `userConfig`) and `icon.svg`; the root `.claude-plugin/marketplace.json` makes the repo its own marketplace.

## Commands

`npm test` (vitest and `claude plugin test`), `npm run typecheck` and `npm run validate:plugin` all pass before a commit; the hook tests and validation need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. `npm run live` (`scripts/live-proof.sh`) drives a real Haiku session in tmux with `--plugin-dir plugins/cache-live-control` (options key `cache-live-control@inline`) and proves each TTL from the transcript's cache-write buckets; run it after any change to the adapter.

## Rules

- A new behaviour lands in `plugins/cache-live-control/src/` as a pure function with a test watched failing first; the adapter only wires it.
- A failed read or write of a variable prints a `failed, the TTL may be unchanged` line; it never claims a TTL it did not set.
- A bad option is ignored by name, and `/cache` shows it.
- The precedence table in the README states Claude Code's behaviour as measured; a claim not re-measured on a new Claude Code release is labelled so.
- A version bump moves `plugins/cache-live-control/.claude-plugin/plugin.json`, `marketplace.json`, `package.json` and the README badge together; installed copies update only on a new version.
- Public repo: no machine-absolute paths, personal data or private project names in a tracked file.
- `$` is passed only to functions declared at the top level of the hooks file and always spelled `$.noun.event(...)`, and `$.env` names are string literals: Claude Code checks this statically and otherwise loads the module with zero hooks. `npm run validate:plugin` catches it.

## Branches and releases

- `develop` is the default branch: every change lands there, by a commit or a pull request, and CI (`.github/workflows/ci.yml`) runs the three gates on it.
- `main` is release-only. It moves only by merging the `develop → main` pull request, with a merge commit and never a squash, so both branches share one history. The marketplace installs the plugin from `main` (`git-subdir`, `ref: main`), so users only ever get a released version.
- A release, in order:
  1. On `develop`: bump the version in all four places, and move `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — date`. `npm run release:check` passes.
  2. Open the `develop → main` pull request. Its `release` check requires the version to have moved past `main`'s.
  3. Merge once CI is green.
  4. On `main`: `claude plugin tag --push plugins/cache-live-control` creates and pushes `cache-live-control--vX.Y.Z`. `release.yml` then publishes the GitHub release from the CHANGELOG section.
- Semantic versioning: a fix is a patch; a new option or behaviour is a minor; a renamed or removed option or argument is a major, and its CHANGELOG entry says how to migrate.
- Publishing: README and marketing changes on `develop` are pushed as soon as they are committed. Code is pushed, and a release is cut, only when the owner asks.
- Git writes go through this repo's gitter, `.claude/agents/gitter.md`.
