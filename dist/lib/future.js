"use strict";
/**
 * future.ts — memories logged now, applied once, right after the next compaction.
 *
 * Owner (2026-11-19): the 80-turn window is gone. An agent may log a durable fact
 * the moment it learns it, but injected memory must not change mid-turn (that is
 * what keeps the provider prompt prefix warm). So writes land in a pending queue,
 * the queue is applied exactly once in the turn that follows a compaction, and
 * afterwards those entries are frozen until the compaction after that.
 *
 * Every entry carries the operation it will perform on the store, so a future
 * memory can add, edit or delete — including editing a fact that is already in
 * AGENTS.jsonl. The applied set is stamped with the compaction id that consumed
 * it, so re-applying the same queue twice is impossible.
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
exports.resolveFutureFile = resolveFutureFile;
exports.readFuture = readFuture;
exports.pendingFuture = pendingFuture;
exports.writeFutureMemory = writeFutureMemory;
exports.editFutureMemory = editFutureMemory;
exports.deleteFutureMemory = deleteFutureMemory;
exports.claimPending = claimPending;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
function resolveFutureFile(targetDir) {
    return path.join(targetDir || process.cwd(), "state", "future_memories.json");
}
function readFuture(targetDir) {
    const file = resolveFutureFile(targetDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function writeFuture(targetDir, entries) {
    const file = resolveFutureFile(targetDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
    fs.renameSync(tmp, file);
}
function pendingFuture(targetDir) {
    return readFuture(targetDir).filter((entry) => entry.applied_at === null);
}
function writeFutureMemory(targetDir, op, text, target, session) {
    if (op === "add" && !text)
        throw new Error("write_fm add needs text");
    if ((op === "edit" || op === "delete") && !target)
        throw new Error(`write_fm ${op} needs a target (id or text)`);
    const entries = readFuture(targetDir);
    const entry = {
        id: `fm_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
        op,
        target,
        text,
        session,
        created_at: new Date().toISOString(),
        applied_at: null,
        applied_compaction: null,
    };
    entries.push(entry);
    writeFuture(targetDir, entries);
    return entry;
}
/** Rewrite a still-pending entry. Applied entries are frozen until the next compaction. */
function editFutureMemory(targetDir, id, changes) {
    const entries = readFuture(targetDir);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry)
        throw new Error(`no future memory ${id}`);
    if (entry.applied_at !== null) {
        throw new Error(`future memory ${id} was applied at ${entry.applied_at}; it is frozen until the next compaction`);
    }
    Object.assign(entry, changes);
    writeFuture(targetDir, entries);
    return entry;
}
function deleteFutureMemory(targetDir, id) {
    const entries = readFuture(targetDir);
    const kept = entries.filter((entry) => entry.id !== id);
    writeFuture(targetDir, kept);
    return kept.length !== entries.length;
}
/**
 * Stamp every pending entry as applied to `compactionId` and hand the list back.
 * The caller performs the store writes: this module never touches AGENTS.jsonl.
 */
function claimPending(targetDir, compactionId, session) {
    const entries = readFuture(targetDir);
    // A queued change belongs to the session that wrote it. Another session compacting in
    // the same store must not consume it - that is how one agent's test fact landed in
    // Gideon's memory while Gideon had not compacted.
    // Strict: an entry is consumed only by the session that queued it. An entry with no
    // recorded session (written by an older build) is never auto-applied - it waits for an
    // explicit apply_queued, so a stray compaction cannot dump it into injected memory.
    const claimed = entries.filter((entry) => entry.applied_at === null && Boolean(session) && entry.session === session);
    if (!claimed.length)
        return [];
    const now = new Date().toISOString();
    for (const entry of claimed) {
        entry.applied_at = now;
        entry.applied_compaction = compactionId;
    }
    writeFuture(targetDir, entries);
    return claimed;
}
