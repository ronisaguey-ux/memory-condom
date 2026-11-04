/**
 * memory_window — Post-Compaction-Only Memory Edit Window State Machine
 *
 * Implements the invariant: an agent may edit injected memory (AGENTS.md / AGENTS.jsonl)
 * only once, and only inside the window immediately following a compaction event.
 * Outside that window, notes must go to non-injected artifacts (state/artifacts/<topic>.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Owner (2026-10-28): a compaction opens an 80-TURN budget, not a single edit. One edit was
// too tight for a stack that learns several things an hour; 80 turns covers the work that
// follows a compaction while keeping memory edits off the hot path. Artifacts are never
// gated — state/artifacts/<name>.md is writable at any time, window or not.
export const DEFAULT_WINDOW_TURNS = Number(process.env.MEMORY_WINDOW_TURNS || 80);
export const LOCKED_MESSAGE =
  `MEMORY_LOCKED: memory edits are only allowed inside the ${DEFAULT_WINDOW_TURNS}-turn window that opens after a compaction. Write the note to state/artifacts/<name>.md instead — artifacts are always writable — and it will be promoted next time the window opens.`;

/** Persisted window state. `turns_remaining`/`edits_used` are only present once a window opened. */
export interface WindowState {
  window_open: boolean;
  edits_remaining: number;
  turns_remaining?: number;
  edits_used?: number;
  opened_at_turn: number | null;
  opened_at: string | null;
  last_compaction_id: string | null;
  current_turn: number;
  bypass_count: number;
  admin_override_count: number;
  is_admin_override: boolean;
}

export interface GateResult {
  allowed: boolean;
  message: string;
}

export function memoryUnlockMessage(turns: number = DEFAULT_WINDOW_TURNS): string {
  return (
    `COMPACTION DONE — MEMORY UNLOCKED for the next ${turns} turns. ` +
    "Write the durable facts you learned now (write_memory / edit_memory); memory locks again when the window closes. " +
    "Anything that does not belong in injected memory still goes to state/artifacts/<name>.md, which is never locked."
  );
}

export function defaultState(): WindowState {
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

export function resolveStateFile(targetDir?: string): string {
  if (!targetDir) targetDir = process.cwd();
  if (path.basename(targetDir) === "state") {
    return path.join(targetDir, "memory_window.json");
  }
  return path.join(targetDir, "state", "memory_window.json");
}

export function resolveLogFile(targetDir?: string): string {
  if (!targetDir) targetDir = process.cwd();
  if (path.basename(targetDir) === "state") {
    return path.join(targetDir, "memory-window.log");
  }
  return path.join(targetDir, "state", "memory-window.log");
}

function appendLog(targetDir: string | undefined, line: string): void {
  try {
    const logFile = resolveLogFile(targetDir);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stamp = new Date().toISOString();
    fs.appendFileSync(logFile, `${stamp} ${line}\n`);
  } catch {
    // Non-fatal logging
  }
}

export function readState(targetDir?: string): WindowState {
  const file = resolveStateFile(targetDir);
  try {
    if (!fs.existsSync(file)) return defaultState();
    const raw = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).window_open !== "boolean" ||
      typeof (parsed as Record<string, unknown>).edits_remaining !== "number"
    ) {
      return defaultState();
    }
    const p = parsed as Record<string, unknown>;
    return {
      window_open: Boolean(p.window_open),
      edits_remaining: Number(p.edits_remaining),
      opened_at_turn: (p.opened_at_turn as number | null) ?? null,
      opened_at: (p.opened_at as string | null) ?? null,
      last_compaction_id: (p.last_compaction_id as string | null) ?? null,
      current_turn: Number(p.current_turn || 0),
      bypass_count: Number(p.bypass_count || 0),
      admin_override_count: Number(p.admin_override_count || 0),
      is_admin_override: Boolean(p.is_admin_override),
    };
  } catch {
    // Missing or corrupt state defaults to locked
    return defaultState();
  }
}

