"use strict";
/**
 * Store primitives: reading, validating, resolving ops, ranked recall.
 *
 * The store is a JSONL file of two record shapes. A fact record carries id/topic/text. An op
 * record (`{"op":"edit"|"del","ref":"m0007"}`) points at a fact and is appended, never substituted
 * — that is what keeps every earlier byte of the injected prompt identical between turns.
 */

const fs = require("fs");

const LIMITS = { text: 400, topic: 40, id: 12, tag: 20 };
const TOKEN_RE = /^[a-z0-9][a-z0-9/._-]*$/;
const OPS = new Set(["edit", "del"]);

function readStore(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").split("\n");
  const out = [];
  raw.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      out.push(JSON.parse(s));
    } catch (e) {
      throw new Error(`${file}:${i + 1} is not valid JSON (${e.message})`);
    }
  });
  return out;
}

function validate(rec, seenIds) {
  const errs = [];
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return ["record must be an object"];

  if (OPS.has(rec.op)) {
    if (!rec.ref || typeof rec.ref !== "string") errs.push("op record requires ref");
    if (rec.op === "edit") {
      if (typeof rec.text !== "string" || !rec.text.trim()) errs.push("edit requires text");
      else if (rec.text.length > LIMITS.text) errs.push(`edit text longer than ${LIMITS.text}`);
    }
    if (rec.ts && !/^\d{4}-\d{2}-\d{2}$/.test(rec.ts)) errs.push("ts must be YYYY-MM-DD");
    return errs;
  }

  if (!rec.id || typeof rec.id !== "string") errs.push("id (string) required");
  else if (rec.id.length > LIMITS.id) errs.push(`id longer than ${LIMITS.id}`);
  else if (seenIds && seenIds.has(rec.id)) errs.push(`duplicate id ${rec.id}`);
  if (!rec.topic || typeof rec.topic !== "string") errs.push("topic (string) required");
  else if (!TOKEN_RE.test(rec.topic)) errs.push("topic must be a lowercase slug (a-z0-9/._-)");
  else if (rec.topic.length > LIMITS.topic) errs.push(`topic longer than ${LIMITS.topic}`);
  if (!rec.text || typeof rec.text !== "string") errs.push("text (string) required");
  else {
    if (rec.text.length > LIMITS.text) errs.push(`text longer than ${LIMITS.text} chars — split it into another line`);
    if (/[\r\n]/.test(rec.text)) errs.push("text must be one line (no newlines)");
  }
  if (rec.ts && !/^\d{4}-\d{2}-\d{2}$/.test(rec.ts)) errs.push("ts must be YYYY-MM-DD");
  if (rec.tags && (!Array.isArray(rec.tags) || rec.tags.some((t) => typeof t !== "string" || t.length > LIMITS.tag)))
    errs.push(`tags must be an array of short strings (<=${LIMITS.tag})`);
  if (rec.refs && (!Array.isArray(rec.refs) || rec.refs.some((r) => typeof r !== "string" || !/^m\d+$/.test(r))))
    errs.push("refs must be an array of memory ids (m0001)");
  return errs;
}

function nextId(records) {
  let n = 0;
  for (const r of records) {
    const m = /^m(\d+)$/.exec(String(r.id || ""));
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return "m" + String(n + 1).padStart(4, "0");
}

/** Archived records, kept readable so pruning never destroys knowledge. */
function readArchive(file) {
  const archive = file + ".archive";
  if (!fs.existsSync(archive)) return [];
  return readStore(archive);
}

/** Apply edit/del ops in file order. Live facts come back in original insertion order. */
function resolve(records) {
  const byId = new Map();
  const order = [];
  for (const r of records) {
    if (OPS.has(r.op)) {
      const target = byId.get(r.ref);
      if (!target) continue;
      if (r.op === "del") target.__deleted = true;
      else {
        target.text = r.text;
        if (r.topic) target.topic = r.topic;
        if (r.ts) target.edited = r.ts;
      }
      continue;
    }
    byId.set(r.id, { ...r });
    order.push(r.id);
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
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    let score = 0;
    for (const t of seen) {
      const c = counts.get(t) || 0;
      if (c) score += 1 + Math.log(c);
      if (r.topic.includes(t)) score += 2;
      if (t.length > 4 && r.text.toLowerCase().includes(t)) score += 0.5;
    }
    if (score > 0) scored.push({ rec: r, score: score / Math.sqrt(1 + words.length / 40) });
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
    .slice(0, LIMITS.topic);
}

module.exports = { LIMITS, TOKEN_RE, OPS, readStore, readArchive, validate, nextId, resolve, rank, tokens, slugTopic };
