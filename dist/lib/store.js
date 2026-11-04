"use strict";
/**
 * Store primitives: reading, validating, resolving ops, ranked recall.
 *
 * The store is a JSONL file of two record shapes. A fact record carries id/topic/text. An op
 * record (`{"op":"edit"|"del","ref":"m0007"}`) points at a fact and is appended, never substituted
 * — that is what keeps every earlier byte of the injected prompt identical between turns.
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
exports.OPS = exports.TOKEN_RE = exports.LIMITS = void 0;
exports.readStore = readStore;
exports.validate = validate;
exports.nextId = nextId;
exports.readArchive = readArchive;
exports.resolve = resolve;
exports.rank = rank;
exports.tokens = tokens;
exports.slugTopic = slugTopic;
const fs = __importStar(require("fs"));
exports.LIMITS = { text: 400, topic: 40, id: 12, tag: 20 };
exports.TOKEN_RE = /^[a-z0-9][a-z0-9/._-]*$/;
exports.OPS = new Set(["edit", "del"]);
function readStore(file) {
    if (!fs.existsSync(file))
        return [];
    const raw = fs.readFileSync(file, "utf8").split("\n");
    const out = [];
    raw.forEach((line, i) => {
        const s = line.trim();
        if (!s)
            return;
        try {
            out.push(JSON.parse(s));
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`${file}:${i + 1} is not valid JSON (${message})`);
        }
    });
    return out;
}
function validate(rec, seenIds) {
    const errs = [];
    if (typeof rec !== "object" || rec === null || Array.isArray(rec))
        return ["record must be an object"];
    const r = rec;
    if (r.op !== undefined && exports.OPS.has(r.op)) {
        if (!r.ref || typeof r.ref !== "string")
            errs.push("op record requires ref");
        if (r.op === "edit") {
            if (typeof r.text !== "string" || !r.text.trim())
                errs.push("edit requires text");
            else if (r.text.length > exports.LIMITS.text)
                errs.push(`edit text longer than ${exports.LIMITS.text}`);
        }
        if (r.ts && !/^\d{4}-\d{2}-\d{2}$/.test(r.ts))
            errs.push("ts must be YYYY-MM-DD");
        return errs;
    }
    if (!r.id || typeof r.id !== "string")
        errs.push("id (string) required");
    else if (r.id.length > exports.LIMITS.id)
        errs.push(`id longer than ${exports.LIMITS.id}`);
    else if (seenIds && seenIds.has(r.id))
        errs.push(`duplicate id ${r.id}`);
    if (!r.topic || typeof r.topic !== "string")
        errs.push("topic (string) required");
    else if (!exports.TOKEN_RE.test(r.topic))
        errs.push("topic must be a lowercase slug (a-z0-9/._-)");
    else if (r.topic.length > exports.LIMITS.topic)
        errs.push(`topic longer than ${exports.LIMITS.topic}`);
    if (!r.text || typeof r.text !== "string")
        errs.push("text (string) required");
    else {
        if (r.text.length > exports.LIMITS.text)
            errs.push(`text longer than ${exports.LIMITS.text} chars — split it into another line`);
        if (/[\r\n]/.test(r.text))
            errs.push("text must be one line (no newlines)");
    }
    if (r.ts && !/^\d{4}-\d{2}-\d{2}$/.test(r.ts))
        errs.push("ts must be YYYY-MM-DD");
    if (r.tags && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string" || t.length > exports.LIMITS.tag)))
        errs.push(`tags must be an array of short strings (<=${exports.LIMITS.tag})`);
    if (r.refs && (!Array.isArray(r.refs) || r.refs.some((x) => typeof x !== "string" || !/^m\d+$/.test(x))))
        errs.push("refs must be an array of memory ids (m0001)");
    return errs;
}
function nextId(records) {
    let n = 0;
    for (const r of records) {
        const m = /^m(\d+)$/.exec(String(r.id || ""));
        if (m)
            n = Math.max(n, parseInt(m[1], 10));
    }
    return "m" + String(n + 1).padStart(4, "0");
}
/** Archived records, kept readable so pruning never destroys knowledge. */
function readArchive(file) {
    const archive = file + ".archive";
    if (!fs.existsSync(archive))
        return [];
    return readStore(archive);
}
/** Apply edit/del ops in file order. Live facts come back in original insertion order. */
function resolve(records) {
    const byId = new Map();
    const order = [];
    for (const r of records) {
        if (r.op !== undefined && exports.OPS.has(r.op)) {
            // A store is validated separately; an op written against a missing id is a no-op here.
            const target = byId.get(r.ref);
            if (!target)
                continue;
            if (r.op === "del")
                target.__deleted = true;
            else {
                target.text = r.text;
                if (r.topic)
                    target.topic = r.topic;
                if (r.ts)
                    target.edited = r.ts;
            }
            continue;
        }
        const id = r.id;
        // readStore does not validate; resolve() assumes the fact fields the store contract guarantees.
        byId.set(id, { ...r, id });
        order.push(id);
    }
    const live = [];
    for (const id of order) {
        const r = byId.get(id);
        if (r && !r.__deleted) {
            delete r.__deleted;
            live.push(r);
        }
    }
    return live;
}
/** Field-weighted term overlap with length normalisation. Enough for a few thousand facts. */
function rank(records, query) {
    const terms = tokens(query);
    const seen = new Set(terms);
    const scored = [];
    for (const r of records) {
        const words = tokens(`${r.topic} ${(r.tags || []).join(" ")} ${r.text}`);
        const counts = new Map();
        for (const w of words)
            counts.set(w, (counts.get(w) || 0) + 1);
        let score = 0;
        for (const t of seen) {
            const c = counts.get(t) || 0;
            if (c)
                score += 1 + Math.log(c);
            if (r.topic.includes(t))
                score += 2;
            if (t.length > 4 && r.text.toLowerCase().includes(t))
                score += 0.5;
        }
        if (score > 0)
            scored.push({ rec: r, score: score / Math.sqrt(1 + words.length / 40) });
    }
    return scored.sort((a, b) => b.score - a.score);
}
function tokens(s) {
    return String(s)
        .toLowerCase()
        .split(/[^a-z0-9/._-]+/)
        .filter((t) => t.length > 1);
}
/** One shared implementation of the topic slug so CLI and MCP cannot drift apart. */
function slugTopic(t) {
    return String(t || "general")
        .toLowerCase()
        .replace(/[^a-z0-9/._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, exports.LIMITS.topic);
}
