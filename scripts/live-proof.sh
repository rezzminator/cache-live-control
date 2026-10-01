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
#   (e)     a third session launched with the handoff CACHE_LIVE_CONTROL_MAIN_TTL=1h:
#           the first turn writes 1h; right after it, /cache main 5m switches at
#           once and warns that main's cache was warm; the next turn writes 5m
#   (f)     in that session, main back to 1h, then /cache main 5m typed while a
#           long main turn streams: the warning shows at once as a toast, on
#           a screen that still shows the turn running (every polled screen is
#           kept); the reply line shows too (Claude Code draws it once the turn
#           ends); the turn finishes normally, and the next main request writes 5m
#   premise the cost of a warm switch, recorded (INFO, not asserted): the cache
#           read of the first request after each switch
# The flips of (a) and (b) run on a warm cache, so they warn too; (a)'s
# middle one is order-free (/cache 5m main).
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
echo "run dir: $RUN  session: $ID  config: ${CLAUDE_CONFIG_DIR:-default}"

# Ends the proof session: its claude ignores the hangup a killed tmux session
# sends, so the pane's process and its children are stopped first.
end_session() {
  local pid
  pid=$($T display-message -p -t proof '#{pane_pid}' 2>/dev/null) || return 0
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  $T kill-session -t proof 2>/dev/null
}

# On exit: no process left running, and the run's sessions leave the session
# list (their project folder is named after $WORK), copied to $RUN/transcripts.
cleanup() {
  $T capture-pane -p -t proof -S -300 > "$RUN/pane.txt" 2>/dev/null
  end_session
  $T kill-server 2>/dev/null
  local d
  for d in "$PROJECTS"/*"${RUN##*/}"-work; do
    [ -d "$d" ] || continue
    cp -R "$d" "$RUN/transcripts" && rm -rf "$d" || echo "ERROR could not move $d to $RUN/transcripts"
  done
}

