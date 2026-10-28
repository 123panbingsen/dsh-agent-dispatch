import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/test/engine.test.mjs'
let s = fs.readFileSync(p, 'utf8')

const start = s.indexOf("await test('recording a failure keeps the verified-alive evidence'")
const end = s.indexOf("await test('a stored run with a stale running task reads back as cancelled'")
if (start === -1 || end === -1 || start >= end) throw new Error(`bounds ${start} ${end}`)

const block = `await test('recording a failure keeps the verified-alive evidence', async () => {
  // its own workspace: the health file is shared state, and other cases write it
  const own = await mkdtemp(join(tmpdir(), 'agent-dispatch-wipe-'))
  const ownExec = { agent: { session: { header: { cwd: own } } } }
  const healthDir = join(own, '.agent-dispatch')
  await mkdir(healthDir, { recursive: true })
  await writeFile(join(healthDir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: {},
    alive: { 'p2/long-1': { at: Date.now(), latencyMs: 900 } },
  }), 'utf8')
  // the WORKER must fail, so a route failure actually gets recorded
  const failingAgents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const agent = {
        session,
        get status() { return 'idle' },
        followup() {
          setTimeout(() => emitSession(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Authentication Fails, api key invalid' } } } }), 0)
        },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, async dispose() {} }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents: failingAgents, llm: makeLlm() } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRetries: 0 })
  await tools.get('dispatch_run').execute({
    goal: 'wipe check', wait: true,
    tasks: [{ id: 'x', prompt: 'x', provider: 'p1', model: 'text-1' }],
  }, ownExec)
  const health = JSON.parse(await readFile(join(healthDir, 'route-health.json'), 'utf8'))
  assert.ok(health.routes['p1/text-1'], 'the failure must be recorded')
  assert.ok(health.alive['p2/long-1'], 'the alive evidence must survive a failure write')
  assert.ok(health.providers?.p1, 'a dead shop must be remembered at provider level')
  deadRoutes.clear()
  await rm(own, { recursive: true, force: true }).catch(() => {})
})

`

s = s.slice(0, start) + block + s.slice(end)
fs.writeFileSync(p, s)
console.log('test isolated to its own workspace')
