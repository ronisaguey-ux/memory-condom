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
      bypass_count: state.bypass_count || 0,
      admin_override_count: state.admin_override_count || 0,
      is_admin_override: Boolean(state.is_admin_override),
    },
    null,
    2
  );
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, data + "\n");
  fs.renameSync(tmp, file);
}

function getSnapshotDir(targetDir) {
  const base = targetDir ? (path.basename(targetDir) === "state" ? path.dirname(targetDir) : targetDir) : process.cwd();
  return path.join(base, "state", ".memory_snapshot");
}

function computeFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (_) {
    return null;
  }
}

function snapshotMemory(targetDir) {
  try {
    const snapDir = getSnapshotDir(targetDir);
    fs.mkdirSync(snapDir, { recursive: true });
    const base = targetDir ? (path.basename(targetDir) === "state" ? path.dirname(targetDir) : targetDir) : process.cwd();
    const targets = ["AGENTS.md", "AGENTS.jsonl"];
    for (const name of targets) {
      const src = path.join(base, name);
      if (fs.existsSync(src)) {
        const dest = path.join(snapDir, name);
        fs.copyFileSync(src, dest);
        const hash = computeFileHash(src);
        if (hash) {
          fs.writeFileSync(path.join(snapDir, `${name}.sha256`), hash + "\n");
        }
      }
    }
  } catch (_) {}
}

function verifyAndRevertMemory(targetDir, sessionId) {
  try {
    const snapDir = getSnapshotDir(targetDir);
    const base = targetDir ? (path.basename(targetDir) === "state" ? path.dirname(targetDir) : targetDir) : process.cwd();
    const state = readState(targetDir);
    const targets = ["AGENTS.md", "AGENTS.jsonl"];

    let stateModified = false;

    for (const name of targets) {
      const src = path.join(base, name);
      const snapFile = path.join(snapDir, name);
      const hashFile = path.join(snapDir, `${name}.sha256`);

      if (!fs.existsSync(snapFile) || !fs.existsSync(hashFile)) {
        snapshotMemory(targetDir);
        continue;
      }

      const snapHash = fs.readFileSync(hashFile, "utf8").trim();
      const currHash = computeFileHash(src);

      if (currHash && snapHash && currHash !== snapHash) {
        // Hash changed!
        if (state.window_open && state.edits_remaining > 0) {
          // Authorized edit consumed during window
          const wasAdmin = Boolean(state.is_admin_override);
          state.edits_remaining = 0;
          state.window_open = false;
          state.is_admin_override = false;
          stateModified = true;
          if (wasAdmin) {
            appendLog(targetDir, `MEMORY_ADMIN_OVERRIDE_USED session=${sessionId} path=${src}`);
          } else {
            appendLog(targetDir, `MEMORY_EDIT_USED session=${sessionId} path=${src}`);
          }
          // Update snapshot to reflect authorized change
          fs.copyFileSync(src, snapFile);
          fs.writeFileSync(hashFile, currHash + "\n");
        } else {
          // UNLAWFUL BYPASS DETECTED!
          const prev8 = snapHash.slice(0, 8);
          const curr8 = currHash.slice(0, 8);
          appendLog(targetDir, `MEMORY_EDIT_BYPASS session=${sessionId} path=${src} prev=${prev8} curr=${curr8}`);

          // Revert file immediately from snapshot
          fs.copyFileSync(snapFile, src);

          state.bypass_count = (state.bypass_count || 0) + 1;
          stateModified = true;
        }
      }
    }

    if (stateModified) {
      writeState(targetDir, state);
    }
  } catch (_) {}
}

function isBashTool(tool) {
  if (!tool || typeof tool !== "string") return false;
  const t = tool.toLowerCase();
  return ["bash", "shell", "sh", "exec", "terminal", "run_command"].includes(t);
}

function extractBashCommand(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (input.command) return String(input.command);
  if (input.cmd) return String(input.cmd);
  if (input.script) return String(input.script);
  if (input.CommandLine) return String(input.CommandLine);
  return "";
}

