/**
 * memory-condom — append-only, one-line-per-memory store for agent instructions.
 *
 * Why: an instruction file edited in the middle invalidates the model's prompt cache on every
 * edit, and free-form prose is re-read on every turn. Records are only ever appended, so the
 * prefix stays identical between turns, each fact stays terse, and the file is machine-checkable.
 *
 * Canonical store: AGENTS.jsonl. Rendered view: AGENTS.md (deterministic, insertion order).
 * Library: src/lib/store.ts (records), src/lib/markdown.ts (import/render), src/artifacts.ts.
 */

import * as fs from "fs";
import * as path from "path";
import { LIMITS, readStore, readArchive, validate, nextId, resolve, rank, type StoreRecord } from "./lib/store.js";
import { importMarkdown, renderMarkdown, mergeFragments, renderTokens, budget } from "./lib/markdown.js";
import { guardAll, guardDir, writeLocked } from "./lib/guard.js";

process.stdout.on("error", () => {});

/** One parsed `--flag value` pair, positional arguments, and bare boolean flags. */
export type ArgValue = string | boolean | string[] | undefined;

export interface ParsedArgs {
  _: string[];
  [key: string]: ArgValue;
}

export type Command = (argv: string[]) => void;

const OPS = new Set(["edit", "del"]);
const today = (): string => new Date().toISOString().slice(0, 10);

