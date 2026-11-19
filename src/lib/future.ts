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

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export type FutureOp = "add" | "edit" | "delete";

export interface FutureMemory {
  id: string;
  op: FutureOp;
  /** add: the fact text. edit/delete: the id or the text of the memory to change. */
  target?: string;
  text?: string;
  created_at: string;
  applied_at: string | null;
  applied_compaction: string | null;
}

export function resolveFutureFile(targetDir?: string): string {
  return path.join(targetDir || process.cwd(), "state", "future_memories.json");
}

export function readFuture(targetDir?: string): FutureMemory[] {
  const file = resolveFutureFile(targetDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as FutureMemory[]) : [];
  } catch {
    return [];
  }
}

function writeFuture(targetDir: string | undefined, entries: FutureMemory[]): void {
  const file = resolveFutureFile(targetDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
  fs.renameSync(tmp, file);
}

export function pendingFuture(targetDir?: string): FutureMemory[] {
  return readFuture(targetDir).filter((entry) => entry.applied_at === null);
}

export function writeFutureMemory(
  targetDir: string | undefined,
  op: FutureOp,
  text: string | undefined,
  target: string | undefined,
): FutureMemory {
  if (op === "add" && !text) throw new Error("write_fm add needs text");
  if ((op === "edit" || op === "delete") && !target) throw new Error(`write_fm ${op} needs a target (id or text)`);
  const entries = readFuture(targetDir);
  const entry: FutureMemory = {
    id: `fm_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`,
    op,
    target,
    text,
    created_at: new Date().toISOString(),
    applied_at: null,
    applied_compaction: null,
  };
  entries.push(entry);
  writeFuture(targetDir, entries);
  return entry;
}

/** Rewrite a still-pending entry. Applied entries are frozen until the next compaction. */
export function editFutureMemory(
  targetDir: string | undefined,
  id: string,
  changes: Partial<Pick<FutureMemory, "op" | "text" | "target">>,
): FutureMemory {
  const entries = readFuture(targetDir);
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`no future memory ${id}`);
  if (entry.applied_at !== null) {
    throw new Error(`future memory ${id} was applied at ${entry.applied_at}; it is frozen until the next compaction`);
  }
  Object.assign(entry, changes);
  writeFuture(targetDir, entries);
  return entry;
}

export function deleteFutureMemory(targetDir: string | undefined, id: string): boolean {
  const entries = readFuture(targetDir);
  const kept = entries.filter((entry) => entry.id !== id);
  writeFuture(targetDir, kept);
  return kept.length !== entries.length;
}

/**
 * Stamp every pending entry as applied to `compactionId` and hand the list back.
 * The caller performs the store writes: this module never touches AGENTS.jsonl.
 */
export function claimPending(targetDir: string | undefined, compactionId: string): FutureMemory[] {
  const entries = readFuture(targetDir);
  const claimed = entries.filter((entry) => entry.applied_at === null);
  if (!claimed.length) return [];
  const now = new Date().toISOString();
  for (const entry of claimed) {
    entry.applied_at = now;
    entry.applied_compaction = compactionId;
  }
  writeFuture(targetDir, entries);
  return claimed;
}
