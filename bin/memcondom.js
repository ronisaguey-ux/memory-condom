#!/usr/bin/env node
/**
 * memory-condom — append-only, one-line-per-memory store for agent instructions.
 *
 * Why: an instruction file edited in the middle invalidates the model's prompt cache on every
 * edit, and free-form prose is re-read on every turn. Records are only ever appended, so the
 * prefix stays identical between turns, each fact stays terse, and the file is machine-checkable.
 *
 * Canonical store: AGENTS.jsonl. Rendered view: AGENTS.md (deterministic, insertion order).
 * Library: bin/lib/store.js (records), bin/lib/markdown.js (import/render), bin/artifacts.js.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { LIMITS, readStore, validate, nextId, resolve, rank } = require("./lib/store.js");
const { importMarkdown, renderMarkdown, mergeFragments } = require("./lib/markdown.js");
const { guardAll, guardDir, writeLocked } = require("./lib/guard.js");

process.stdout.on("error", () => {});

const OPS = new Set(["edit", "del"]);
const today = () => new Date().toISOString().slice(0, 10);

function die(msg) {
  process.stderr.write(`memory-condom: ${msg}\n`);
  process.exit(1);
}

function append(file, rec) {
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}

function cmdAdd(argv) {
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  const records = readStore(file);
  const rec = { id: args.id || nextId(records), ts: args.ts || today(), topic: args.topic, text: args.text };
  if (args.tags) rec.tags = String(args.tags).split(",").map((s) => s.trim()).filter(Boolean);
  if (args.refs) rec.refs = String(args.refs).split(",").map((s) => s.trim()).filter(Boolean);
  const errs = validate(rec, new Set(records.map((r) => r.id)));
  if (errs.length) die(`refused to append:\n  - ${errs.join("\n  - ")}`);
  append(file, rec);
  process.stdout.write(`appended ${rec.id} (${records.length + 1} lines)\n`);
}

function cmdEdit(argv) {
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  if (!args.ref) die('usage: memcondom edit --ref m0007 --text "corrected fact"');
  const records = readStore(file);
  if (!records.some((r) => r.id === args.ref && !OPS.has(r.op))) die(`no record ${args.ref}`);
  const rec = { op: "edit", ref: args.ref, ts: today(), text: args.text };
  if (args.topic) rec.topic = args.topic;
  const errs = validate(rec);
  if (errs.length) die(`refused:\n  - ${errs.join("\n  - ")}`);
  append(file, rec);
  process.stdout.write(`edited ${args.ref} by append (prefix unchanged)\n`);
}

function cmdDel(argv) {
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  if (!args.ref) die('usage: memcondom del --ref m0007 [--reason "superseded"]');
  const records = readStore(file);
  if (!records.some((r) => r.id === args.ref && !OPS.has(r.op))) die(`no record ${args.ref}`);
  const rec = { op: "del", ref: args.ref, ts: today() };
  if (args.reason) rec.reason = String(args.reason).slice(0, 120);
  append(file, rec);
  process.stdout.write(`deleted ${args.ref} by append (prefix unchanged)\n`);
}

function cmdSearch(argv) {
  const args = parseArgs(argv);
  const query = (args._ || []).join(" ").trim();
  if (!query) die("usage: memcondom search <words> [--limit 10]");
  const hits = rank(resolve(readStore(args.file || "AGENTS.jsonl")), query).slice(0, parseInt(args.limit || "10", 10));
  if (!hits.length) return process.stdout.write("no matches\n");
  for (const { rec, score } of hits)
    process.stdout.write(`${rec.id}\t${score.toFixed(1)}\t${rec.topic}\t${rec.text.slice(0, 160)}\n`);
}

function cmdCheck(argv) {
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  const records = readStore(file);
  const ids = new Set(records.filter((r) => !OPS.has(r.op)).map((r) => r.id));
  const seen = new Set();
  let bad = 0;
  records.forEach((r, i) => {
    const errs = validate(r, seen);
    if (!OPS.has(r.op)) seen.add(r.id);
    if (OPS.has(r.op) && !ids.has(r.ref)) errs.push(`ref ${r.ref} does not exist`);
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

function cmdImport(argv) {
  const args = parseArgs(argv);
  const src = args._[0] || die("usage: memcondom import <file.md> [--out AGENTS.jsonl] [--force]");
  const out = args.out || "AGENTS.jsonl";
  if (fs.existsSync(out) && !args.force) die(`${out} exists; pass --force to overwrite`);
  const records = importMarkdown(fs.readFileSync(src, "utf8"), { ts: args.ts });
  fs.writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`imported ${records.length} records -> ${out}\n`);
}

function cmdRender(argv) {
  const args = parseArgs(argv);
  const text = renderMarkdown(args.file || "AGENTS.jsonl");
  if (args.out) writeLocked(args.out, text, { lock: Boolean(args.lock) });
  else process.stdout.write(text);
}

function cmdGuard(argv) {
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

function cmdPrune(argv) {
  // Occasional and explicit: never part of the normal write path.
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  const max = parseInt(args.max || "0", 10);
  if (!max) die("usage: memcondom prune --max <n> [--archive AGENTS.jsonl.archive]");
  const records = readStore(file);
  const live = resolve(records);
  if (live.length <= max) return process.stdout.write(`nothing to prune (${live.length} live <= ${max})\n`);
  const keepIds = new Set(live.slice(live.length - max).map((r) => r.id));
  const keep = records.filter((r) => (OPS.has(r.op) ? keepIds.has(r.ref) : keepIds.has(r.id)));
  const drop = records.filter((r) => !keep.includes(r));
  const archive = args.archive || file + ".archive";
  fs.appendFileSync(archive, drop.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`archived ${drop.length} lines, kept ${keep.length} (archive: ${archive})\n`);
}

function cmdStats(argv) {
  const args = parseArgs(argv);
  const records = readStore(args.file || "AGENTS.jsonl");
  const live = resolve(records);
  const byTopic = {};
  for (const r of live) byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
  const chars = live.reduce((n, r) => n + (r.text || "").length, 0);
  process.stdout.write(
    `${live.length} live records (${records.length} lines), ${chars} chars (~${Math.ceil(chars / 4)} tokens), ` +
      `${Object.keys(byTopic).length} topics\n`
  );
  for (const [t, n] of Object.entries(byTopic).sort((a, b) => b[1] - a[1]).slice(0, 12))
    process.stdout.write(`  ${t}: ${n}\n`);
}

function cmdMerge(argv) {
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  const records = readStore(file);
  const { records: merged, joined } = mergeFragments(records);
  fs.writeFileSync(file, merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(`merged ${joined} fragments, ${records.length} -> ${merged.length} records\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
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

function usage() {
  return (
    "memory-condom <add|edit|del|search|check|import|render|prune|stats|merge|guard>\n" +
    '  add    --topic T --text S [--tags a,b] [--refs m0001,m0002] [--file AGENTS.jsonl]\n' +
    '  edit   --ref m0007 --text "corrected fact" [--topic T]\n' +
    '  del    --ref m0007 [--reason "why"]\n' +
    "  search <words> [--limit 10]\n" +
    "  check  [--file AGENTS.jsonl]\n" +
    "  import <file.md> [--out AGENTS.jsonl] [--force]\n" +
    "  render [--file AGENTS.jsonl] [--out AGENTS.md]\n" +
    "  prune  --max N [--file AGENTS.jsonl]\n" +
    "  stats  [--file AGENTS.jsonl]\n" +
    "  merge  [--file AGENTS.jsonl]\n" +
    "  guard  [dir ...] [--verbose] [--strict] [--unlock]  keep AGENTS.md == store, archiving any drift\n"
  );
}

const commands = {
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

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    process.stdout.write(usage());
    process.exit(cmd ? 1 : 0);
  }
  try {
    commands[cmd](rest);
  } catch (e) {
    die(e.message);
  }
}

module.exports = { commands, parseArgs };
