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
const { LIMITS, readStore, readArchive, validate, nextId, resolve, rank } = require("./lib/store.js");
const { importMarkdown, renderMarkdown, mergeFragments, renderTokens, budget } = require("./lib/markdown.js");
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
  const file = args.file || "AGENTS.jsonl";
  const live = resolve(readStore(file)).map((r) => ({ ...r }));
  const archived = resolve(readArchive(file)).map((r) => ({ ...r, archived: true }));
  const seenIds = new Set(live.map((r) => r.id));
  const hits = rank([...live, ...archived.filter((r) => !seenIds.has(r.id))], query).slice(0, parseInt(args.limit || "10", 10));
  if (!hits.length) return process.stdout.write("no matches\n");
  for (const { rec, score } of hits)
    process.stdout.write(
      `${rec.id}\t${score.toFixed(1)}\t${rec.topic}${rec.archived ? "\t[archived]" : ""}\t${rec.text.slice(0, 160)}\n`
    );
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

const PINNED_TOPICS = new Set(["memory-condom", "diaries", "keys"]);

/** Priority lists live next to the store so each agent can protect what it must never forget. */
function protectedPrefixes(file) {
  const candidates = [
    process.env.MEMCONDOM_PRIORITY,
    path.join(path.dirname(path.resolve(file)), "memory-priority.json"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const doc = JSON.parse(fs.readFileSync(c, "utf8"));
      if (Array.isArray(doc.protect_prefixes)) return doc.protect_prefixes;
    } catch {
      /* fall through to the default */
    }
  }
  return ["0-", "1-", "memory-condom", "diaries", "keys"];
}

function cmdPrune(argv) {
  // Explicit and rare. Two modes: --max <records> or --max-tokens <n> (the one that matters).
  // Oldest goes first, except operating rules: dropping those would make an agent forget how to
  // write memory at all. Everything removed is appended to <store>.archive and stays searchable.
  const args = parseArgs(argv);
  const file = args.file || "AGENTS.jsonl";
  const maxRecords = parseInt(args.max || "0", 10);
  const maxTokens = parseInt(args["max-tokens"] || "0", 10);
  if (!maxRecords && !maxTokens) die("usage: memcondom prune --max-tokens 12000 [--file AGENTS.jsonl]");

  const records = readStore(file);
  const live = resolve(records);
  const prefixes = protectedPrefixes(file);
  const pinned = (r) =>
    PINNED_TOPICS.has(r.topic) ||
    (r.tags || []).includes("pin") ||
    prefixes.some((p) => String(r.topic || "").startsWith(p));
  const pinnedIds = new Set(live.filter(pinned).map((r) => r.id));
  const droppable = live.filter((r) => !pinnedIds.has(r.id)); // oldest first

  const kept = new Set(pinnedIds);
  if (maxTokens) {
    // Walk newest-first, admitting records until the rendered file would exceed the budget.
    const charsOf = (r) => (r.text || "").length + (r.topic || "").length + 24;
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

  const keep = records.filter((r) => (OPS.has(r.op) ? kept.has(r.ref) : kept.has(r.id)));
  const drop = records.filter((r) => !keep.includes(r));
  if (!drop.length) return process.stdout.write(`nothing to prune (${live.length} live, ~${renderTokens(file)} tokens)\n`);

  const archive = args.archive || file + ".archive";
  fs.appendFileSync(archive, drop.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stdout.write(
    `archived ${drop.length} lines, kept ${keep.length} records, now ~${renderTokens(file)} tokens (cap ${maxTokens || "-"})\n`
  );
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
    "  prune  --max-tokens 12000 | --max N [--file AGENTS.jsonl]\n" +
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