export function writeState(targetDir: string | undefined, state: WindowState): void {
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

function getSnapshotDir(targetDir?: string): string {
  const base = targetDir
    ? path.basename(targetDir) === "state"
      ? path.dirname(targetDir)
      : targetDir
    : process.cwd();
  return path.join(base, "state", ".memory_snapshot");
}

export function computeFileHash(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function snapshotMemory(targetDir?: string): void {
  try {
    const snapDir = getSnapshotDir(targetDir);
    fs.mkdirSync(snapDir, { recursive: true });
    const base = targetDir
      ? path.basename(targetDir) === "state"
        ? path.dirname(targetDir)
        : targetDir
      : process.cwd();
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
  } catch {}
}

export function verifyAndRevertMemory(targetDir?: string, sessionId?: string): void {
  try {
    const snapDir = getSnapshotDir(targetDir);
    const base = targetDir
      ? path.basename(targetDir) === "state"
        ? path.dirname(targetDir)
        : targetDir
      : process.cwd();
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
          // Authorized edit inside the 80-turn budget. It does NOT consume the window:
          // the budget is turns, so the hash is refreshed and the window stays open.
          const wasAdmin = Boolean(state.is_admin_override);
          state.edits_used = (state.edits_used || 0) + 1;
          stateModified = true;
          if (wasAdmin) {
            appendLog(targetDir, `MEMORY_ADMIN_OVERRIDE_USED session=${sessionId} path=${src}`);
          } else {
            appendLog(
              targetDir,
              `MEMORY_EDIT_USED session=${sessionId} path=${src} turns_left=${state.turns_remaining}`
            );
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
  } catch {}
}

export function isBashTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "string") return false;
  const t = tool.toLowerCase();
  return ["bash", "shell", "sh", "exec", "terminal", "run_command"].includes(t);
}

export function extractBashCommand(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  const i = input as Record<string, unknown>;
  if (i.command) return String(i.command);
  if (i.cmd) return String(i.cmd);
  if (i.script) return String(i.script);
  if (i.CommandLine) return String(i.CommandLine);
  return "";
}

export function isBashMemoryMutation(command: unknown, targetDir?: string): boolean {
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
export function onCompaction(targetDir: string | undefined, sessionId: string | undefined, compactionId?: string): WindowState {
  // Snapshot memory files at start of compaction window
  snapshotMemory(targetDir);

  const state = readState(targetDir);
  const wasOpen = state.window_open && state.opened_at_turn !== null;

  state.window_open = true;
  state.turns_remaining = DEFAULT_WINDOW_TURNS;
  state.edits_remaining = DEFAULT_WINDOW_TURNS;
  state.is_admin_override = false;
  if (!wasOpen) {
    state.opened_at_turn = state.current_turn;
    state.opened_at = new Date().toISOString();
  }
  state.last_compaction_id = compactionId || `comp_${Date.now()}`;
  writeState(targetDir, state);
  appendLog(
    targetDir,
    `MEMORY_WINDOW_OPEN session=${sessionId} turns=${state.turns_remaining} (${DEFAULT_WINDOW_TURNS})`
  );
  return state;
}

/**
 * Admin override to open a single-edit memory window outside compaction.
 * Logs MEMORY_ADMIN_OVERRIDE admin=<user> reason=<text> session=<sid>.
 * Fails if reason is empty.
 */
export function onAdminOverride(
  targetDir: string | undefined,
  sessionId: string | undefined,
  adminUser: string | undefined,
  reason: string
): WindowState {
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
export function checkAndUseEdit(
  targetDir: string | undefined,
  sessionId: string | undefined,
  filePath: string | undefined
): GateResult {
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

  // An edit inside the window costs a log line, not the window: the budget is turns.
  const wasAdmin = Boolean(state.is_admin_override);
  state.edits_used = (state.edits_used || 0) + 1;
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
export function onTurnComplete(
  targetDir: string | undefined,
  sessionId: string | undefined,
  windowTurns: number = DEFAULT_WINDOW_TURNS
): WindowState {
  // Backstop: verify hashes and revert bypasses
  verifyAndRevertMemory(targetDir, sessionId);

  const state = readState(targetDir);
  state.current_turn += 1;

  if (state.window_open) {
    const elapsed = state.current_turn - (state.opened_at_turn ?? state.current_turn);
    const remaining = Math.max(0, windowTurns - elapsed);
    state.turns_remaining = remaining;
    state.edits_remaining = remaining;
    if (state.turns_remaining <= 0) {
      state.window_open = false;
      appendLog(targetDir, `MEMORY_WINDOW_EXPIRED session=${sessionId} after ${windowTurns} turns`);
    }
  }

  writeState(targetDir, state);
  return state;
}

/**
 * Query window status for stack_ctl.py (open | closed | used).
 */
export function getWindowStatus(targetDir?: string): string {
  const state = readState(targetDir);
  if (state.window_open && state.edits_remaining > 0) return "open";
  if (!state.window_open && state.edits_remaining === 0 && state.opened_at) return "used";
  return "closed";
}

export function getBypassCount(targetDir?: string): number {
  const state = readState(targetDir);
  return Number(state.bypass_count || 0);
}

export function getAdminOverrideCount(targetDir?: string): number {
  const state = readState(targetDir);
  return Number(state.admin_override_count || 0);
}
