// Drives the plugin with the V2 context shapes from the official server-plugin docs:
//   ctx.session.hook("compaction", cb)
//   ctx.event.subscribe({ types, signal }) -> AsyncIterable
//   ctx.tool.hook("execute.before", cb)
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const workspace = join(homedir(), '.local/state/opencode/mc-plugin-test')
rmSync(workspace, { recursive: true, force: true })
mkdirSync(join(workspace, 'state'), { recursive: true })
writeFileSync(join(workspace, 'AGENTS.jsonl'), '')

const pending = (id, text) => ({
  id,
  op: 'add',
  target: 'plugin',
  text,
  created_at: new Date().toISOString(),
  applied_at: null,
  applied_compaction: null,
})
writeFileSync(
  join(workspace, 'state', 'future_memories.json'),
  JSON.stringify([pending('fm_hook_1', 'the compaction hook applied this')])
)

const plugin = await import('/home/roni-saguey/.config/opencode/plugins/memory-condom-queue.ts')

let compactionHook = null
let toolHook = null
let eventOptions = null
let emitted = false
let resolveEvent
const eventReady = new Promise((r) => (resolveEvent = r))

const ctx = {
  location: { directory: workspace },
  session: {
    hook: async (name, cb) => {
      if (name === 'compaction') compactionHook = cb
      return { dispose: async () => {} }
    },
    get: async () => ({ directory: workspace }),
  },
  event: {
    subscribe: (options) => {
      eventOptions = options
      resolveEvent()
      return {
        async *[Symbol.asyncIterator]() {
          while (!emitted) await new Promise((r) => setTimeout(r, 50))
          yield { type: 'session.compacted', data: { sessionID: 'ses_test' } }
        },
      }
    },
  },
  tool: {
    hook: async (name, cb) => {
      if (name === 'execute.before') toolHook = cb
      return { dispose: async () => {} }
    },
  },
}

const cleanup = await plugin.default.setup(ctx)

console.log(compactionHook ? 'ok   registered ctx.session.hook("compaction")' : 'FAIL no compaction hook')
console.log(eventOptions?.types?.includes('session.compacted') ? 'ok   event.subscribe filters session.compacted' : 'FAIL event types filter missing')
console.log(toolHook ? 'ok   registered ctx.tool.hook("execute.before")' : 'FAIL no tool hook')

await compactionHook({ sessionID: 'ses_test', directory: workspace })

const waitFor = async (needle, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (readFileSync(join(workspace, 'AGENTS.jsonl'), 'utf8').includes(needle)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

const hookApplied = await waitFor('the compaction hook applied this')
console.log(hookApplied ? 'ok   compaction hook applied the queue' : 'FAIL compaction hook did not apply')
console.log(existsSync(join(workspace, 'AGENTS.md')) ? 'ok   AGENTS.md re-rendered' : 'FAIL AGENTS.md missing')

// Second entry, applied through the compacted event backstop.
writeFileSync(
  join(workspace, 'state', 'future_memories.json'),
  JSON.stringify([pending('fm_event_1', 'the compacted event applied this')])
)
await eventReady
emitted = true
const eventApplied = await waitFor('the compacted event applied this')
console.log(eventApplied ? 'ok   compacted event applied the queue' : 'FAIL compacted event did not apply')

let blocked = false
try {
  await toolHook({ tool: 'write', input: { filePath: join(workspace, 'AGENTS.jsonl') } })
} catch (error) {
  blocked = String(error.message).includes('queue')
}
console.log(blocked ? 'ok   raw store write refused' : 'FAIL raw store write allowed')

let shellBlocked = false
try {
  await toolHook({ tool: 'bash', input: { command: `sed -i 's/a/b/' ${workspace}/AGENTS.jsonl` } })
} catch (error) {
  shellBlocked = String(error.message).includes('queue')
}
console.log(shellBlocked ? 'ok   shell mutation refused' : 'FAIL shell mutation allowed')

let allowed = true
try {
  await toolHook({ tool: 'bash', input: { command: 'ls /home/roni-saguey | head -3' } })
} catch {
  allowed = false
}
console.log(allowed ? 'ok   ordinary tool untouched' : 'FAIL ordinary tool blocked')

cleanup()
const log = readFileSync(join(homedir(), '.local/state/opencode/memory-queue.log'), 'utf8').trim().split('\n').slice(-2)
console.log(log.join('\n'))
