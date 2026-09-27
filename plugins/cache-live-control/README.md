# cache-live-control

Change the prompt-cache TTL of one Claude Code chat, instantly and with no model turn:

```text
/cache                      the TTL of the main chat and the sub-agents, and where each comes from
/cache 5m | 1h | auto       both
/cache main 5m | 1h | auto  the main chat only
/cache agents 5m | 1h | auto  sub-agents only
```

`auto` hands the choice back to your settings, agent frontmatter and Claude Code's automatic TTL. Sub-agents default to 5m: an `ENABLE_PROMPT_CACHING_1H=1` launch keeps its 1h for the main chat only. The options `mainTtl` and `subagentTtl` set the TTL a session starts with.

It requires `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The full documentation, the precedence table and the cost note live in the repository: https://github.com/rezzminator/cache-live-control

Built and maintained with [Professor](https://github.com/rezzminator/professor).
