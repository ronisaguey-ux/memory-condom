#!/usr/bin/env node
"use strict";
/**
 * memory-condom MCP server (stdio, zero dependencies).
 *
 * Exposes the append-only memory store and the artifact store as tools so an agent writes through a
 * schema-enforcing path instead of editing a prose file:
 *
 *   write_memory   queue ONE terse verified fact; applied once, right after the next compaction
 *   queue_memory   same thing under the explicit name (queue_edit / queue_delete for existing facts)
 *   list_queued    inspect pending / applied queued changes; edit_queued / drop_queued adjust them
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyQueued = applyQueued;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const artifacts = __importStar(require("./artifacts.js"));
const store_js_1 = require("./lib/store.js");
const markdown_js_1 = require("./lib/markdown.js");
const future_js_1 = require("./lib/future.js");
function currentSessionId(targetDir) {
    if (process.env.OPENCODE_SESSION_ID)
        return process.env.OPENCODE_SESSION_ID;
    if (process.env.OC2_SESSION)
        return process.env.OC2_SESSION;
    const pin = path.join(targetDir, "state", "session_id");
    if (fs.existsSync(pin)) {
        try {
            return fs.readFileSync(pin, "utf8").trim().split("\n")[0].trim();
        }
        catch { }
    }
    const openbot = path.join(os.homedir(), ".local/state/opencode/openbot_session");
    if (fs.existsSync(openbot)) {
        try {
            return fs.readFileSync(openbot, "utf8").trim().split("\n")[0].trim();
        }
        catch { }
    }
    return "unknown_session";
}
function storePath() {
    if (process.env.MEMCONDOM_FILE)
        return process.env.MEMCONDOM_FILE;
    const cwdFile = path.join(process.cwd(), "AGENTS.jsonl");
    if (fs.existsSync(cwdFile))
        return cwdFile;
    return path.join(os.homedir(), ".config/opencode/AGENTS.jsonl");
}
function today() {
    return new Date().toISOString().slice(0, 10);
}
/**
 * The direct-write logic, unchanged. It runs only from applyQueued(), once after a compaction.
 */
