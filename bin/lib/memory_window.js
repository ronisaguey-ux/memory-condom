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

const DEFAULT_WINDOW_TURNS = 3;
const LOCKED_MESSAGE =
  "MEMORY_LOCKED: you may not edit AGENTS.md/AGENTS.jsonl outside the post-compaction window. Write to state/artifacts/<name>.md instead; you will get one memory edit immediately after the next compaction.";

function defaultState() {
  return {
    window_open: false,
    edits_remaining: 0,
    opened_at_turn: null,
    opened_at: null,
    last_compaction_id: null,
    current_turn: 0,
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
    };
  } catch (_) {
    // Missing or corrupt state defaults to locked
    return defaultState();
  }
}

function writeState(targetDir, state) {
  const file = resolveStateFile(targetDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(
    {
      window_open: state.window_open,
      edits_remaining: state.edits_remaining,
      opened_at_turn: state.opened_at_turn,
      opened_at: state.opened_at,
      last_compaction_id: state.last_compaction_id,
      current_turn: state.current_turn,
    },
    null,
    2
  );
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Open window on compaction event. Resets edits_remaining to 1 (never stacks).
 */
function onCompaction(targetDir, sessionId, compactionId) {
  const state = readState(targetDir);
  state.window_open = true;
  state.edits_remaining = 1;
  state.opened_at_turn = state.current_turn;
  state.opened_at = new Date().toISOString();
  state.last_compaction_id = compactionId || `comp_${Date.now()}`;
  writeState(targetDir, state);
  appendLog(targetDir, `MEMORY_WINDOW_OPEN session=${sessionId}`);
  return state;
}

/**
 * Gate memory edit attempt. Returns allowed boolean or throws/rejects.
 */
function checkAndUseEdit(targetDir, sessionId, filePath) {
  const state = readState(targetDir);
  if (!state.window_open || state.edits_remaining <= 0) {
    return {
      allowed: false,
      message: LOCKED_MESSAGE,
    };
  }

  // Consume the single allowed edit
  state.edits_remaining = 0;
  state.window_open = false;
  writeState(targetDir, state);
  appendLog(targetDir, `MEMORY_EDIT_USED session=${sessionId} file=${filePath}`);
  return {
    allowed: true,
    message: "allowed",
  };
}

/**
 * Advance turn counter and check expiration.
 */
function onTurnComplete(targetDir, sessionId, windowTurns = DEFAULT_WINDOW_TURNS) {
  const state = readState(targetDir);
  state.current_turn += 1;

  if (state.window_open && state.edits_remaining === 1) {
    const elapsed = state.current_turn - (state.opened_at_turn ?? state.current_turn);
    if (elapsed >= windowTurns) {
      state.window_open = false;
      state.edits_remaining = 0;
      appendLog(targetDir, `MEMORY_WINDOW_EXPIRED session=${sessionId}`);
    }
  }

  writeState(targetDir, state);
  return state;
}

/**
 * Query window status for stack_ctl.py (open | closed | used).
 */
function getWindowStatus(targetDir) {
  const state = readState(targetDir);
  if (state.window_open && state.edits_remaining > 0) return "open";
  if (!state.window_open && state.edits_remaining === 0 && state.opened_at) return "used";
  return "closed";
}

module.exports = {
  DEFAULT_WINDOW_TURNS,
  LOCKED_MESSAGE,
  defaultState,
  resolveStateFile,
  resolveLogFile,
  readState,
  writeState,
  onCompaction,
  checkAndUseEdit,
  onTurnComplete,
  getWindowStatus,
};
