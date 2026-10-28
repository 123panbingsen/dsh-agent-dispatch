import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../plugin/index.js')

const cwd = await mkdtemp(join(tmpdir(), 'wipe-check-'))
const exec = { agent: { session: { header: { cwd } } } }

const listeners = new Map()
const emit = (session, event) => {
  for (const fn of listeners.get('session/event') ?? []) fn(session, event)
}
const agents = {
  list: () => [],
  async create(options) {
    const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
    const agent = {
      session,
      get status() { return 'idle' },
      followup() {
        setTimeout(() => emit(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Authentication Fails, api key invalid' } } } }), 0)
      },
      async whenIdle() {},
      cancel() {},
    }
    return { agent, async dispose() {} }
  },
}
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  tools: { register: (def) => { ctx.__tools.set(def.name, def); return () => {} } },
  effect: (fn) => { const d = fn(); return () => d },
  on: (name, fn) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn) },
  get: (name) => (name === 'webServer' ? { register: () => () => {} } : name === 'agents' ? agents : undefined),
  __tools: new Map(),
}

const healthDir = join(cwd, '.agent-dispatch')
await mkdir(healthDir, { recursive: true })
await writeFile(join(healthDir, 'route-health.json'), JSON.stringify({
  version: 1,
  routes: {},
  alive: { 'p2/long-1': { at: Date.now(), latencyMs: 900 } },
}), 'utf8')

plugin.apply(ctx, {
  workers: [
    { id: 'dsh', kind: 'dsh', provider: 'p1', model: 'text-1' },
    { id: 'rev', kind: 'dsh', provider: 'p2', model: 'vision-1' },
  ],
  routing: { any: ['dsh'] },
  maxRetries: 0,
})

const run = await ctx.__tools.get('dispatch_run').execute({
  goal: 'wipe check', wait: true,
  tasks: [{ id: 'x', prompt: 'x', provider: 'p1', model: 'text-1' }],
}, exec)

console.log('task:', JSON.stringify({ status: run.tasks[0].status, provider: run.tasks[0].provider, model: run.tasks[0].model, error: (run.tasks[0].error ?? '').slice(0, 60) }))
const health = JSON.parse(await readFile(join(healthDir, 'route-health.json'), 'utf8'))
console.log('health keys:', Object.keys(health))
console.log('routes:', JSON.stringify(health.routes))
console.log('alive:', JSON.stringify(health.alive))
console.log('providers:', JSON.stringify(health.providers))
