"use strict";
/**
 * Guard: keep every injected AGENTS.md exactly equal to its store.
 *
 * An agent that appends prose to AGENTS.md by hand is doing two harmful things at once — it
 * forks the source of truth and it rewrites the prompt prefix, invalidating the cache. The guard
 * makes that impossible to get away with: the drift is copied into an artifact (so no thought is
 * lost), the generated file is restored, and the incident is logged.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG = void 0;
exports.storeDirs = storeDirs;
exports.writeLocked = writeLocked;
exports.driftOf = driftOf;
exports.guardDir = guardDir;
exports.guardAll = guardAll;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const markdown_js_1 = require("./markdown.js");
const artifacts_js_1 = require("../artifacts.js");
exports.LOG = path.join(os.homedir(), ".local/state/opencode/memory-condom-guard.log");
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
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const p = path.join(root, e.name);
            if (fs.existsSync(path.join(p, "AGENTS.jsonl")))
                dirs.add(p);
        }
    }
    return [...dirs].filter((d) => fs.existsSync(path.join(d, "AGENTS.jsonl")));
}
function log(line) {
    fs.mkdirSync(path.dirname(exports.LOG), { recursive: true });
    fs.appendFileSync(exports.LOG, `${new Date().toISOString()} ${line}\n`);
}
/** Write the generated file, briefly lifting the read-only bit if the guard set it earlier. */
function writeLocked(file, content, { lock = true } = {}) {
    try {
        fs.chmodSync(file, 0o644);
    }
    catch {
        /* file may not exist yet */
    }
    fs.writeFileSync(file, content);
    if (lock)
        fs.chmodSync(file, 0o444);
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
    const expected = (0, markdown_js_1.renderMarkdown)(store);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (actual === expected) {
        // content is right; still enforce the read-only bit so a stray write fails loudly
        if (!dryRun && lock) {
            try {
                if ((fs.statSync(target).mode & 0o777) !== 0o444)
                    fs.chmodSync(target, 0o444);
            }
            catch {
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
            fs.mkdirSync((0, artifacts_js_1.artifactDir)(store), { recursive: true });
            const file = path.join((0, artifacts_js_1.artifactDir)(store), `${new Date().toISOString().slice(0, 10)}-${name}.md`);
            fs.writeFileSync(file, body);
            archived = file;
        }
    }
    if (!dryRun)
        writeLocked(target, expected, { lock });
    const status = extra.length ? "repaired+archived" : "repaired";
    log(`${dir} ${status} extra=${extra.length}${archived ? ` archived=${path.basename(archived)}` : ""}`);
    return { dir, status, repaired: extra.length, archived };
}
function guardAll(dirs = [], opts = {}) {
    return storeDirs(dirs).map((d) => guardDir(d, opts));
}
