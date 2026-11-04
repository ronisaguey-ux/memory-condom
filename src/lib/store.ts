/**
 * Store primitives: reading, validating, resolving ops, ranked recall.
 *
 * The store is a JSONL file of two record shapes. A fact record carries id/topic/text. An op
 * record (`{"op":"edit"|"del","ref":"m0007"}`) points at a fact and is appended, never substituted
 * — that is what keeps every earlier byte of the injected prompt identical between turns.
 */

import * as fs from "fs";

/**
 * One line of the store. Every field is optional here because the file is read as raw JSON and
 * only `validate` decides what a well-formed record is; a fact and an op share this shape.
 */
export interface StoreRecord {
  id?: string;
  topic?: string;
  text?: string;
  ts?: string;
  tags?: string[];
  refs?: string[];
  op?: "edit" | "del";
  ref?: string;
  reason?: string;
  archived?: boolean;
  edited?: string;
  __deleted?: boolean;
}

/** A live fact after ops have been applied: id/topic/text are known to be present. */
export interface ResolvedFact extends StoreRecord {
  id: string;
  topic: string;
  text: string;
}

/** A fact carrying the `archived` flag that search adds for records read from the archive. */
export type RankableFact = StoreRecord & { archived?: boolean };

export interface ScoredRecord {
  rec: RankableFact;
  score: number;
}

export interface Limits {
  text: number;
  topic: number;
  id: number;
  tag: number;
}

export const LIMITS: Limits = { text: 400, topic: 40, id: 12, tag: 20 };
export const TOKEN_RE = /^[a-z0-9][a-z0-9/._-]*$/;
export const OPS: ReadonlySet<string> = new Set(["edit", "del"]);

export function readStore(file: string): StoreRecord[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").split("\n");
  const out: StoreRecord[] = [];
  raw.forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      out.push(JSON.parse(s) as StoreRecord);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`${file}:${i + 1} is not valid JSON (${message})`);
    }
  });
  return out;
}

export function validate(rec: unknown, seenIds?: Set<string>): string[] {
  const errs: string[] = [];
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return ["record must be an object"];

  const r = rec as StoreRecord;

  if (r.op !== undefined && OPS.has(r.op)) {
    if (!r.ref || typeof r.ref !== "string") errs.push("op record requires ref");
    if (r.op === "edit") {
      if (typeof r.text !== "string" || !r.text.trim()) errs.push("edit requires text");
      else if (r.text.length > LIMITS.text) errs.push(`edit text longer than ${LIMITS.text}`);
    }
    if (r.ts && !/^\d{4}-\d{2}-\d{2}$/.test(r.ts)) errs.push("ts must be YYYY-MM-DD");
    return errs;
  }

  if (!r.id || typeof r.id !== "string") errs.push("id (string) required");
  else if (r.id.length > LIMITS.id) errs.push(`id longer than ${LIMITS.id}`);
  else if (seenIds && seenIds.has(r.id)) errs.push(`duplicate id ${r.id}`);
  if (!r.topic || typeof r.topic !== "string") errs.push("topic (string) required");
  else if (!TOKEN_RE.test(r.topic)) errs.push("topic must be a lowercase slug (a-z0-9/._-)");
  else if (r.topic.length > LIMITS.topic) errs.push(`topic longer than ${LIMITS.topic}`);
  if (!r.text || typeof r.text !== "string") errs.push("text (string) required");
  else {
    if (r.text.length > LIMITS.text) errs.push(`text longer than ${LIMITS.text} chars — split it into another line`);
    if (/[\r\n]/.test(r.text)) errs.push("text must be one line (no newlines)");
  }
  if (r.ts && !/^\d{4}-\d{2}-\d{2}$/.test(r.ts)) errs.push("ts must be YYYY-MM-DD");
  if (r.tags && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string" || t.length > LIMITS.tag)))
    errs.push(`tags must be an array of short strings (<=${LIMITS.tag})`);
  if (r.refs && (!Array.isArray(r.refs) || r.refs.some((x) => typeof x !== "string" || !/^m\d+$/.test(x))))
    errs.push("refs must be an array of memory ids (m0001)");
  return errs;
}

export function nextId(records: StoreRecord[]): string {
  let n = 0;
  for (const r of records) {
    const m = /^m(\d+)$/.exec(String(r.id || ""));
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return "m" + String(n + 1).padStart(4, "0");
}

/** Archived records, kept readable so pruning never destroys knowledge. */
export function readArchive(file: string): StoreRecord[] {
  const archive = file + ".archive";
  if (!fs.existsSync(archive)) return [];
  return readStore(archive);
}

/** Apply edit/del ops in file order. Live facts come back in original insertion order. */
export function resolve(records: StoreRecord[]): ResolvedFact[] {
  const byId = new Map<string, ResolvedFact>();
  const order: string[] = [];
  for (const r of records) {
    if (r.op !== undefined && OPS.has(r.op)) {
      // A store is validated separately; an op written against a missing id is a no-op here.
      const target = byId.get(r.ref as string);
      if (!target) continue;
      if (r.op === "del") target.__deleted = true;
      else {
        target.text = r.text as string;
        if (r.topic) target.topic = r.topic;
        if (r.ts) target.edited = r.ts;
      }
      continue;
    }
    const id = r.id as string;
    // readStore does not validate; resolve() assumes the fact fields the store contract guarantees.
    byId.set(id, { ...r, id } as ResolvedFact);
    order.push(id);
  }
  const live: ResolvedFact[] = [];
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
export function rank(records: RankableFact[], query: string): ScoredRecord[] {
  const terms = tokens(query);
  const seen = new Set(terms);
  const scored: ScoredRecord[] = [];
  for (const r of records) {
    const words = tokens(`${r.topic} ${(r.tags || []).join(" ")} ${r.text}`);
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    let score = 0;
    for (const t of seen) {
      const c = counts.get(t) || 0;
      if (c) score += 1 + Math.log(c);
      if ((r.topic as string).includes(t)) score += 2;
      if (t.length > 4 && (r.text as string).toLowerCase().includes(t)) score += 0.5;
    }
    if (score > 0) scored.push({ rec: r, score: score / Math.sqrt(1 + words.length / 40) });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export function tokens(s: unknown): string[] {
  return String(s)
    .toLowerCase()
    .split(/[^a-z0-9/._-]+/)
    .filter((t) => t.length > 1);
}

/** One shared implementation of the topic slug so CLI and MCP cannot drift apart. */
export function slugTopic(t: unknown): string {
  return String(t || "general")
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.topic);
}