function isBashMemoryMutation(command, targetDir) {
  if (!command || typeof command !== "string") return false;
  // Match AGENTS.md or AGENTS.jsonl (case-insensitive, optional path prefix)
  const memPattern = /(?:^|[\s"'`\\/=])(?:[a-zA-Z0-9_.\-\/]*\/)?AGENTS\.(?:md|jsonl)(?:$|[\s"'`\\/=;&|])/i;
  if (!memPattern.test(command)) return false;

  // Allow --dry-run
  if (command.includes("--dry-run")) return false;

  const trimmed = command.trim();
  const readOnlyPrefixes = /^(?:cat|grep|egrep|fgrep|head|tail|wc|diff|stat|file|less|more)\b/i;
  if (readOnlyPrefixes.test(trimmed)) {
    return false; // read-only safe
  }

  // Destructive redirects or mutators
  const hasRedirectOrWrite = /[>|]|sed\s+-i|tee\b|truncate\b|cp\b|mv\b|rm\b|touch\b|python\b|node\b|bun\b|perl\b|nano\b|vim\b|vi\b/i.test(command);
  if (hasRedirectOrWrite) return true;

  // Commands referencing memory without mutating operators (e.g. git checkout, git log, git status)
  // are not flagged by the preventive regex gate and fall through to the detective hash backstop.
  return false;
}

/**
 * Open window on compaction event. Resets edits_remaining to 1 (never stacks).
 * A second compaction inside an open window refreshes edits_remaining=1 but does not reset
 * opened_at_turn. The window expires at opened_at_turn + WINDOW_TURNS from the first compaction.
 */
function onCompaction(targetDir, sessionId, compactionId) {
  // Snapshot memory files at start of compaction window
  snapshotMemory(targetDir);

  const state = readState(targetDir);
  const wasOpen = state.window_open && state.opened_at_turn !== null;

  state.window_open = true;
  state.edits_remaining = 1;
  state.is_admin_override = false;
  if (!wasOpen) {
    state.opened_at_turn = state.current_turn;
    state.opened_at = new Date().toISOString();
  }
  state.last_compaction_id = compactionId || `comp_${Date.now()}`;
  writeState(targetDir, state);
  appendLog(targetDir, `MEMORY_WINDOW_OPEN session=${sessionId}`);
  return state;
}

/**
 * Admin override to open a single-edit memory window outside compaction.
 * Logs MEMORY_ADMIN_OVERRIDE admin=<user> reason=<text> session=<sid>.
 * Fails if reason is empty.
 */
function onAdminOverride(targetDir, sessionId, adminUser, reason) {
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    throw new Error("Admin override failed: reason must be non-empty");
  }
  const user = adminUser && typeof adminUser === "string" && adminUser.trim() ? adminUser.trim() : "admin";
  const sid = sessionId || "unknown";

  snapshotMemory(targetDir);

  const state = readState(targetDir);
  state.window_open = true;
  state.edits_remaining = 1;
  state.is_admin_override = true;
  state.admin_override_count = (state.admin_override_count || 0) + 1;
  writeState(targetDir, state);
  appendLog(targetDir, `MEMORY_ADMIN_OVERRIDE admin=${user} reason=${reason.trim()} session=${sid}`);
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

  // Check direct AGENTS.md edit
  const norm = String(filePath || "").replace(/\\/g, "/");
  if (norm.endsWith("/AGENTS.md") || norm === "AGENTS.md") {
    appendLog(
      targetDir,
      `MEMORY_EDIT_DIRECT session=${sessionId} warning=direct AGENTS.md edits diverge from source JSONL and will be overwritten on next render`
    );
  }

  // Consume the single allowed edit
  const wasAdmin = Boolean(state.is_admin_override);
  state.edits_remaining = 0;
  state.window_open = false;
  state.is_admin_override = false;
  writeState(targetDir, state);

  if (wasAdmin) {
    appendLog(targetDir, `MEMORY_ADMIN_OVERRIDE_USED session=${sessionId} file=${filePath}`);
  } else {
    appendLog(targetDir, `MEMORY_EDIT_USED session=${sessionId} file=${filePath}`);
  }

  return {
    allowed: true,
    message: "allowed",
  };
}

/**
 * Advance turn counter and check expiration.
 */
function onTurnComplete(targetDir, sessionId, windowTurns = DEFAULT_WINDOW_TURNS) {
  // Backstop: verify hashes and revert bypasses
  verifyAndRevertMemory(targetDir, sessionId);

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

function getBypassCount(targetDir) {
  const state = readState(targetDir);
  return Number(state.bypass_count || 0);
}

function getAdminOverrideCount(targetDir) {
  const state = readState(targetDir);
  return Number(state.admin_override_count || 0);
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
  onAdminOverride,
  checkAndUseEdit,
  onTurnComplete,
  getWindowStatus,
  getBypassCount,
  getAdminOverrideCount,
  isBashTool,
  extractBashCommand,
  isBashMemoryMutation,
  snapshotMemory,
  verifyAndRevertMemory,
  computeFileHash,
};
