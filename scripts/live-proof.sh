#!/usr/bin/env bash
# Live proof: drives a real interactive Claude Code session (Haiku) in tmux on
# a private socket, with this checkout loaded by --plugin-dir, and reads the
# cache-write buckets of each request from the transcripts:
#   option  the mainTtl option ("5m") applies at session start
#   (a)     /cache main flips the main chat 5m -> 1h -> 5m -> 1h
#   (b)     /cache agents 1h, then 5m, moves a sub-agent's requests while main stays 1h
#           (S0 records the sub-agents' automatic TTL, for information)
#   (c)     /cache (status) prints a line and starts no model turn
#   (d)     a second session launched with ENABLE_PROMPT_CACHING_1H=1 and no
#           options: the main chat keeps 1h, a sub-agent writes 5m
# Prints a table, one row per check, and exits 1 when any check fails,
# 2 when the session could not be driven (no transcript, a turn timed out).
# Spends real tokens: a few cents of Haiku.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The native binary, not a launcher script: a wrapper can set variables of its
# own (FORCE_PROMPT_CACHING_5M) that would mask every TTL this proves.
if [ -z "${CLAUDE_BIN:-}" ]; then
  CLAUDE_BIN=$(command -v claude)
  if file -L -b "$CLAUDE_BIN" 2>/dev/null | grep -q text; then
    CLAUDE_BIN=$(ls -d "$HOME"/.local/share/claude/versions/* 2>/dev/null | sort -V | tail -1)
  fi
fi
[ -x "$CLAUDE_BIN" ] && ! file -L -b "$CLAUDE_BIN" | grep -q text || { echo "ERROR no native claude binary found (set CLAUDE_BIN)"; exit 2; }
command -v tmux >/dev/null || { echo "ERROR tmux not found"; exit 2; }
command -v jq >/dev/null || { echo "ERROR jq not found"; exit 2; }

RUN=/tmp/cache-live-control/run-$(date +%Y%m%dT%H%M%S)
WORK=$RUN/work
mkdir -p "$WORK"
# Plugin options through --settings: the --plugin-dir copy's key is <name>@inline.
cat > "$RUN/settings.json" <<'EOF'
{ "pluginConfigs": { "cache-live-control@inline": { "options": { "mainTtl": "5m" } } } }
EOF
ID=$(uuidgen | tr 'A-Z' 'a-z')
PROJECTS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
T="tmux -L cache-live-control"
LOG=$RUN/drive.log
log() { echo "$(date +%T) $*" >> "$LOG"; }
echo "run dir: $RUN  session: $ID"

# One session: $1 the session id, $2 variable assignments for the launch
# (every TTL variable is unset first), $3 the --settings file.
start() {
  $T kill-session -t proof 2>/dev/null
  $T new-session -d -s proof -x 200 -y 50 -c "$WORK" \
    "env -u ENABLE_PROMPT_CACHING_1H -u FORCE_PROMPT_CACHING_5M -u CLAUDE_CODE_PROMPT_CACHE_TTL -u CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL \
     $2 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 '$CLAUDE_BIN' --model haiku --setting-sources project --settings '$3' \
     --plugin-dir '$ROOT/plugins/cache-live-control' --session-id $1"
  # Boot: the trust dialog defaults to "No, exit", so Down then Enter.
  for _ in $(seq 1 30); do
    sleep 1
    pane=$($T capture-pane -p -t proof)
    if grep -q -i 'trust' <<<"$pane"; then $T send-keys -t proof Down; sleep 1; $T send-keys -t proof Enter; log "trust accepted"; sleep 3; fi
    if grep -q -E 'Enter to confirm' <<<"$pane"; then $T send-keys -t proof Enter; log "confirm accepted"; sleep 3; fi
    grep -q -E '^ *(>|❯) ' <<<"$pane" && ! grep -q -i -E 'trust|Enter to confirm' <<<"$pane" && break
  done
  $T capture-pane -p -t proof > "$RUN/boot-$1.txt"
}
trap '$T capture-pane -p -t proof -S -300 > "$RUN/pane.txt" 2>/dev/null; $T kill-server 2>/dev/null' EXIT
start "$ID" "" "$RUN/settings.json"

transcript() { find "$PROJECTS" -maxdepth 2 -name "$ID.jsonl" 2>/dev/null | head -1; }
count() { local f; f=$(transcript); [ -n "$f" ] && grep -c "$1" "$f"; [ -n "$f" ] || echo 0; }
send() { $T send-keys -t proof -l "$1"; sleep 1; $T send-keys -t proof Enter; log "<- $1"; }
# Wait until the transcript's assistant text holds the label, or fail loudly.
turn() {
  send "$1"
  for _ in $(seq 1 ${3:-90}); do
    sleep 2
    f=$(transcript)
    [ -n "$f" ] && jq -e --arg l "$2" 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | select(.text|contains($l))' "$f" >/dev/null 2>&1 && { log "done $2"; return 0; }
  done
  echo "ERROR turn $2 did not finish; pane in $RUN/pane.txt"; exit 2
}
# A slash command: wait for its output row in the transcript.
command_row() {
  local before; before=$(count 'local-command-stdout')
  send "$1"
  for _ in $(seq 1 20); do sleep 1; [ "$(count 'local-command-stdout')" -gt "$before" ] && { log "done $1"; return 0; }; done
  echo "ERROR $1 printed no output row; pane in $RUN/pane.txt"; exit 2
}

turn "Reply with exactly: T1" T1
command_row "/cache main 1h"
grep -q 'warning: FORCE_PROMPT_CACHING_5M' "$(transcript)" && { echo "ERROR the session has FORCE_PROMPT_CACHING_5M set, which masks every TTL; launch a binary that does not set it (CLAUDE_BIN)"; exit 2; }
turn "Reply with exactly: T2" T2
command_row "/cache main 5m"
turn "Reply with exactly: T3" T3
command_row "/cache main 1h"
turn "Reply with exactly: T4" T4
asst_before=$(count '"type":"assistant"')
command_row "/cache"
sleep 8
asst_after=$(count '"type":"assistant"')
turn "Call the Agent tool once, subagent_type general-purpose, prompt: Reply with exactly: S0. Then reply with exactly: T5" T5 120
command_row "/cache agents 1h"
turn "Call the Agent tool once, subagent_type general-purpose, prompt: Reply with exactly: S1. Then reply with exactly: T6" T6 120
command_row "/cache agents 5m"
turn "Call the Agent tool once, subagent_type general-purpose, prompt: Reply with exactly: S2. Then reply with exactly: T7" T7 120

F=$(transcript)
[ -n "$F" ] || { echo "ERROR no transcript for $ID under $PROJECTS"; exit 2; }
cp "$F" "$RUN/main.jsonl"
SUB=$(dirname "$F")/$ID/subagents
[ -d "$SUB" ] && cp -R "$SUB" "$RUN/subagents"

# The cache-write buckets of one file's requests, per label (the last user
# prompt's "exactly: X"), each message id once: "T1 5m", "T2 1h", ...
buckets() {
  jq -r -s '
    reduce .[] as $r ({label: "-", seen: {}, out: []};
      if $r.type == "user" and ($r.message.content | type) == "string" and ($r.message.content | test("exactly: [A-Z][0-9]"))
        then .label = ([$r.message.content | scan("exactly: ([A-Z][0-9])")] | last | .[0])
      elif $r.type == "user" and ($r.message.content | type) == "array" and ([$r.message.content[]? | select(.type == "text") | .text | test("exactly: [A-Z][0-9]")] | any)
        then .label = ([$r.message.content[]? | select(.type == "text") | .text | scan("exactly: ([A-Z][0-9])")] | last | .[0])
      elif $r.type == "assistant" and $r.message.usage and (.seen[$r.message.id] | not)
        then .seen[$r.message.id] = true
           | ($r.message.usage.cache_creation // {}) as $c
           | .out += [.label + " " + (if ($c.ephemeral_1h_input_tokens // 0) > 0 and ($c.ephemeral_5m_input_tokens // 0) > 0 then "mixed"
                                      elif ($c.ephemeral_1h_input_tokens // 0) > 0 then "1h"
                                      elif ($c.ephemeral_5m_input_tokens // 0) > 0 then "5m" else "none" end)]
      else . end) | .out[]' "$1"
}
main_rows=$(buckets "$F")
echo "$main_rows" > "$RUN/main-buckets.txt"
sub_rows=""
for s in "$SUB"/*.jsonl; do [ -f "$s" ] && sub_rows+=$(buckets "$s")$'\n'; done
echo "$sub_rows" > "$RUN/sub-buckets.txt"

# (d) A launch with ENABLE_PROMPT_CACHING_1H=1 and no options.
echo '{}' > "$RUN/settings-launch1h.json"
ID=$(uuidgen | tr 'A-Z' 'a-z')
echo "launch-1h session: $ID"
start "$ID" "ENABLE_PROMPT_CACHING_1H=1" "$RUN/settings-launch1h.json"
turn "Call the Agent tool once, subagent_type general-purpose, prompt: Reply with exactly: S3. Then reply with exactly: T8" T8 120
command_row "/cache"
F2=$(transcript)
[ -n "$F2" ] || { echo "ERROR no transcript for $ID under $PROJECTS"; exit 2; }
cp "$F2" "$RUN/launch1h.jsonl"
SUB2=$(dirname "$F2")/$ID/subagents
launch_main_rows=$(buckets "$F2")
launch_sub_rows=""
for s in "$SUB2"/*.jsonl; do [ -f "$s" ] && launch_sub_rows+=$(buckets "$s")$'\n'; done
echo "$launch_main_rows" > "$RUN/launch1h-main-buckets.txt"
echo "$launch_sub_rows" > "$RUN/launch1h-sub-buckets.txt"

# Every write-bearing request of a label carries the expected bucket.
of() { grep "^$2 " <<<"$1" | awk '{print $2}' | grep -v '^none$' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
fail=0
row() { local name=$1 want=$2 got=$3; local v=PASS; [ "$got" = "$want" ] || { v=FAIL; fail=1; }; printf '| %-44s | %-6s | %-12s | %s |\n' "$name" "$want" "${got:-nothing}" "$v"; }
echo
echo "| check | want | got | verdict |"
echo "| --- | --- | --- | --- |"
row "option: T1 main (mainTtl=5m)" 5m "$(of "$main_rows" T1)"
row "(a) T2 main after /cache main 1h" 1h "$(of "$main_rows" T2)"
row "(a) T3 main after /cache main 5m" 5m "$(of "$main_rows" T3)"
row "(a) T4 main after /cache main 1h" 1h "$(of "$main_rows" T4)"
s0=$(of "$sub_rows" S0); printf '| %-44s | %-6s | %-12s | %s |\n' "(info) S0 sub-agent, agents automatic" "-" "${s0:-nothing}" "INFO"
row "(b) S1 sub-agent after /cache agents 1h" 1h "$(of "$sub_rows" S1)"
row "(b) T6 main beside it" 1h "$(of "$main_rows" T6)"
row "(b) S2 sub-agent after /cache agents 5m" 5m "$(of "$sub_rows" S2)"
row "(b) T7 main beside it" 1h "$(of "$main_rows" T7)"
row "(c) assistant rows across /cache" "+0" "+$((asst_after - asst_before))"
row "(d) T8 main, launched ENABLE_PROMPT_CACHING_1H=1" 1h "$(of "$launch_main_rows" T8)"
row "(d) S3 sub-agent beside it" 5m "$(of "$launch_sub_rows" S3)"
echo
echo "command output rows:"; jq -r 'select(.subtype=="local_command") | .content' "$F" "$F2" | grep -o 'local-command-stdout>[^<]*' | sed 's/^local-command-stdout>/  /'
echo "evidence: $RUN"
exit $fail
