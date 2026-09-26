# Changelog

Every release of cache-live-control. Versions follow [semantic versioning](https://semver.org); each release is the `main` commit tagged `cache-live-control--v<version>`, with a GitHub release carrying the section below.

## [Unreleased]

## [0.1.0] — 2026-09-27

### Added
- `/cache`: the prompt-cache TTL of one chat, `5m`, `1h` or automatic, for the main chat (`/cache main …`), its sub-agents (`/cache agents …`) or both, from the next request and with no model turn. `/cache` alone shows each TTL and where it comes from.
- Options `mainTtl` and `subagentTtl`: the TTL a session starts with.

[Unreleased]: https://github.com/rezzminator/cache-live-control/compare/cache-live-control--v0.1.0...develop
[0.1.0]: https://github.com/rezzminator/cache-live-control/releases/tag/cache-live-control--v0.1.0