function applyAdd(file, text, topic) {
    const records = (0, store_js_1.readStore)(file);
    const rec = { id: (0, store_js_1.nextId)(records), ts: today(), topic: (0, store_js_1.slugTopic)(topic), text };
    const errs = (0, store_js_1.validate)(rec, new Set(records.map((r) => r.id)));
    if (errs.length)
        throw new Error(`refused: ${errs.join("; ")}`);
    const cap = (0, markdown_js_1.budget)();
    const current = (0, markdown_js_1.renderTokens)(file);
    const addition = Math.ceil((String(rec.text).length + String(rec.topic).length + 24) / 3.6);
    if (current + addition > cap)
        throw new Error(`memory store is full: ~${current}/${cap} tokens. Prune old memories ` +
            `(memcondom prune --max-tokens ${cap} --file ${file}) and keep the detail in an artifact.`);
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    return `appended ${rec.id}`;
}
function applyEdit(file, ref, text, topic) {
    const records = (0, store_js_1.readStore)(file);
    if (!(0, store_js_1.resolve)(records).some((r) => r.id === ref))
        throw new Error(`no record ${ref}`);
    const rec = { op: "edit", ref, ts: today(), text };
    if (topic)
        rec.topic = (0, store_js_1.slugTopic)(topic);
    const errs = (0, store_js_1.validate)(rec);
    if (errs.length)
        throw new Error(`refused: ${errs.join("; ")}`);
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    return `edited ${ref}`;
}
function applyDelete(file, ref, reason) {
    const records = (0, store_js_1.readStore)(file);
    if (!(0, store_js_1.resolve)(records).some((r) => r.id === ref))
        throw new Error(`no record ${ref}`);
    const rec = { op: "del", ref, ts: today() };
    if (reason)
        rec.reason = reason.slice(0, 120);
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
    return `deleted ${ref}`;
}
/** Queue one change. Nothing in the injected store moves until the next compaction. */
function queueChange(op, args) {
    const dir = path.dirname(storePath());
    const session = currentSessionId(dir);
    const text = String(args.text || "").replace(/\s+/g, " ").trim();
    if (op === "add") {
        if (!text)
            throw new Error("text required");
        const entry = (0, future_js_1.writeFutureMemory)(dir, "add", text, (0, store_js_1.slugTopic)(args.topic), session);
        return `queued ${entry.id} (add: ${(0, store_js_1.slugTopic)(args.topic)}); applied once, right after the next compaction`;
    }
    const ref = String(args.id || args.ref || "").trim();
    if (!ref)
        throw new Error("id required (the memory id to change)");
    if (op === "edit" && !text)
        throw new Error("text required");
    const entry = (0, future_js_1.writeFutureMemory)(dir, op, text, ref, session);
    return `queued ${entry.id} (${op} ${ref}); applied once, right after the next compaction`;
}
function writeMemory(args) {
    return queueChange("add", args);
}
function editMemory(args) {
    return queueChange("edit", args);
}
function deleteMemory(args) {
    return queueChange("delete", args);
}
/** Apply every pending entry in order, once, then freeze it until the next compaction. */
function applyQueued(dir, compactionId, session) {
    // The store can be pinned by MEMCONDOM_FILE (tests, unusual layouts), then by the
    // directory the caller names, then by the default resolution order.
    const pinned = process.env.MEMCONDOM_FILE;
    let file;
    let targetDir;
    if (pinned) {
        file = pinned;
        targetDir = path.dirname(pinned);
    }
    else if (dir) {
        // A directory handed to the applier is the store's home even before AGENTS.jsonl
        // exists (the first apply creates it). Falling back to storePath() here would
        // silently apply a different store and leave this one's queue untouched.
        targetDir = dir;
        file = path.join(dir, "AGENTS.jsonl");
    }
    else {
        file = storePath();
        targetDir = path.dirname(file);
    }
    if (session === undefined)
        session = currentSessionId(targetDir);
    const claimed = (0, future_js_1.claimPending)(targetDir, compactionId || `comp_${Date.now()}`, session);
    if (!claimed.length)
        return "no queued memories";
    const results = [];
    for (const entry of claimed) {
        try {
            if (entry.op === "add")
                results.push(applyAdd(file, String(entry.text || ""), String(entry.target || "general")));
            else if (entry.op === "edit")
                results.push(applyEdit(file, String(entry.target || ""), String(entry.text || "")));
            else
                results.push(applyDelete(file, String(entry.target || ""), String(entry.text || "")));
        }
        catch (error) {
            results.push(`FAILED ${entry.id}: ${error.message}`);
        }
    }
    try {
        fs.writeFileSync(path.join(targetDir, "AGENTS.md"), (0, markdown_js_1.renderMarkdown)(file));
    }
    catch (error) {
        results.push(`render failed: ${error.message}`);
    }
    return `${claimed.length} queued memories applied\n${results.join("\n")}`;
}
function listQueued(args) {
    const dir = path.dirname(storePath());
    const all = (0, future_js_1.readFuture)(dir);
    const rows = all.filter((entry) => (args.applied ? true : entry.applied_at === null));
    if (!rows.length)
        return "(queue empty)";
    return rows
        .map((entry) => [
        entry.id,
        entry.op,
        String(entry.target || ""),
        entry.applied_at ? `applied ${entry.applied_at}` : "pending",
        String(entry.text || "").slice(0, 120),
    ].join("\t"))
        .join("\n");
}
function editQueued(args) {
    const id = String(args.id || "").trim();
    if (!id)
        throw new Error("id required");
    const changes = {};
    if (args.text !== undefined)
        changes.text = String(args.text).replace(/\s+/g, " ").trim();
    if (args.target !== undefined)
        changes.target = String(args.target).trim();
    if (args.op !== undefined) {
        const op = String(args.op);
        if (op !== "add" && op !== "edit" && op !== "delete")
            throw new Error("op must be add, edit or delete");
        changes.op = op;
    }
    const entry = (0, future_js_1.editFutureMemory)(path.dirname(storePath()), id, changes);
    return `updated ${entry.id} (${entry.op}); still pending until the next compaction`;
}
function dropQueued(args) {
    const id = String(args.id || "").trim();
    if (!id)
        throw new Error("id required");
    return (0, future_js_1.deleteFutureMemory)(path.dirname(storePath()), id) ? `dropped ${id}` : `no queued entry ${id}`;
}
function listMemories(args) {
    const live = (0, store_js_1.resolve)((0, store_js_1.readStore)(storePath()));
    const topic = args.topic ? (0, store_js_1.slugTopic)(args.topic) : null;
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
    const filtered = topic ? live.filter((r) => r.topic === topic) : live;
    const tail = filtered.slice(-limit);
    return tail.length ? tail.map((r) => `${r.id}\t${r.topic}\t${r.text}`).join("\n") : "(no memories)";
}
function searchMemory(args) {
    const query = String(args.query || "").trim();
    if (!query)
        throw new Error("query required");
    const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
    const file = storePath();
    const live = (0, store_js_1.resolve)((0, store_js_1.readStore)(file));
    const liveIds = new Set(live.map((r) => r.id));
    const archived = (0, store_js_1.resolve)((0, store_js_1.readArchive)(file))
        .filter((r) => !liveIds.has(r.id))
        .map((r) => ({ ...r, archived: true }));
    const hits = (0, store_js_1.rank)([...live, ...archived], query).slice(0, limit);
    return hits.length
        ? hits
            .map(({ rec, score }) => `${rec.id}\t${score.toFixed(1)}\t${rec.topic}${rec.archived ? "\t[archived]" : ""}\t${rec.text}`)
            .join("\n")
        : "no matches";
}
function memoryStats() {
    const records = (0, store_js_1.readStore)(storePath());
    const live = (0, store_js_1.resolve)(records);
    const byTopic = {};
    for (const r of live)
        byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
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
        description: "Append ONE terse verified fact to the agent memory store (AGENTS.jsonl). Append-only: never rewrite or reorder existing lines — the injected prompt prefix must stay byte-identical for the provider's cache. Max 400 chars, no newlines, one fact per call. The store has a hard token budget: if the write pushes it over, prune old memories or put the detail in an artifact instead.",
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
        description: "Correct an existing memory. Appends an edit record rather than rewriting the line, so history survives and the prefix stays stable. Use when a fact went stale; delete_memory is for facts that are simply wrong.",
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
        description: "Forget a memory by appending a tombstone record. The line stays on disk for audit, the rendered markdown drops it. Use sparingly — prefer edit_memory for a fact that merely changed.",
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
        name: "queue_memory",
        description: "Remember ONE terse verified fact. The change is QUEUED and applied to the injected store exactly once, right after the next compaction - injected memory never changes mid-turn, so the provider prompt prefix stays warm. Use write_memory as the alias.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "One fact, max 400 chars, no newlines" },
                topic: { type: "string", description: "Lowercase slug: router, helpotron/deploy, browsers" },
            },
            required: ["text"],
        },
    },
    {
        name: "queue_edit",
        description: "Queue a correction to an EXISTING memory (by id) - for a fact you discover is wrong mid-session. Applied once, right after the next compaction.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory id to correct, e.g. m0014" },
                text: { type: "string", description: "Replacement fact" },
                topic: { type: "string" },
            },
            required: ["id", "text"],
        },
    },
    {
        name: "queue_delete",
        description: "Queue the removal of an EXISTING memory (by id) you discover is wrong or stale mid-session. Applied once, right after the next compaction.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Memory id to remove" },
                reason: { type: "string", description: "Why it is wrong" },
            },
            required: ["id"],
        },
    },
    {
        name: "list_queued",
        description: "Inspect queued memory changes. Pending by default; pass applied:true to see the ones already applied and frozen.",
        inputSchema: {
            type: "object",
            properties: { applied: { type: "boolean", description: "Include applied entries" } },
        },
    },
    {
        name: "edit_queued",
        description: "Rewrite a still-pending queued change (text, target id, or op) before it is applied. Applied entries are frozen until the next compaction.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Queued entry id, e.g. fm_..." },
                text: { type: "string" },
                target: { type: "string" },
                op: { type: "string", description: "add | edit | delete" },
            },
            required: ["id"],
        },
    },
    {
        name: "drop_queued",
        description: "Discard a queued change so it never reaches the store.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
        },
    },
    {
        name: "apply_queued",
        description: "Apply every pending queued change now and freeze it. Runs automatically right after a compaction; call it by hand only to repair a session where that event was missed.",
        inputSchema: { type: "object", properties: {} },
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
        description: "Ranked full-text recall over all memories (topic-weighted). Use this instead of reading the whole store when you need an old fact you did not keep in context.",
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
        description: "Write a long-form note to a markdown file whose CONTENTS ARE NEVER INJECTED into the prompt — use it whenever you would otherwise dump reasoning, tables, logs or drafts into the conversation. Returns only the filename, size and line count. Read it back with read_artifact when you actually need it.",
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
    queue_memory: (a) => queueChange("add", a),
    queue_edit: (a) => queueChange("edit", a),
    queue_delete: (a) => queueChange("delete", a),
    list_queued: (a) => listQueued(a),
    edit_queued: (a) => editQueued(a),
    drop_queued: (a) => dropQueued(a),
    apply_queued: () => applyQueued(),
    list_memories: (a) => listMemories(a),
    search_memory: (a) => searchMemory(a),
    memory_stats: () => memoryStats(),
    write_artifact: (a) => {
        if (!a.name)
            throw new Error("name required");
        if (typeof a.content !== "string")
            throw new Error("content required");
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
const applyFlag = process.argv.indexOf("--apply-queued");
if (applyFlag >= 0) {
    const dir = process.argv[applyFlag + 1];
    const sessionFlag = process.argv.indexOf("--session");
    const session = sessionFlag >= 0 ? process.argv[sessionFlag + 1] : undefined;
    try {
        process.stdout.write(applyQueued(dir ? path.resolve(dir) : undefined, undefined, session) + "\n");
    }
    catch (error) {
        process.stderr.write(error.message + "\n");
        process.exit(1);
    }
    process.exit(0);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line)
            continue;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
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
            }
            else if (method === "tools/list") {
                reply(id, { tools: TOOLS });
            }
            else if (method === "tools/call") {
                const handler = HANDLERS[params?.name];
                if (!handler)
                    throw new Error(`unknown tool ${params?.name}`);
                reply(id, { content: [{ type: "text", text: handler(params?.arguments || {}) }] });
            }
            else if (method && method.startsWith("notifications/")) {
                // no response expected
            }
            else if (id !== undefined) {
                fail(id, `unsupported method ${method}`);
            }
        }
        catch (e) {
            if (id !== undefined)
                fail(id, e instanceof Error ? e.message : String(e));
        }
    }
});