# One session: $1 the session id, $2 variable assignments for the launch
# (every TTL variable and launcher handoff variable is unset first), $3 the --settings file.
start() {
  end_session
  # CLAUDE_CONFIG_DIR is passed on explicitly: a tmux server keeps the
  # environment it started with, and the transcripts are read from it.
  $T new-session -d -s proof -x 200 -y 50 -c "$WORK" \
    "env -u ENABLE_PROMPT_CACHING_1H -u FORCE_PROMPT_CACHING_5M -u CLAUDE_CODE_PROMPT_CACHE_TTL -u CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL -u CACHE_LIVE_CONTROL_MAIN_TTL -u CACHE_LIVE_CONTROL_AGENTS_TTL \
     $2 ${CLAUDE_CONFIG_DIR:+CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR'} CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 '$CLAUDE_BIN' --model haiku --setting-sources project --settings '$3' \
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
trap cleanup EXIT
start "$ID" "" "$RUN/settings.json"

transcript() { find -H "$PROJECTS" -maxdepth 2 -name "$ID.jsonl" 2>/dev/null | head -1; }
count() { local f; f=$(transcript); [ -n "$f" ] && grep -c "$1" "$f"; [ -n "$f" ] || echo 0; }
send() { $T send-keys -t proof -l "$1"; sleep 1; $T send-keys -t proof Enter; log "<- $1"; }
# Wait until the transcript's assistant text holds the label, or fail loudly.
wait_label() {
  for _ in $(seq 1 ${2:-90}); do
    sleep 2
    f=$(transcript)
    [ -n "$f" ] && jq -e --arg l "$1" 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | select(.text|contains($l))' "$f" >/dev/null 2>&1 && { log "done $1"; return 0; }
  done
  echo "ERROR turn $1 did not finish; pane in $RUN/pane.txt"; exit 2
}
turn() { send "$1"; wait_label "$2" "${3:-90}"; }
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
command_row "/cache 5m main"
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

# The cache-write buckets of one file's requests, per label (the user
# prompt's "exactly: X"), each message id once: "T1 5m", "T2 1h", ...
# $2 picks the label: "last" for the main chat, "first" for a sub-agent, whose
# prompt can carry the parent's whole instruction ("S3. Then ... T8").
buckets() {
  jq -r -s --arg pick "${2:-last}" 'def pick: if $pick == "first" then first else last end;

    reduce .[] as $r ({label: "-", seen: {}, out: []};
      if $r.type == "user" and ($r.message.content | type) == "string" and ($r.message.content | test("exactly: [A-Z][0-9]+"))
        then .label = ([$r.message.content | scan("exactly: ([A-Z][0-9]+)")] | pick | .[0])
      elif $r.type == "user" and ($r.message.content | type) == "array" and ([$r.message.content[]? | select(.type == "text") | .text | test("exactly: [A-Z][0-9]+")] | any)
        then .label = ([$r.message.content[]? | select(.type == "text") | .text | scan("exactly: ([A-Z][0-9]+)")] | pick | .[0])
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
for s in "$SUB"/*.jsonl; do [ -f "$s" ] && sub_rows+=$(buckets "$s" first)$'\n'; done
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
for s in "$SUB2"/*.jsonl; do [ -f "$s" ] && launch_sub_rows+=$(buckets "$s" first)$'\n'; done
echo "$launch_main_rows" > "$RUN/launch1h-main-buckets.txt"
echo "$launch_sub_rows" > "$RUN/launch1h-sub-buckets.txt"

# The command output rows of a transcript, oldest first.
outputs() { jq -r 'select(.subtype=="local_command") | .content' "$@" | grep -o 'local-command-stdout>[^<]*' | sed 's/^local-command-stdout>//'; }

# (e) A launch with the handoff variable, then a switch of its warm cache.
ID=$(uuidgen | tr 'A-Z' 'a-z')
echo "handoff session: $ID"
start "$ID" "CACHE_LIVE_CONTROL_MAIN_TTL=1h" "$RUN/settings-launch1h.json"
turn "Reply with exactly: T9" T9
command_row "/cache"
command_row "/cache main 5m"
e_out=$(outputs "$(transcript)" | grep -v '^ *$' | tail -1)
turn "Reply with exactly: T10" T10

# (f) /cache typed while a main turn streams. The marker that shows a turn
# running: the "esc to interrupt" hint (idle, the footer reads "? for
# shortcuts"), else the spinner line ("✻ Word…"). The pane keeps no
# scrollback and (e)'s reply reads the same, so the new reply line is one
# below the counting prompt's line (or with that line scrolled away, which
# takes every earlier line with it). The toast alone reads "— now main 5m".
# Every polled screen is kept.
running_marker() {
  if grep -q 'esc to interrupt' <<<"$1"; then echo 'esc to interrupt'
  elif grep -q -E '^ *(✻|✽|✶|✳|✢|·|\*) [A-Za-z-]+…' <<<"$1"; then echo 'spinner'
  fi
}
COUNT_PROMPT="Count from 1 to 600, one number per line, nothing else on the line. Then reply with exactly: T11"
new_warning() {
  awk '/Count from 1 to 600/ {c = NR} /switched; main.s cache was warm .*the next request may rewrite it: main 5m/ {w = NR} END {exit !(w > c)}' <<<"$1"
}
# The toast is a boxed card at the top right that wraps its text over lines
# ending "│"; its text is those lines' insides joined.
toast_text() { awk -F'│' '/│ *$/ {print $(NF-1)}' <<<"$1" | tr '\n' ' ' | tr -s ' ' | sed 's/^ *//; s/ *$//'; }
toast_shown() { grep -q -E "cache was warm .*— now main 5m" <<<"$(toast_text "$1")"; }
send_now() { $T send-keys -t proof -l "$1"; sleep 0.3; $T send-keys -t proof Enter; log "<- $1 (now)"; }
command_row "/cache main 1h"
send_now "$COUNT_PROMPT"
run_marker=""
for _ in $(seq 1 150); do
  sleep 0.2; pane=$($T capture-pane -p -t proof); run_marker=$(running_marker "$pane"); [ -n "$run_marker" ] && break
done
echo "$pane" > "$RUN/midturn-before.txt"; log "turn running: ${run_marker:-no marker seen}"
send_now "/cache main 5m"
mkdir -p "$RUN/midturn-frames"
f_seen=""; f_frame=""; f_time=""; t_seen=""; t_marker=""; t_frame=""; t_time=""; idle=0
for i in $(seq -w 1 600); do
  sleep 0.1; pane=$($T capture-pane -p -t proof); now=$(date +%T.%N | cut -c1-12)
  { echo "# $now"; echo "$pane"; } > "$RUN/midturn-frames/$i.txt"
  if [ -z "$t_seen" ] && toast_shown "$pane"; then
    t_seen=yes; t_marker=$(running_marker "$pane"); t_frame=$i; t_time=$now
    echo "$pane" > "$RUN/midturn-toast.txt"
  fi
  if [ -z "$f_seen" ] && new_warning "$pane"; then
    f_seen=yes; f_frame=$i; f_time=$now; echo "$pane" > "$RUN/midturn.txt"
  fi
  [ -n "$t_seen" ] && [ -n "$f_seen" ] && break
  if [ -z "$(running_marker "$pane")" ]; then idle=$((idle + 1)); [ "$idle" -ge 30 ] && break; else idle=0; fi
done
[ -n "$f_seen" ] || echo "$pane" > "$RUN/midturn.txt"
log "toast: ${t_seen:-no} (frame ${t_frame:-none} at ${t_time:-none}, marker ${t_marker:-none}); reply line: ${f_seen:-no} (frame ${f_frame:-none} at ${f_time:-none})"
f_line=$([ -n "$f_seen" ] && grep -o -E "switched; main's cache was warm .*main 5m.*" "$RUN/midturn.txt" | tail -1 | sed 's/ *$//')
t_line=$([ -n "$t_seen" ] && toast_text "$(cat "$RUN/midturn-toast.txt")")
wait_label T11 120
turn "Reply with exactly: T12" T12
F3=$(transcript)
[ -n "$F3" ] || { echo "ERROR no transcript for $ID under $PROJECTS"; exit 2; }
cp "$F3" "$RUN/handoff.jsonl"
handoff_rows=$(buckets "$F3")
echo "$handoff_rows" > "$RUN/handoff-buckets.txt"
# The first request of a label: cache read, 5m write, 1h write, in tokens.
usage_of() {
  jq -r -s --arg l "$2" '[foreach .[] as $r ({label: "-"};
      if $r.type == "user" and ($r.message.content | type) == "string" and ($r.message.content | test("exactly: [A-Z][0-9]+"))
        then .label = ($r.message.content | capture("exactly: (?<x>[A-Z][0-9]+)").x) | .row = null
      elif $r.type == "assistant" and $r.message.usage then .row = $r.message.usage else .row = null end;
      select(.label == $l and .row != null) | .row)] | first
    | "read=\(.cache_read_input_tokens // 0) w5m=\(.cache_creation.ephemeral_5m_input_tokens // 0) w1h=\(.cache_creation.ephemeral_1h_input_tokens // 0)"' "$1"
}
u9=$(usage_of "$F3" T9); u10=$(usage_of "$F3" T10); u11=$(usage_of "$F3" T11); u12=$(usage_of "$F3" T12)
field() { sed -n "s/.*$1=\([0-9]*\).*/\1/p" <<<"$2"; }
outputs3=$(outputs "$F3")
# The counting turn: every request it made, in order, and whether it was cut short.
t11_all=$(grep '^T11 ' <<<"$handoff_rows" | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')
# When the transcript took the mid-turn output, against the counting turn's answer.
f_cmd_ts=$(jq -r 'select(.subtype=="local_command") | select(.content|contains("rewrite it: main 5m")) | .timestamp' "$F3" | tail -1)
t11_ts=$(jq -r 'select(.type=="assistant") | select([.message.content[]? | select(.type=="text") | .text | contains("T11")] | any) | .timestamp' "$F3" | head -1)
t11_ok=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$F3" | grep -q 'T11' && ! grep -q 'Request interrupted' "$F3" && echo yes)

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
row "(e) T9 main, launched CACHE_LIVE_CONTROL_MAIN_TTL=1h" 1h "$(of "$handoff_rows" T9)"
row "(e) /cache credits the handoff" yes "$(grep -q 'main 1h (set at launch' <<<"$outputs3" && echo yes)"
row "(e) warm /cache main 5m warns and switches" yes "$(grep -q "switched; main's cache was warm .*the next request may rewrite it: main 5m" <<<"$e_out" && echo yes)"
row "(e) T10 main after the warm switch" 5m "$(of "$handoff_rows" T10)"
row "(f) mid-turn: the reply line shows" yes "${f_seen:-no}"
row "(f) mid-turn: a frame shows the toast and the turn running" yes "$([ -n "$t_seen" ] && [ -n "$t_marker" ] && echo yes)"
row "(f) mid-turn: the turn finishes, not aborted" yes "${t11_ok:-no}"
row "(f) T12 main after the mid-turn switch" 5m "$(of "$handoff_rows" T12)"
u1=$(usage_of "$F" T1); u2=$(usage_of "$F" T2); u3=$(usage_of "$F" T3)
info() { printf '| %-44s | %-6s | %-12s | %s |\n' "$1" "-" "$2" "INFO"; }
info "premise: T2 read after 5m -> 1h" "$(field read "$u2")"
info "premise: T3 read after 1h -> 5m" "$(field read "$u3")"
info "premise: T10 read after 1h -> 5m (e)" "$(field read "$u10")"
info "premise: T11 read after 5m -> 1h" "$(field read "$u11")"
info "premise: T12 read after 1h -> 5m mid-turn" "$(field read "$u12")"
info "(f) T11 requests, in order" "$t11_all"
info "(f) transcript: output before the answer" "$([ -n "$f_cmd_ts" ] && [[ "$f_cmd_ts" < "$t11_ts" ]] && echo "yes $f_cmd_ts < $t11_ts" || echo "no $f_cmd_ts / $t11_ts")"
info "(f) first toast frame" "${t_frame:-none} at ${t_time:-none} (${t_marker:-no marker})"
info "(f) reply line frame" "${f_frame:-none} at ${f_time:-none}"
info "(f) running marker before the switch" "${run_marker:-none}"
echo
echo "premise, first request of each turn (tokens):"
echo "  raise 5m -> 1h:  T1 (5m) $u1 · T2 (1h) $u2"
echo "  lower 1h -> 5m:  T2 (1h) $u2 · T3 (5m) $u3"
echo "  lower 1h -> 5m, warm (e):  T9 (1h) $u9 · T10 (5m) $u10"
echo "  raise 5m -> 1h, warm:  T10 (5m) $u10 · T11 (1h) $u11"
echo "  lower 1h -> 5m, mid-turn (f):  T11 (1h) $u11 · T12 (5m) $u12"
echo
echo "mid-turn capture: $RUN/midturn.txt"
echo "  warning line: ${f_line:-none}"
echo "toast frame: $RUN/midturn-frames/${t_frame:-none}.txt"
echo "  toast text: ${t_line:-none}"
echo
echo "command output rows:"; outputs "$F" "$F2" "$F3" | sed 's/^/  /'
echo "evidence: $RUN"
exit $fail
