#!/usr/bin/env bash
# Seam tests for the memory queue. Sourced/run by test/run.sh.
set -u
BIN="$(cd "$(dirname "$0")/.." && pwd)/bin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
fails=0
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fails=$((fails+1)); }

mcp() { # mcp <storefile> <session or -> <json lines...>
  local file="$1"; shift
  local ses="$1"; shift
  if [ "$ses" = "-" ]; then
    MEMCONDOM_FILE="$file" node "$BIN/memcondom-mcp.js"
  else
    OPENCODE_SESSION_ID="$ses" MEMCONDOM_FILE="$file" node "$BIN/memcondom-mcp.js"
  fi
}

# 1. two sessions
TWO="$T/two"; mkdir -p "$TWO/state"; : > "$TWO/AGENTS.jsonl"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"fact from session A","topic":"seam"}}}' | OPENCODE_SESSION_ID=ses_a MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"fact from session B","topic":"seam"}}}' | OPENCODE_SESSION_ID=ses_b MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
resA=$(MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$TWO" --session ses_a)
echo "$resA" | grep -q "1 queued memories applied" && ok "session A applies only its own entry" || bad "session A applies only its own entry"
grep -q "fact from session A" "$TWO/AGENTS.jsonl" && ok "session A fact reached the store" || bad "session A fact reached the store"
! grep -q "fact from session B" "$TWO/AGENTS.jsonl" && ok "session B fact stays queued after A applies" || bad "session B fact stays queued after A applies"
resB=$(MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$TWO" --session ses_b)
echo "$resB" | grep -q "1 queued memories applied" && ok "session B applies its own entry" || bad "session B applies its own entry"
grep -q "fact from session B" "$TWO/AGENTS.jsonl" && ok "session B fact reached the store" || bad "session B fact reached the store"
MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$TWO" --session ses_a | grep -q "no queued memories" && ok "queue empty after both apply" || bad "queue empty after both apply"
MEMCONDOM_FILE="$TWO/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$TWO" --session ses_a | grep -q "no queued memories" && ok "applied entries never apply twice" || bad "applied entries never apply twice"

# 3. edit queued against id a queued delete removes first
THREE="$T/three"; mkdir -p "$THREE/state"; : > "$THREE/AGENTS.jsonl"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"doomed fact","topic":"seam"}}}' | OPENCODE_SESSION_ID=ses_t MEMCONDOM_FILE="$THREE/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
MEMCONDOM_FILE="$THREE/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$THREE" --session ses_t >/dev/null
first=$(python3 -c "import json;print(json.loads(open('$THREE/AGENTS.jsonl').readline())['id'])")
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_delete\",\"arguments\":{\"id\":\"$first\",\"reason\":\"superseded\"}}}" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_edit\",\"arguments\":{\"id\":\"$first\",\"text\":\"should not land\"}}}" | OPENCODE_SESSION_ID=ses_t MEMCONDOM_FILE="$THREE/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
out3=$(MEMCONDOM_FILE="$THREE/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$THREE" --session ses_t)
echo "$out3" | grep -q "FAILED" && ok "edit after queued delete reports FAILED" || bad "edit after queued delete reports FAILED"
! grep -q "should not land" "$THREE/AGENTS.jsonl" && ok "failed edit did not reach store" || bad "failed edit did not reach store"

# 4. budget
BUD="$T/bud"; mkdir -p "$BUD/state"; : > "$BUD/AGENTS.jsonl"
node "$BIN/memcondom.js" add --file "$BUD/AGENTS.jsonl" --topic seam --text "a fact that fills most of the tiny budget" >/dev/null
existing=$(python3 -c "import json;print(json.loads(open('$BUD/AGENTS.jsonl').readline())['id'])")
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"queue_memory","arguments":{"text":"this queued fact will not fit in the remaining budget","topic":"seam"}}}' | OPENCODE_SESSION_ID=ses_bud MEMCONDOM_FILE="$BUD/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
if [ -n "$existing" ]; then
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_delete\",\"arguments\":{\"id\":\"$existing\",\"reason\":\"budget test\"}}}" | OPENCODE_SESSION_ID=ses_bud MEMCONDOM_FILE="$BUD/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
fi
out4=$(MEMCONDOM_MAX_TOKENS=20 MEMCONDOM_FILE="$BUD/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$BUD" --session ses_bud)
echo "$out4" | grep -q "FAILED" && ok "over-budget entry reported FAILED" || bad "over-budget entry reported FAILED"
if [ -n "$existing" ]; then
  echo "$out4" | grep -qi "deleted" && ok "rest of queue still applied" || bad "rest of queue still applied"
fi

# 5. corrupt queue
COR="$T/corrupt"; mkdir -p "$COR/state"; : > "$COR/AGENTS.jsonl"
printf '{not valid json' > "$COR/state/future_memories.json"
out5=$(MEMCONDOM_FILE="$COR/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$COR" --session ses_cor)
echo "$out5" | grep -q "no queued memories" && ok "corrupt queue yields no queued memories" || bad "corrupt queue yields no queued memories"

# 6. missing AGENTS.jsonl
NOD="$T/nostore"; mkdir -p "$NOD/state"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"created on apply","topic":"seam"}}}' | OPENCODE_SESSION_ID=ses_nod MEMCONDOM_FILE="$NOD/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
out6=$(MEMCONDOM_FILE="$NOD/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$NOD" --session ses_nod)
echo "$out6" | grep -q "appended" && ok "missing AGENTS.jsonl created on apply" || bad "missing AGENTS.jsonl created on apply"
[ -s "$NOD/AGENTS.jsonl" ] && ok "store file exists after apply" || bad "store file exists after apply"

# 7. session from state/session_id
SES="$T/sesid"; mkdir -p "$SES/state"; : > "$SES/AGENTS.jsonl"
printf 'ses_pinned\n' > "$SES/state/session_id"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"session from file","topic":"seam"}}}' | MEMCONDOM_FILE="$SES/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" >/dev/null
out7=$(MEMCONDOM_FILE="$SES/AGENTS.jsonl" node "$BIN/memcondom-mcp.js" --apply-queued "$SES")
echo "$out7" | grep -q "appended" && ok "session id read from state/session_id" || bad "session id read from state/session_id"

rm -rf "$T"
[ "$fails" -eq 0 ] && { echo "seam checks passed"; exit 0; } || { echo "$fails seam check(s) failed"; exit 1; }
PY