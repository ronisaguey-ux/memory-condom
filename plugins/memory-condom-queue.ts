/**
 * memory-condom-queue.ts — OpenCode V2 plugin: apply queued memory changes at compaction.
 *
 * Uses the documented V2 server API (https://opencode.ai/v2/docs/build/plugins/server):
 *   - ctx.session.hook("compaction", cb)  runs for every checkpoint summary; the queue is
 *     applied there, so the summary and the turn that follows it read updated memory.
 *   - ctx.event.subscribe({ types, signal }) is an AsyncIterable; "session.compacted" is the
 *     backstop in case a compaction path skips the session hook.
 *   - ctx.tool.hook("execute.before", cb) refuses raw writes to AGENTS.md / AGENTS.jsonl so a
 *     change can only travel through the queue.
 *
 * Owner (2026-11-19): there is no turn window any more. Queue a fact whenever you learn it
 * (write_memory / queue_memory), correct or drop an existing one (queue_edit / queue_delete),
 * and the whole queue lands exactly once at the next compaction.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const MCP = "/home/roni/Roni_workspace/memory-condom/bin/memcondom-mcp.js";
// OpenCode's own runtime is not a plain node binary: spawning through process.execPath would
// hand the applier's flags to the CLI. Use the real node that the compactor config already uses.
const NODE = existsSync("/home/roni-saguey/.local/bin/node") ? "/home/roni-saguey/.local/bin/node" : process.execPath;
const LOG = join(homedir(), ".local/state/opencode/memory-queue.log");

const QUEUE_HINT =
  "MEMORY_QUEUED_ONLY: injected memory changes only through the queue. " +
  "write_memory / queue_memory add a fact, queue_edit corrects one, queue_delete removes one — " +
  "they apply once at the next compaction. Use write_artifact for anything long.";

interface PluginCtx {
  location?: { directory?: string };
  session?: { hook?: (name: string, cb: (event: any) => unknown) => Promise<unknown>; get?: (input: any) => Promise<any> };
  event?: { subscribe?: (options?: { types?: string[]; signal?: AbortSignal }) => AsyncIterable<any> };
  tool?: { hook?: (name: string, cb: (event: any) => unknown) => Promise<unknown> };
}

function log(line: string): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function storeDir(candidate?: string): string {
  if (candidate && existsSync(join(candidate, "AGENTS.jsonl"))) return candidate;
  return join(homedir(), ".config/opencode");
}

/** Run the applier once. It is idempotent: applied entries are frozen. */
function applyQueue(workspace: string | undefined, reason: string): void {
  const dir = storeDir(workspace);
  try {
    const child = spawn(NODE, [MCP, "--apply-queued", dir], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 400);
    });
    child.on("exit", (code) => log(`apply(${reason}) dir=${dir} code=${code}${stderr ? ` err=${stderr.trim()}` : ""}`));
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
  return /(^|[^>])>{1,2}\s*[^\s|&;]*AGENTS\.(md|jsonl)|tee\s+[^\s|&;]*AGENTS\.(md|jsonl)|sed\s+-i|python3?\s+-c|perl\s+-i|\bcp\b|\bmv\b|\brsync\b/.test(
    command
  );
}

async function registerPlugin(ctx: PluginCtx): Promise<() => void> {
  const home = ctx.location?.directory;
  const cleanups: Array<() => void> = [];

  // Primary trigger: OpenCode's own compaction hook.
  try {
    if (ctx.session?.hook) {
      await ctx.session.hook("compaction", (event: any) => {
        const sid = event?.sessionID;
        const dir = event?.directory || home;
        log(`compaction hook session=${sid || "?"} workspace=${dir || "?"}`);
        applyQueue(dir, "compaction-hook");
      });
    }
  } catch (error) {
    log(`session hook failed: ${(error as Error).message}`);
  }

  // Backstop: the compacted event, consumed as the async iterable V2 documents.
  try {
    if (ctx.event?.subscribe) {
      const controller = new AbortController();
      cleanups.push(() => controller.abort());
      void (async () => {
        try {
          for await (const event of ctx.event!.subscribe!({ types: ["session.compacted"], signal: controller.signal })) {
            const sid = event?.data?.sessionID || event?.sessionID;
            let dir = event?.data?.directory || event?.directory;
            if (!dir && sid && ctx.session?.get) {
              try {
                const info = await ctx.session.get({ sessionID: sid });
                dir = info?.directory;
              } catch {}
            }
            log(`compacted event session=${sid || "?"} workspace=${dir || home || "?"}`);
            applyQueue(dir || home, "compacted-event");
          }
        } catch (error) {
          log(`event stream ended: ${(error as Error).message}`);
        }
      })();
    }
  } catch (error) {
    log(`subscribe failed: ${(error as Error).message}`);
  }

  // Writes go through the queue, never straight into the injected file.
  try {
    if (ctx.tool?.hook) {
      await ctx.tool.hook("execute.before", (event: any) => {
        const tool = String(event?.tool || "");
        const input = event?.input || {};
        if (isMemoryFile(String(input.filePath || input.path || input.file || ""))) throw new Error(QUEUE_HINT);
        if (["bash", "sh", "shell", "exec", "terminal"].includes(tool)) {
          if (shellTouchesMemory(String(input.command || input.cmd || ""))) throw new Error(QUEUE_HINT);
        }
      });
    }
  } catch (error) {
    log(`tool hook failed: ${(error as Error).message}`);
  }

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {}
    }
  };
}

export default {
  id: "memory-condom-queue",
  setup: registerPlugin,
};
