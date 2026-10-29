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
# Without a post-compaction window the store is locked: a write must be refused, not silently
# accepted. This is the gate the agents actually hit, so it is tested first.
locked=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"locked fact","topic":"mcp"}}}' \
  | MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js")
echo "$locked" | grep -q "MEMORY_LOCKED" && ok "memory write refused without a compaction window" || bad "memory write refused without a compaction window"

# Open the 80-turn window the way a compaction event does, then the same write must land.
node -e "require('$ROOT/bin/lib/memory_window.js').onCompaction('$T','ses_test','c_test')" >/dev/null 2>&1
out=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"mcp fact","topic":"mcp"}}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_memories","arguments":{"limit":5}}}' \
  | MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js")
echo "$out" | grep -q "mcp fact" && ok "MCP add + read inside the window" || bad "MCP add + read inside the window"

# The window is a turn budget, not a single edit: a second write in the same window must work.
second=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_memory","arguments":{"text":"second fact","topic":"mcp"}}}' \
  | MEMCONDOM_FILE="$M" node "$BIN/memcondom-mcp.js")
echo "$second" | grep -q "second fact\|ok" && ok "second write allowed inside the same window" || bad "second write allowed inside the same window"

rm -rf "$T"
[ "$fails" -eq 0 ] && { echo "all checks passed"; exit 0; } || { echo "$fails check(s) failed"; exit 1; }
