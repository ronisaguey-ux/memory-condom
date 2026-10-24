# memory-condom

An append-only memory store for agent instructions. One terse fact per line, never rewritten in place.

The problem it solves is a billing and correctness problem at the same time:

- **Cache.** DeepSeek (and Anthropic, and OpenAI) cache on an **exact prefix**. A cache hit requires the request to match a cached prefix unit from token 0. Editing a heading, re-ordering a section, or inserting a fact at the top of `AGENTS.md` invalidates every token after the edit. Appending at the bottom leaves the entire previous prefix byte-identical, so it stays cached.
- **Tokens.** Prose instructions are re-read on every single turn. A table row, a bullet, a hard fact — each is one line, and only the lines that changed cost anything.
- **Correctness.** Free-form markdown drifts. A schema-checked store can be validated in one command: no duplicate ids, no over-long entries, no multi-line facts, no stale claims hiding in paragraph 40.

## Format

`AGENTS.jsonl` — canonical store, one JSON object per line, append-only:

```json
{"id":"m0001","ts":"2026-10-24","topic":"router","text":"unknown deepseek key -> 401, fallback only to free-ai","tags":["spend"]}
```

| field | required | rule |
| --- | --- | --- |
| `id` | yes | `m` + digits, unique, assigned by the tool |
| `ts` | no | `YYYY-MM-DD` |
| `topic` | yes | lowercase slug `[a-z0-9/._-]`, max 40 chars |
| `text` | yes | **one line**, max 400 chars, no newlines |
| `tags` | no | array of short strings |

Nothing is ever inserted in the middle. Corrections are appended as a new record and the stale one is removed by an explicit `prune`/edit pass — an occasional act, not part of the write path.

## Commands

```bash
memcondom add --topic router --text "one terse verified fact"   # append one record
memcondom edit --ref m0007 --text "corrected fact"              # append a correction
memcondom del --ref m0007 --reason "superseded"                 # append a tombstone
memcondom search "prefix cache" [--limit 10]                    # ranked recall
memcondom check [--file AGENTS.jsonl]                           # validate every line
memcondom render [--file AGENTS.jsonl] [--out AGENTS.md]        # deterministic markdown view
memcondom stats [--file AGENTS.jsonl]                           # record count, ~tokens, topics
memcondom import AGENTS.md --out AGENTS.jsonl --force           # one-time migration
memcondom merge --file AGENTS.jsonl                             # join importer fragments
memcondom prune --max 400 --file AGENTS.jsonl                   # archive the oldest, keep the newest
```

## MCP server

`bin/memcondom-mcp.js` speaks MCP over stdio with zero dependencies.

| tool | purpose |
| --- | --- |
| `write_memory` | append one terse verified fact (schema-enforced, bottom of file) |
| `edit_memory` | correct a fact by appending an edit record — history kept, prefix stable |
| `delete_memory` | forget a fact by appending a tombstone — the line stays for audit |
| `list_memories` | recent memories, optionally by topic |
| `search_memory` | ranked, field-weighted recall over every fact |
| `memory_stats` | live count, approximate tokens, topic histogram |
| `write_artifact` | long-form note to a `.md` file — **contents are never injected** |
| `list_artifacts` | artifacts so far: name, size, first line |
| `read_artifact` | read one artifact, paged by line |
| `grep_artifacts` | find which artifact mentions a phrase |

Store resolution: `$MEMCONDOM_FILE` → `./AGENTS.jsonl` → `~/.config/opencode/AGENTS.jsonl`.

```json
{"mcp": {"memory-condom": {"type": "local", "command": ["node", "/home/roni/Roni_workspace/memory-condom/bin/memcondom-mcp.js"]}}}
```

## Artifacts — where the yapping goes

Anything that is not a durable fact — reasoning, drafts, tables, logs, plans — goes to `write_artifact`. It is written to `<store dir>/artifacts/YYYY-MM-DD-<slug>.md` and the tool returns only the filename, size and line count. The file is on disk, **never in the prompt**, and costs nothing until an agent explicitly reads it with `read_artifact` or locates it with `grep_artifacts`.

That is the progressive-disclosure trade: memory store for what the model must always know, artifacts for everything it may need once.

## Borrowed from where

| source | what was taken | what was dropped |
| --- | --- | --- |
| `@modelcontextprotocol/server-memory` (official) | tool surface: add / read / search / stats | whole-file graph re-serialisation, which invalidates the cache on every write |
| `engram` (SQLite + FTS5) | ranked full-text recall | native SQLite dependency and a second store to keep in sync |
| `mem0` | supersede and forget semantics | LLM extraction pipeline, vector DB, async add |
| `claude-mem` | progressive disclosure for long memory | automatic context injection of summaries |
| `AGENTS.md` standard | the injected file stays plain markdown and lives at the standard path | the requirement to hand-edit it |

## Why `AGENTS.md` is still the injected file

`AGENTS.md` is an open standard read automatically by OpenCode, Codex, Cursor, Jules and others. Injecting a `.json` instead would break that loader and every tool that looks for the standard filename. So the JSONL is canonical and `AGENTS.md` is **generated from it** — deterministic output in insertion order, which is the property the cache needs. Edit the store, run `render`, never hand-edit the markdown.

## Invariants

1. Append only. New facts go at the bottom.
2. One fact per line. No paragraphs.
3. Deterministic render: same store in, same markdown out, byte for byte.
4. Pruning is explicit and rare, and it archives rather than deletes.
5. No dependencies. Node standard library only.

## Test

```bash
test/run.sh
```
