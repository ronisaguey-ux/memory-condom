"use strict";

/**
 * memory_window.js — Post-Compaction-Only Memory Edit Window State Machine
 *
 * Implements the invariant: an agent may edit injected memory (AGENTS.md / AGENTS.jsonl)
 * only once, and only inside the window immediately following a compaction event.
 * Outside that window, notes must go to non-injected artifacts (state/artifacts/<topic>.md).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Owner (2026-10-28): a compaction opens an 80-TURN budget, not a single edit. One edit was
// too tight for a stack that learns several things an hour; 80 turns covers the work that
// follows a compaction while keeping memory edits off the hot path. Artifacts are never
// gated — state/artifacts/<name>.md is writable at any time, window or not.
const DEFAULT_WINDOW_TURNS = Number(process.env.MEMORY_WINDOW_TURNS || 80);
const LOCKED_MESSAGE =
  `MEMORY_LOCKED: memory edits are only allowed inside the ${DEFAULT_WINDOW_TURNS}-turn window that opens after a compaction. Write the note to state/artifacts/<name>.md instead — artifacts are always writable — and it will be promoted next time the window opens.`;

function memoryUnlockMessage(turns = DEFAULT_WINDOW_TURNS) {
  return (
    `COMPACTION DONE — MEMORY UNLOCKED for the next ${turns} turns. ` +
    "Write the durable facts you learned now (write_memory / edit_memory); memory locks again when the window closes. " +
    "Anything that does not belong in injected memory still goes to state/artifacts/<name>.md, which is never locked."
  );
}

function defaultState() {
  return {
    window_open: false,
    edits_remaining: 0,
    turns_remaining: 0,
    edits_used: 0,
    opened_at_turn: null,
    opened_at: null,
    last_compaction_id: null,
    current_turn: 0,
    bypass_count: 0,
    admin_override_count: 0,
    is_admin_override: false,
  };
}

function resolveStateFile(targetDir) {
  if (!targetDir) targetDir = process.cwd();
  if (path.basename(targetDir) === "state") {
    return path.join(targetDir, "memory_window.json");
  }
  return path.join(targetDir, "state", "memory_window.json");
}

function resolveLogFile(targetDir) {
  if (!targetDir) targetDir = process.cwd();
  if (path.basename(targetDir) === "state") {
    return path.join(targetDir, "memory-window.log");
  }
  return path.join(targetDir, "state", "memory-window.log");
}

function appendLog(targetDir, line) {
  try {
    const logFile = resolveLogFile(targetDir);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(logFile, `${stamp} ${line}\n`);
  } catch (_) {
    // Non-fatal logging
  }
}

function readState(targetDir) {
  const file = resolveStateFile(targetDir);
  try {
    if (!fs.existsSync(file)) return defaultState();
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.window_open !== "boolean" ||
      typeof parsed.edits_remaining !== "number"
    ) {
      return defaultState();
    }
    return {
      window_open: Boolean(parsed.window_open),
      edits_remaining: Number(parsed.edits_remaining),
      opened_at_turn: parsed.opened_at_turn ?? null,
      opened_at: parsed.opened_at ?? null,
      last_compaction_id: parsed.last_compaction_id ?? null,
      current_turn: Number(parsed.current_turn || 0),
      bypass_count: Number(parsed.bypass_count || 0),
      admin_override_count: Number(parsed.admin_override_count || 0),
      is_admin_override: Boolean(parsed.is_admin_override),
    };
  } catch (_) {
    // Missing or corrupt state defaults to locked
    return defaultState();
  }
}