/** The string form of a flag, or undefined for a bare boolean — same as the old truthiness test. */
function arg(args: ParsedArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function die(msg: string): never {
  process.stderr.write(`memory-condom: ${msg}\n`);
  process.exit(1);
}

function append(file: string, rec: unknown): void {
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

function cmdAdd(argv: string[]): void {
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const records = readStore(file);
  // Record fields keep the raw flag value so `validate` reports the same type errors it always did.
  const rec: StoreRecord = {
    id: (args.id as string | undefined) || nextId(records),
    ts: (args.ts as string | undefined) || today(),
    topic: args.topic as string | undefined,
    text: args.text as string | undefined,
  };
  if (args.tags) rec.tags = String(args.tags).split(",").map((s) => s.trim()).filter(Boolean);
  if (args.refs) rec.refs = String(args.refs).split(",").map((s) => s.trim()).filter(Boolean);
  const errs = validate(rec, new Set(records.map((r) => r.id as string)));
  if (errs.length) die(`refused to append:\n  - ${errs.join("\n  - ")}`);
  const cap = budget();
  const current = renderTokens(file);
  const addition = Math.ceil((String(rec.text).length + String(rec.topic).length + 24) / 3.6);
  if (current + addition > cap)
    die(
      `refused: store is ~${current} tokens, cap ${cap}. Adding this fact would exceed it.\n` +
        `  Fix one of two ways:\n` +
        `    memcondom prune --max-tokens ${cap} --file ${file}   (oldest goes first, archived not lost)\n` +
        `    or write the detail as an artifact instead of a memory`
    );
  append(file, rec);
  process.stdout.write(`appended ${rec.id} (${records.length + 1} lines, ~${current + addition}/${cap} tokens)\n`);
}

function cmdEdit(argv: string[]): void {
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const ref = arg(args, "ref");
  if (!ref) die('usage: memcondom edit --ref m0007 --text "corrected fact"');
  const records = readStore(file);
  if (!records.some((r) => r.id === ref && !(r.op !== undefined && OPS.has(r.op)))) die(`no record ${ref}`);
  const rec: StoreRecord = { op: "edit", ref, ts: today(), text: args.text as string | undefined };
  const topic = args.topic as string | undefined;
  if (topic) rec.topic = topic;
  const errs = validate(rec);
  if (errs.length) die(`refused:\n  - ${errs.join("\n  - ")}`);
  append(file, rec);
  process.stdout.write(`edited ${ref} by append (prefix unchanged)\n`);
}

function cmdDel(argv: string[]): void {
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const ref = arg(args, "ref");
  if (!ref) die('usage: memcondom del --ref m0007 [--reason "superseded"]');
  const records = readStore(file);
  if (!records.some((r) => r.id === ref && !(r.op !== undefined && OPS.has(r.op)))) die(`no record ${ref}`);
  const rec: StoreRecord = { op: "del", ref, ts: today() };
  const reason = arg(args, "reason");
  if (reason) rec.reason = String(reason).slice(0, 120);
  append(file, rec);
  process.stdout.write(`deleted ${ref} by append (prefix unchanged)\n`);
}

function cmdSearch(argv: string[]): void {
  const args = parseArgs(argv);
  const query = (args._ || []).join(" ").trim();
  if (!query) die("usage: memcondom search <words> [--limit 10]");
  const file = arg(args, "file") || "AGENTS.jsonl";
  const live = resolve(readStore(file)).map((r) => ({ ...r }));
  const archived = resolve(readArchive(file)).map((r) => ({ ...r, archived: true }));
  const seenIds = new Set(live.map((r) => r.id));
  const hits = rank([...live, ...archived.filter((r) => !seenIds.has(r.id))], query).slice(
    0,
    parseInt(arg(args, "limit") || "10", 10)
  );
  if (!hits.length) {
    process.stdout.write("no matches\n");
    return;
  }
  for (const { rec, score } of hits)
    process.stdout.write(
      `${rec.id}\t${score.toFixed(1)}\t${rec.topic}${rec.archived ? "\t[archived]" : ""}\t${(rec.text as string).slice(0, 160)}\n`
    );
}

function cmdCheck(argv: string[]): void {
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const records = readStore(file);
  const ids = new Set(records.filter((r) => !(r.op !== undefined && OPS.has(r.op))).map((r) => r.id));
  const seen = new Set<string>();
  let bad = 0;
  records.forEach((r, i) => {
    const errs = validate(r, seen);
    if (!(r.op !== undefined && OPS.has(r.op))) seen.add(r.id as string);
    if (r.op !== undefined && OPS.has(r.op) && !ids.has(r.ref)) errs.push(`ref ${r.ref} does not exist`);
    if (errs.length) {
      bad++;
      process.stdout.write(`line ${i + 1} (${r.id || r.ref || "?"}): ${errs.join("; ")}\n`);
    }
  });
  const live = resolve(records);
  const longest = live.reduce((m, r) => Math.max(m, (r.text || "").length), 0);
  process.stdout.write(
    `${records.length} lines, ${live.length} live, ${bad} invalid, longest text ${longest}/${LIMITS.text}\n`
  );
  process.exit(bad ? 1 : 0);
}

function cmdImport(argv: string[]): void {
  const args = parseArgs(argv);
  const src = args._[0] || die("usage: memcondom import <file.md> [--out AGENTS.jsonl] [--force]");
  const out = arg(args, "out") || "AGENTS.jsonl";
  if (fs.existsSync(out) && !args.force) die(`${out} exists; pass --force to overwrite`);
  const records = importMarkdown(fs.readFileSync(src, "utf8"), { ts: arg(args, "ts") });
  fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`imported ${records.length} records -> ${out}\n`);
}

function cmdRender(argv: string[]): void {
  const args = parseArgs(argv);
  const text = renderMarkdown(arg(args, "file") || "AGENTS.jsonl");
  const out = arg(args, "out");
  if (out) writeLocked(out, text, { lock: Boolean(args.lock) });
  else process.stdout.write(text);
}

function cmdGuard(argv: string[]): void {
  const args = parseArgs(argv);
  const dirs = (args._ || []).concat(args.dir ? String(args.dir).split(",") : []);
  const single = dirs.length === 1 && fs.existsSync(path.join(dirs[0], "AGENTS.jsonl"));
  const results = single
    ? [guardDir(dirs[0], { dryRun: Boolean(args.dryRun), lock: !args.unlock })]
    : guardAll(dirs, { dryRun: Boolean(args.dryRun), lock: !args.unlock });
  for (const r of results) {
    if (r.status === "ok" && !args.verbose) continue;
    process.stdout.write(
      `${r.dir}\t${r.status}\textra=${r.repaired}${r.archived ? `\tarchived=${path.basename(r.archived)}` : ""}\n`
    );
  }
  const bad = results.filter((r) => r.status !== "ok").length;
  process.stdout.write(`${results.length} stores, ${bad} repaired\n`);
  process.exit(bad && args.strict ? 1 : 0);
}

const PINNED_TOPICS = new Set(["memory-condom", "diaries", "keys"]);

/** Priority lists live next to the store so each agent can protect what it must never forget. */
function protectedPrefixes(file: string): string[] {
  const candidates = [
    process.env.MEMCONDOM_PRIORITY,
    path.join(path.dirname(path.resolve(file)), "memory-priority.json"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      const doc: unknown = JSON.parse(fs.readFileSync(c, "utf8"));
      const prefixes = (doc as { protect_prefixes?: unknown }).protect_prefixes;
      if (Array.isArray(prefixes)) return prefixes as string[];
    } catch {
      /* fall through to the default */
    }
  }
  return ["0-", "1-", "memory-condom", "diaries", "keys"];
}

function cmdPrune(argv: string[]): void {
  // Explicit and rare. Two modes: --max <records> or --max-tokens <n> (the one that matters).
  // Oldest goes first, except operating rules: dropping those would make an agent forget how to
  // write memory at all. Everything removed is appended to <store>.archive and stays searchable.
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const maxRecords = parseInt(arg(args, "max") || "0", 10);
  const maxTokens = parseInt(arg(args, "max-tokens") || "0", 10);
  if (!maxRecords && !maxTokens) die("usage: memcondom prune --max-tokens 12000 [--file AGENTS.jsonl]");

  const records = readStore(file);
  const live = resolve(records);
  const prefixes = protectedPrefixes(file);
  const pinned = (r: StoreRecord): boolean =>
    PINNED_TOPICS.has(r.topic as string) ||
    (r.tags || []).includes("pin") ||
    prefixes.some((p) => String(r.topic || "").startsWith(p));
  const pinnedIds = new Set(live.filter(pinned).map((r) => r.id));
  const droppable = live.filter((r) => !pinnedIds.has(r.id)); // oldest first

  const kept = new Set<string>(pinnedIds);
  if (maxTokens) {
    // Walk newest-first, admitting records until the rendered file would exceed the budget.
    const charsOf = (r: StoreRecord): number => (r.text || "").length + (r.topic || "").length + 24;
    let used = live.filter(pinned).reduce((n, r) => n + charsOf(r), 0);
    for (let i = droppable.length - 1; i >= 0; i--) {
      const r = droppable[i];
      if (used + charsOf(r) > maxTokens * 3.6) continue;
      used += charsOf(r);
      kept.add(r.id);
    }
  } else {
    for (const r of live.slice(live.length - maxRecords)) kept.add(r.id);
    for (const id of pinnedIds) kept.add(id);
  }

  const keep = records.filter((r) => (r.op !== undefined && OPS.has(r.op) ? kept.has(r.ref as string) : kept.has(r.id as string)));
  const drop = records.filter((r) => !keep.includes(r));
  if (!drop.length) {
    process.stdout.write(`nothing to prune (${live.length} live, ~${renderTokens(file)} tokens)\n`);
    return;
  }

  const archive = arg(args, "archive") || file + ".archive";
  fs.appendFileSync(archive, drop.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(
    `archived ${drop.length} lines, kept ${keep.length} records, now ~${renderTokens(file)} tokens (cap ${maxTokens || "-"})\n`
  );
}

function cmdStats(argv: string[]): void {
  const args = parseArgs(argv);
  const records = readStore(arg(args, "file") || "AGENTS.jsonl");
  const live = resolve(records);
  const byTopic: Record<string, number> = {};
  for (const r of live) byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
  const chars = live.reduce((n, r) => n + (r.text || "").length, 0);
  process.stdout.write(
    `${live.length} live records (${records.length} lines), ${chars} chars (~${Math.ceil(chars / 4)} tokens), ` +
      `${Object.keys(byTopic).length} topics\n`
  );
  for (const [t, n] of Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12))
    process.stdout.write(`  ${t}: ${n}\n`);
}

function cmdMerge(argv: string[]): void {
  const args = parseArgs(argv);
  const file = arg(args, "file") || "AGENTS.jsonl";
  const records = readStore(file);
  const { records: merged, joined } = mergeFragments(records);
  fs.writeFileSync(file, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`merged ${joined} fragments, ${records.length} -> ${merged.length} records\n`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function usage(): string {
  return (
    "memory-condom <add|edit|del|search|check|import|render|prune|stats|merge|guard>\n" +
    '  add    --topic T --text S [--tags a,b] [--refs m0001,m0002] [--file AGENTS.jsonl]\n' +
    '  edit   --ref m0007 --text "corrected fact" [--topic T]\n' +
    '  del    --ref m0007 [--reason "why"]\n' +
    "  search <words> [--limit 10]\n" +
    "  check  [--file AGENTS.jsonl]\n" +
    "  import <file.md> [--out AGENTS.jsonl] [--force]\n" +
    "  render [--file AGENTS.jsonl] [--out AGENTS.md]\n" +
    "  prune  --max-tokens 12000 | --max N [--file AGENTS.jsonl]\n" +
    "  stats  [--file AGENTS.jsonl]\n" +
    "  merge  [--file AGENTS.jsonl]\n" +
    "  guard  [dir ...] [--verbose] [--strict] [--unlock]  keep AGENTS.md == store, archiving any drift\n"
  );
}

export const commands: Record<string, Command> = {
  add: cmdAdd,
  edit: cmdEdit,
  del: cmdDel,
  search: cmdSearch,
  check: cmdCheck,
  import: cmdImport,
  render: cmdRender,
  prune: cmdPrune,
  stats: cmdStats,
  merge: cmdMerge,
  guard: cmdGuard,
};

/** Entry point. Runs the same dispatch the `require.main` guard used to do. */
export function runCli(argv: string[] = process.argv.slice(2)): void {
  const [cmd, ...rest] = argv;
  if (!cmd || !commands[cmd]) {
    process.stdout.write(usage());
    process.exit(cmd ? 1 : 0);
  }
  try {
    commands[cmd](rest);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

if (require.main === module) {
  runCli();
}
