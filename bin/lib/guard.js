"use strict";
/**
 * Guard: keep every injected AGENTS.md exactly equal to its store.
 *
 * An agent that appends prose to AGENTS.md by hand is doing two harmful things at once — it
 * forks the source of truth and it rewrites the prompt prefix, invalidating the cache. The guard
 * makes that impossible to get away with: the drift is copied into an artifact (so no thought is
 * lost), the generated file is restored, and the incident is logged.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { renderMarkdown } = require("./markdown.js");
const { artifactDir } = require("../artifacts.js");

const LOG = path.join(os.homedir(), ".local/state/opencode/memory-condom-guard.log");

/** Every directory that carries a store: the global config dir plus each workspace agent. */
function storeDirs(extra = []) {
  const dirs = new Set(extra);
  dirs.add(path.join(os.homedir(), ".config/opencode"));
  const roots = (process.env.MEMCONDOM_ROOTS || "AGENT")
    .split(",")
    .filter(Boolean)
    .map((r) => (r === "AGENT" ? "/home/roni/Roni_workspace" : r));
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(root, e.name);
      if (fs.existsSync(path.join(p, "AGENTS.jsonl"))) dirs.add(p);
    }
  }
  return [...dirs].filter((d) => fs.existsSync(path.join(d, "AGENTS.jsonl")));
}

function log(line) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

/** Write the generated file, briefly lifting the read-only bit if the guard set it earlier. */
function writeLocked(file, content, { lock = true } = {}) {
  try {
    fs.chmodSync(file, 0o644);
  } catch {
    /* file may not exist yet */
  }
  fs.writeFileSync(file, content);
  if (lock) fs.chmodSync(file, 0o444);
}

function driftOf(expected, actual) {
  const exp = new Set(expected.split("\n"));
  const extra = actual.split("\n").filter((l) => l.trim() && !exp.has(l));
  const missing = expected.split("\n").filter((l) => l.trim() && !actual.includes(l));
  return { extra, missing };
}

/**
 * Repair one store. `dryRun` reports without writing.
 * Extra prose found in the hand-edited file is preserved as an artifact before being removed —
 * the guard restores the invariant without destroying what the agent was trying to record.
 */
function guardDir(dir, { dryRun = false, lock = true } = {}) {
  const store = path.join(dir, "AGENTS.jsonl");
  const target = path.join(dir, "AGENTS.md");
  const expected = renderMarkdown(store);
  const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";

  if (actual === expected) {
    // content is right; still enforce the read-only bit so a stray write fails loudly
    if (!dryRun && lock) {
      try {
        if ((fs.statSync(target).mode & 0o777) !== 0o444) fs.chmodSync(target, 0o444);
      } catch {
        /* no file yet */
      }
    }
    return { dir, status: "ok", repaired: 0, archived: null };
  }

  const { extra } = driftOf(expected, actual);
  let archived = null;
  if (extra.length) {
    const name = `drift-${path.basename(dir)}`;
    const body = [
      `# Hand-edited content captured from ${target}`,
      "",
      `${new Date().toISOString()} — the guard found ${extra.length} line(s) in AGENTS.md that were`,
      "not in the store. Preserved here, then removed from the generated file.",
      "",
      ...extra.map((l) => `- ${l.trim()}`),
      "",
    ].join("\n");
    if (!dryRun) {
      fs.mkdirSync(artifactDir(store), { recursive: true });
      const file = path.join(artifactDir(store), `${new Date().toISOString().slice(0, 10)}-${name}.md`);
      fs.writeFileSync(file, body);
      archived = file;
    }
  }

  if (!dryRun) writeLocked(target, expected, { lock });
  const status = extra.length ? "repaired+archived" : "repaired";
  log(`${dir} ${status} extra=${extra.length}${archived ? ` archived=${path.basename(archived)}` : ""}`);
  return { dir, status, repaired: extra.length, archived };
}

function guardAll(dirs = [], opts = {}) {
  return storeDirs(dirs).map((d) => guardDir(d, opts));
}

module.exports = { guardAll, guardDir, storeDirs, writeLocked, driftOf, LOG };
