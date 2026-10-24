#!/usr/bin/env node
/**
 * memory-condom MCP server (stdio, zero dependencies).
 *
 * Exposes the append-only memory store and the artifact store as tools so an agent writes through a
 * schema-enforcing path instead of editing a prose file:
 *
 *   write_memory   append ONE terse verified fact at the bottom (prefix stays byte-identical)
 *   edit_memory    correct a fact by appending an edit record (history preserved)
 *   delete_memory  forget a fact by appending a tombstone (history preserved)
 *   search_memory  ranked recall, so old facts need not be re-read every turn
 *   list_memories  recent memories, optionally by topic
 *   memory_stats   record count, approximate token cost, topic histogram
 *   write_artifact long-form note written to a .md file; contents are NEVER injected
 *   list_artifacts artifacts written so far (name, size, first line)
 *   read_artifact  read an artifact on demand, paged
 *   grep_artifacts find which artifact mentions something
 *
 * Store: $MEMCONDOM_FILE, else <cwd>/AGENTS.jsonl, else ~/.config/opencode/AGENTS.jsonl.
 * Artifacts: $MEMCONDOM_ARTIFACTS, else <store dir>/artifacts.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const artifacts = require("./artifacts.js");
const { readStore, readArchive, resolve, validate, nextId, rank, LIMITS, slugTopic } = require("./lib/store.js");
const { renderTokens, budget } = require("./lib/markdown.js");

function storePath() {
  if (process.env.MEMCONDOM_FILE) return process.env.MEMCONDOM_FILE;
  const cwdFile = path.join(process.cwd(), "AGENTS.jsonl");
  if (fs.existsSync(cwdFile)) return cwdFile;
  return path.join(os.homedir(), ".config/opencode/AGENTS.jsonl");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function writeMemory(args) {
  const file = storePath();
  const records = readStore(file);
  const text = String(args.text || "").replace(/\s+/g, " ").trim();
  const rec = { id: nextId(records), ts: today(), topic: slugTopic(args.topic), text };
  if (Array.isArray(args.tags) && args.tags.length) rec.tags = args.tags.map(String).slice(0, 6);
  if (Array.isArray(args.refs) && args.refs.length) rec.refs = args.refs.map(String).slice(0, 12);
  const errs = validate(rec, new Set(records.map((r) => r.id)));
  if (errs.length) throw new Error(`refused: ${errs.join("; ")}`);
  const cap = budget();
  const current = renderTokens(file);
  const addition = Math.ceil((String(rec.text).length + String(rec.topic).length + 24) / 3.6);
  if (current + addition > cap)
    throw new Error(
      `memory store is full: ~${current}/${cap} tokens. Either prune old memories ` +
        `(memcondom prune --max-tokens ${cap} --file ${file}) or write this as an artifact with write_artifact. ` +
        `Nothing was appended.`
    );
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return `appended ${rec.id} (${records.length + 1} lines, ~${current + addition}/${cap} tokens)`;
}

function editMemory(args) {
  const file = storePath();
  const records = readStore(file);
  const ref = String(args.id || args.ref || "");
  if (!records.some((r) => r.id === ref && !r.op)) throw new Error(`no record ${ref}`);
  const rec = { op: "edit", ref, ts: today(), text: String(args.text || "").replace(/\s+/g, " ").trim() };
  if (args.topic) rec.topic = slugTopic(args.topic);
  const errs = validate(rec);
  if (errs.length) throw new Error(`refused: ${errs.join("; ")}`);
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return `edited ${ref} by appending a correction; the prefix before it is unchanged`;
}

function deleteMemory(args) {
  const file = storePath();
  const records = readStore(file);
  const ref = String(args.id || args.ref || "");
  if (!records.some((r) => r.id === ref && !r.op)) throw new Error(`no record ${ref}`);
  const rec = { op: "del", ref, ts: today() };
  if (args.reason) rec.reason = String(args.reason).slice(0, 120);
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  return `deleted ${ref} by appending a tombstone`;
}

function listMemories(args) {
  const live = resolve(readStore(storePath()));
  const topic = args.topic ? slugTopic(args.topic) : null;
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
  const filtered = topic ? live.filter((r) => r.topic === topic) : live;
  const tail = filtered.slice(-limit);
  return tail.length ? tail.map((r) => `${r.id}\t${r.topic}\t${r.text}`).join("\n") : "(no memories)";
}

function searchMemory(args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query required");
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  const file = storePath();
  const live = resolve(readStore(file));
  const liveIds = new Set(live.map((r) => r.id));
  const archived = resolve(readArchive(file))
    .filter((r) => !liveIds.has(r.id))
    .map((r) => ({ ...r, archived: true }));
  const hits = rank([...live, ...archived], query).slice(0, limit);
  return hits.length
    ? hits.map(({ rec, score }) =>
        `${rec.id}\t${score.toFixed(1)}\t${rec.topic}${rec.archived ? "\t[archived]" : ""}\t${rec.text}`
      ).join("\n")
    : "no matches";
}

function memoryStats() {
  const records = readStore(storePath());
  const live = resolve(records);
  const byTopic = {};
  for (const r of live) byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
  const chars = live.reduce((n, r) => n + (r.text || "").length, 0);
  const top = Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t, n]) => `  ${t}: ${n}`)
    .join("\n");
  return `${live.length} live records (${records.length} lines), ~${Math.ceil(chars / 4)} tokens\n${top}\nfile: ${storePath()}`;
}

const TOOLS = [
  {
    name: "write_memory",
    description:
      "Append ONE terse verified fact to the agent memory store (AGENTS.jsonl). Append-only: never rewrite or reorder existing lines — the injected prompt prefix must stay byte-identical for the provider's cache. Max 400 chars, no newlines, one fact per call. The store has a hard token budget: if the write pushes it over, prune old memories or put the detail in an artifact instead.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "One fact, max 400 chars, no newlines" },
        topic: { type: "string", description: "Lowercase slug: router, helpotron/deploy, browsers" },
        tags: { type: "array", items: { type: "string" }, description: "Optional short tags" },
        refs: { type: "array", items: { type: "string" }, description: "Optional related memory ids (m0001)" },
      },
      required: ["text", "topic"],
    },
  },
  {
    name: "edit_memory",
    description:
      "Correct an existing memory. Appends an edit record rather than rewriting the line, so history survives and the prefix stays stable. Use when a fact went stale; delete_memory is for facts that are simply wrong.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id, e.g. m0014" },
        text: { type: "string", description: "Replacement text, max 400 chars" },
        topic: { type: "string", description: "Optional new topic" },
      },
      required: ["id", "text"],
    },
  },
  {
    name: "delete_memory",
    description:
      "Forget a memory by appending a tombstone record. The line stays on disk for audit, the rendered markdown drops it. Use sparingly — prefer edit_memory for a fact that merely changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id, e.g. m0014" },
        reason: { type: "string", description: "Why it is being removed" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_memories",
    description: "Recent memories, newest last, optionally filtered by topic. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        limit: { type: "number", description: "default 20, max 200" },
      },
    },
  },
  {
    name: "search_memory",
    description:
      "Ranked full-text recall over all memories (topic-weighted). Use this instead of reading the whole store when you need an old fact you did not keep in context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "default 10, max 50" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_stats",
    description: "Record count, approximate token cost, topic histogram and store path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "write_artifact",
    description:
      "Write a long-form note to a markdown file whose CONTENTS ARE NEVER INJECTED into the prompt — use it whenever you would otherwise dump reasoning, tables, logs or drafts into the conversation. Returns only the filename, size and line count. Read it back with read_artifact when you actually need it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short descriptive name, e.g. 'audit-plan' or 'cache-analysis'" },
        content: { type: "string", description: "Full markdown body" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_artifacts",
    description: "List artifacts written so far: filename, size and first line. Cheap — no file contents are returned.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "default 40" } },
    },
  },
  {
    name: "read_artifact",
    description: "Read one artifact, paged by line. Only call it when the content is actually needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename or a distinctive fragment of it" },
        offset: { type: "number", description: "0-based start line" },
        limit: { type: "number", description: "lines to return, default 200, max 2000" },
      },
      required: ["name"],
    },
  },
  {
    name: "grep_artifacts",
    description: "Find which artifact mentions a phrase, without reading whole files.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
];

const HANDLERS = {
  write_memory: (a) => writeMemory(a),
  edit_memory: (a) => editMemory(a),
  delete_memory: (a) => deleteMemory(a),
  list_memories: (a) => listMemories(a),
  search_memory: (a) => searchMemory(a),
  memory_stats: () => memoryStats(),
  write_artifact: (a) => {
    if (!a.name) throw new Error("name required");
    if (typeof a.content !== "string") throw new Error("content required");
    return artifacts.writeArtifact(a.name, a.content, storePath());
  },
  list_artifacts: (a) => artifacts.listArtifacts(storePath(), a.limit),
  read_artifact: (a) => artifacts.readArtifact(a.name, storePath(), a.offset, a.limit),
  grep_artifacts: (a) => artifacts.grepArtifacts(a.query, storePath(), a.limit),
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        reply(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "memory-condom", version: "0.2.0" },
        });
      } else if (method === "tools/list") {
        reply(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        const handler = HANDLERS[params?.name];
        if (!handler) throw new Error(`unknown tool ${params?.name}`);
        reply(id, { content: [{ type: "text", text: handler(params?.arguments || {}) }] });
      } else if (method && method.startsWith("notifications/")) {
        // no response expected
      } else if (id !== undefined) {
        fail(id, `unsupported method ${method}`);
      }
    } catch (e) {
      if (id !== undefined) fail(id, e.message);
    }
  }
});
