#!/usr/bin/env node
/**
 * artifacts — long-form notes that are NEVER injected into the prompt.
 *
 * The memory store is for facts the model must always see. This is where the rest goes: reasoning,
 * drafts, logs, tables, anything that would be expensive repeated on every turn. The agent writes
 * it, gets a path back, and reads it only when it actually needs it (progressive disclosure).
 *
 * Files live in <store dir>/artifacts/, one markdown file per artifact, named
 * YYYY-MM-DD-<slug>.md so listing is chronological and stable.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function artifactDir(storeFile) {
  if (process.env.MEMCONDOM_ARTIFACTS) return process.env.MEMCONDOM_ARTIFACTS;
  const base = storeFile ? path.dirname(path.resolve(storeFile)) : process.cwd();
  const stateArtifacts = path.join(base, "state", "artifacts");
  if (fs.existsSync(path.join(base, "state")) || fs.existsSync(stateArtifacts)) {
    return stateArtifacts;
  }
  return path.join(base, "artifacts");
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note";
}

function updateIndex(dir, topic, relativePath) {
  try {
    const indexPath = path.join(dir, "index.md");
    const now = new Date();
    const stamp = now.toISOString().replace("T", " ").slice(0, 16);
    fs.appendFileSync(indexPath, `${stamp} ${topic} ${relativePath}\n`);
  } catch (_) {}
}

function rotateArtifacts(storeFile) {
  try {
    const dir = artifactDir(storeFile);
    if (!fs.existsSync(dir)) return 0;
    const archiveDir = path.join(dir, "archive");
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    let moved = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const age = now - st.mtimeMs;
      const unreadAge = now - st.atimeMs;

      if (age > thirtyDaysMs && unreadAge > sevenDaysMs) {
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.renameSync(full, path.join(archiveDir, f));
        moved++;
      }
    }
    return moved;
  } catch (_) {
    return 0;
  }
}

function writeArtifact(name, content, storeFile) {
  const dir = artifactDir(storeFile);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${stamp}-${slugify(name)}`;
  let file = path.join(dir, `${base}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}.md`);
  const body = String(content || "");
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  const relPath = path.basename(file);
  updateIndex(dir, slugify(name), relPath);
  rotateArtifacts(storeFile);
  const lines = body.split("\n").length;
  return `${relPath}\t${body.length} bytes\t${lines} lines\t(content NOT injected — read it on demand)`;
}

function listArtifacts(storeFile, limit = 40) {
  const dir = artifactDir(storeFile);
  if (!fs.existsSync(dir)) return "(no artifacts yet)";
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "index.md")
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, Math.min(limit, 200)));
  if (!files.length) return "(no artifacts yet)";
  return files
    .map(({ f, size }) => {
      const head = fs.readFileSync(path.join(dir, f), "utf8").split("\n").find((l) => l.trim()) || "";
      return `${f}\t${size}b\t${head.replace(/^#+\s*/, "").slice(0, 80)}`;
    })
    .join("\n");
}

function resolveArtifact(name, storeFile) {
  const dir = artifactDir(storeFile);
  const direct = path.join(dir, path.basename(String(name)));
  if (fs.existsSync(direct)) return direct;
  const withMd = direct.endsWith(".md") ? direct : `${direct}.md`;
  if (fs.existsSync(withMd)) return withMd;
  const needle = slugify(name);
  if (fs.existsSync(dir)) {
    const hit = fs.readdirSync(dir).filter((f) => f.includes(needle) && f !== "index.md").sort().pop();
    if (hit) return path.join(dir, hit);
  }
  throw new Error(`no artifact matching ${name}`);
}

function readArtifact(name, storeFile, offset = 0, limit = 200) {
  const file = resolveArtifact(name, storeFile);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = Math.max(0, Number(offset) || 0);
  const end = start + Math.max(1, Math.min(Number(limit) || 200, 2000));
  const slice = lines.slice(start, end);
  const more = end < lines.length ? `\n... (${lines.length - end} more lines; call again with offset ${end})` : "";
  return `${path.basename(file)} [${start + 1}-${Math.min(end, lines.length)}/${lines.length}]\n${slice.join("\n")}${more}`;
}

function grepArtifacts(query, storeFile, limit = 40) {
  const dir = artifactDir(storeFile);
  if (!fs.existsSync(dir)) return "(no artifacts yet)";
  const needle = String(query || "").toLowerCase();
  if (!needle) throw new Error("query required");
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md") && x !== "index.md").sort()) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push(`${f}:${i + 1}\t${lines[i].trim().slice(0, 160)}`);
        break;
      }
    }
    if (hits.length >= Math.min(Number(limit) || 40, 200)) break;
  }
  return hits.length ? hits.join("\n") : "no matches";
}

module.exports = {
  artifactDir,
  writeArtifact,
  listArtifacts,
  readArtifact,
  grepArtifacts,
  resolveArtifact,
  updateIndex,
  rotateArtifacts,
};
