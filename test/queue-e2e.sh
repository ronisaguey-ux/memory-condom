#!/bin/bash
# End-to-end check of the queue -> compaction-apply design, in a scratch store.
set -u
REPO=/home/roni/Roni_workspace/memory-condom
TEST=~/.local/state/opencode/mc-test
rm -rf "$TEST"; mkdir -p "$TEST"
: > "$TEST/AGENTS.jsonl"
export MEMCONDOM_FILE="$TEST/AGENTS.jsonl"
export MEMCONDOM_ARTIFACTS="$TEST/artifacts"

call() {
  local name="$1" args="$2"
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}" \
    | timeout 10 node "$REPO/bin/memcondom-mcp.js" | tail -1 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["result"]["content"][0]["text"] if "result" in d else d["error"]["message"])'
}

echo "--- queue add"
call queue_memory '{"text":"the queue lands right after compaction","topic":"memory-condom"}'
echo "--- queue add #2"
call write_memory '{"text":"a second queued fact","topic":"memory-condom"}'
echo "--- list pending"
call list_queued '{}'
echo "--- store before apply (must be empty)"
wc -l < "$TEST/AGENTS.jsonl"
echo "--- apply"
node "$REPO/bin/memcondom-mcp.js" --apply-queued "$TEST"
echo "--- store after apply"
cat "$TEST/AGENTS.jsonl"
FIRST=$(python3 -c 'import json;print(json.loads(open("'"$TEST"'/AGENTS.jsonl").readline())["id"])')
echo "--- queue an edit and a delete of $FIRST"
call queue_edit "{\"id\":\"$FIRST\",\"text\":\"the queue lands exactly once, right after compaction\"}"
call queue_delete "{\"id\":\"$FIRST\",\"reason\":\"superseded by the edit in this test\"}"
echo "--- list pending (2)"
call list_queued '{}'
echo "--- apply again"
node "$REPO/bin/memcondom-mcp.js" --apply-queued "$TEST"
echo "--- store after second apply"
cat "$TEST/AGENTS.jsonl"
echo "--- rendered memory (head)"
head -6 "$TEST/AGENTS.md"
echo "--- list applied (frozen)"
call list_queued '{"applied":true}'
echo "--- queue a delete of a FAKE id, then apply (must report FAILED, not crash)"
call queue_delete '{"id":"m9999","reason":"does not exist"}'
node "$REPO/bin/memcondom-mcp.js" --apply-queued "$TEST"
echo "--- second apply with nothing pending"
node "$REPO/bin/memcondom-mcp.js" --apply-queued "$TEST"
