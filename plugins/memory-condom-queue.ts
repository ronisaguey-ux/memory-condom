/**
 * memory-condom-queue.ts — apply queued memory changes right after a compaction.
 *
 * Owner (2026-11-19): there is no 80-turn edit window any more. An agent may queue a
 * memory change (add / edit an existing fact / delete an existing fact) at any moment,
 * and every queued change is applied exactly once in the turn that follows a compaction.
 * Injected memory therefore never changes mid-turn, which is what keeps the provider
 * prompt prefix warm.
 *
 * Two bindings:
 * 1. ctx.event.subscribe -> "session.compacted": run `memcondom-mcp --apply-queued <dir>`,
 *    which applies the queue, re-renders AGENTS.md, and freezes the applied entries.
 * 2. ctx.tool.hook("execute.before"): refuse direct writes to AGENTS.md / AGENTS.jsonl
 *    (file tools and shell mutations) and point the caller at write_memory / queue_memory,
 *    so every change goes through the queue instead of landing invisibly mid-session.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const MCP = "/home/roni/Roni_workspace/memory-condom/bin/memcondom-mcp.js";
const LOG = join(homedir(), ".local/state/opencode/memory-queue.log");

const QUEUE_HINT =
  "MEMORY_QUEUED_ONLY: injected memory is written only through the queue. Use " +
  "write_memory / queue_memory to add a fact, queue_edit to correct one, queue_delete to remove one. " +
  "They apply once, right after the next compaction. Use write_artifact for anything long.";

function log(line: string): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** The store directory for a workspace: its own AGENTS.jsonl, else the global one. */
function storeDirFor(workspace: string): string {
  if (workspace && existsSync(join(workspace, "AGENTS.jsonl"))) return workspace;
  return join(homedir(), ".config/opencode");
}

function applyQueue(workspace: string, reason: string): void {
  const dir = storeDirFor(workspace);
  try {
    const child = spawn(process.execPath, [MCP, "--apply-queued", dir], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 500);
    });
    child.on("exit", (code) => {
      log(`apply(${reason}) dir=${dir} code=${code}${stderr ? ` err=${stderr.trim()}` : ""}`);
    });
    child.unref();
  } catch (error) {
    log(`apply(${reason}) failed: ${(error as Error).message}`);
  }
}

function isMemoryFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const norm = filePath.replace(/\\/g, "/");
  return norm.endsWith("/AGENTS.md") || norm.endsWith("/AGENTS.jsonl") ||
    norm === "AGENTS.md" || norm === "AGENTS.jsonl";
}

function shellTouchesMemory(command: string): boolean {
  if (!command) return false;
  if (!/AGENTS\.(md|jsonl)/.test(command)) return false;
  return /(^|[^>])>{1,2}\s*[^\s|&;]*AGENTS\.(md|jsonl)|tee\s+[^\s|&;]*AGENTS\.(md|jsonl)|sed\s+-i|python3?\s+-c|perl\s+-i|\bcp\b|\bmv\b|\brsync\b/.test(command);
}

function handleEvent(evt: any): void {
  try {
    const type = evt?.type;
    const sid = evt?.data?.sessionID || evt?.sessionID || "unknown";
    if (type !== "session.compacted") return;
    const workspace = evt?.data?.directory || evt?.directory || process.cwd();
    log(`compacted session=${sid} workspace=${workspace}`);
    applyQueue(workspace, "compaction");
  } catch (error) {
    log(`event failed: ${(error as Error).message}`);
  }
}

function registerPlugin(ctx: any): void {
  const workspaceDir = ctx?.location?.directory || process.cwd();

  if (typeof ctx?.event?.subscribe === "function") {
    try {
      ctx.event.subscribe((evt: any) => handleEvent(evt));
    } catch (error) {
      log(`subscribe failed: ${(error as Error).message}`);
    }
  }

  try {
    ctx.tool?.hook?.("execute.before", async (info: any) => {
      const tool = String(info?.tool || "");
      const input = info?.input || {};
      const filePath = String(input.filePath || input.path || input.file || "");

      if (isMemoryFile(filePath)) throw new Error(QUEUE_HINT);

      if (["bash", "sh", "shell", "exec", "terminal"].includes(tool)) {
        const command = String(input.command || input.cmd || "");
        if (shellTouchesMemory(command)) throw new Error(QUEUE_HINT);
      }
      return;
    });
  } catch (error) {
    log(`tool hook failed: ${(error as Error).message}`);
  }
}

export default {
  id: "memory-condom-queue",
  setup: registerPlugin,
};
