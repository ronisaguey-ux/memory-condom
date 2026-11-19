#!/usr/bin/env bash
# End-to-end check: append, validate, render determinism, rejection, prune, MCP round trip.
set -uo pipefail
BIN="$(cd "$(dirname "$0")/.." && pwd)/bin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
fails=0
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fails=$((fails+1)); }

F="$T/AGENTS.jsonl"
node "$BIN/memcondom.js" add --file "$F" --topic router --text "a fact" >/dev/null && ok "append"
node "$BIN/memcondom.js" check --file "$F" | grep -q "0 invalid" && ok "valid store passes" || bad "valid store passes"
node "$BIN/memcondom.js" add --file "$F" --topic "Bad Topic" --text "x" >/dev/null 2>&1 && bad "invalid topic rejected" || ok "invalid topic rejected"
node "$BIN/memcondom.js" add --file "$F" --topic a --text "$(printf 'x%.0s' {1..500})" >/dev/null 2>&1 && bad "over-long text rejected" || ok "over-long text rejected"
node "$BIN/memcondom.js" render --file "$F" --out "$T/1.md"
node "$BIN/memcondom.js" render --file "$F" --out "$T/2.md"
cmp -s "$T/1.md" "$T/2.md" && ok "render is deterministic" || bad "render is deterministic"
node "$BIN/memcondom.js" add --file "$F" --topic router --text "appended later" >/dev/null
tail -1 "$F" | grep -q "appended later" && ok "append lands at the bottom" || bad "append lands at the bottom"
node "$BIN/memcondom.js" prune --file "$F" --max 1 | grep -q "archived 1" && ok "prune keeps the newest" || bad "prune keeps the newest"

id=$(node "$BIN/memcondom.js" add --file "$F" --topic router --text "alphafact original" | awk '{print $2}')
node "$BIN/memcondom.js" edit --file "$F" --ref "$id" --text "alphafact corrected" >/dev/null
node "$BIN/memcondom.js" render --file "$F" --out "$T/3.md"
grep -q "alphafact corrected" "$T/3.md" && ! grep -q "alphafact original" "$T/3.md" && ok "edit replaces text via appended op" || bad "edit replaces text via appended op"
node "$BIN/memcondom.js" search "alphafact" --file "$F" | grep -q "corrected" && ok "search sees the corrected text" || bad "search sees the corrected text"
node "$BIN/memcondom.js" del --file "$F" --ref "$id" >/dev/null
node "$BIN/memcondom.js" render --file "$F" --out "$T/4.md"
! grep -q "alphafact" "$T/4.md" && ok "delete drops the line from the render" || bad "delete drops the line from the render"
node "$BIN/memcondom.js" search "alphafact" --file "$F" | grep -q "no matches" && ok "deleted fact is not searchable" || bad "deleted fact is not searchable"
node "$BIN/memcondom.js" search "later" --file "$F" | grep -q "appended later" && ok "search finds a live fact" || bad "search finds a live fact"

A="$T/artifacts"
out=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_artifact","arguments":{"name":"note","content":"# note\n\nbody text\n"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_artifacts","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_artifact","arguments":{"name":"note"}}}' \
  | MEMCONDOM_FILE="$F" MEMCONDOM_ARTIFACTS="$A" node "$BIN/memcondom-mcp.js")
echo "$out" | grep -q "body text" && ok "artifact write + read" || bad "artifact write + read"
echo "$out" | grep -q "2026-" && ok "artifact is timestamp-named" || bad "artifact is timestamp-named"

M="$T/mcp.jsonl"
: > "$M"
# Owner (2026-11-19): there is no edit window. A write is QUEUED at any moment and lands
# exactly once, after a compaction, so injected memory never changes mid-turn.
queued=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"queued fact","topic":"mcp"}}}' \
  | OPENCODE_SESSION_ID=ses_test MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js")
echo "$queued" | grep -q "queued fm_" && ok "write_memory queues instead of writing" || bad "write_memory queues instead of writing"
[ -s "$M" ] && bad "queued write must not touch the store yet" || ok "queued write must not touch the store yet"

applied=$(MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_test)
echo "$applied" | grep -q "appended" && ok "apply_queued lands the fact" || bad "apply_queued lands the fact"
grep -q "queued fact" "$M" && ok "store holds the fact after apply" || bad "store holds the fact after apply"
MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_test | grep -q "no queued memories" \
  && ok "applied entries never apply twice" || bad "applied entries never apply twice"

read_back=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_memories","arguments":{"limit":5}}}' \
  | OPENCODE_SESSION_ID=ses_test MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js")
echo "$read_back" | grep -q "queued fact" && ok "applied fact is readable" || bad "applied fact is readable"

first=$(python3 -c "import json;print(json.loads(open('$M').readline())['id'])")
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_edit\",\"arguments\":{\"id\":\"$first\",\"text\":\"corrected after review\"}}}" \
  "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_delete\",\"arguments\":{\"id\":\"$first\",\"reason\":\"superseded\"}}}" \
  | OPENCODE_SESSION_ID=ses_test MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" >/dev/null
MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_test | grep -q "edited $first" \
  && ok "queue_edit applies an existing fact" || bad "queue_edit applies an existing fact"
MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_test | grep -q "no queued memories" \
  && ok "queue_delete applied in the same batch" || bad "queue_delete applied in the same batch"
grep -q "corrected after review" "$M" && ok "correction reached the store" || bad "correction reached the store"

frozen=$(MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_test)
echo "$frozen" | grep -q "no queued memories" && ok "queue is empty and frozen" || bad "queue is empty and frozen"

S="$T/scope"
: > "$S"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"scoped fact","topic":"scope"}}}' \
  | OPENCODE_SESSION_ID=ses_owner MEMCONDOM_FILE="$S" node "$BIN/memcondom-mcp.js" >/dev/null
other=$(MEMCONDOM_FILE="$S" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_other)
echo "$other" | grep -q "no queued memories" && ok "another session cannot consume the queue" || bad "another session cannot consume the queue"
[ -s "$S" ] && bad "queue must stay unapplied" || ok "queue must stay unapplied"
nobody=$(MEMCONDOM_FILE="$S" node "$BIN/memcondom-mcp.js" --apply-queued "$T")
echo "$nobody" | grep -q "no queued memories" && ok "an unauthenticated apply cannot consume the queue" || bad "an unauthenticated apply cannot consume the queue"
owner=$(MEMCONDOM_FILE="$S" node "$BIN/memcondom-mcp.js" --apply-queued "$T" --session ses_owner)
echo "$owner" | grep -q "appended" && ok "the queuing session applies its own queue" || bad "the queuing session applies its own queue"

bash "$ROOT/test/seams.sh" || { echo "seam checks failed"; exit 1; }

rm -rf "$T"
[ "$fails" -eq 0 ] && { echo "all checks passed"; exit 0; } || { echo "$fails check(s) failed"; exit 1; }
