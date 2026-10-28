import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/test/engine.test.mjs'
let s = fs.readFileSync(p, 'utf8')

const start = s.indexOf("await test('\"no adapter registered\" failures are never recorded as dead routes'")
if (start === -1) throw new Error('test not found')
const endMarker = "/* ───────────────────────────── report ───────────────────────────── */"
const end = s.indexOf(endMarker)
if (end <= start) throw new Error('report marker missing')

const block = `await test('"no adapter registered" failures are never recorded as dead routes', async () => {
  const own = await mkdtemp(join(tmpdir(), 'agent-dispatch-noadapter-'))
  const ownExec = { agent: { session: { header: { cwd: own } } } }
  // a child that fails the turn the way dsh-llm does for an unknown provider
  const agents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      return {
        agent: {
          session,
          get status() { return 'idle' },
          followup() {
            setTimeout(() => emitSession(session, {
              type: 'turn/end',
              data: { reason: { kind: 'error', error: { message: 'no adapter registered for provider "ark"' } } },
            }), 0)
          },
          async whenIdle() {},
          cancel() {},
        },
        async dispose() {},
      }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRetries: 0 })
  await tools.get('dispatch_run').execute({
    goal: 'bad pin', wait: true,
    tasks: [{ id: 'x', prompt: 'x', provider: 'ark', model: 'ep-9' }],
  }, ownExec)
  const health = JSON.parse(await readFile(join(own, '.agent-dispatch', 'route-health.json'), 'utf8').catch(() => '{}'))
  assert.equal(health.routes?.['ark/ep-9'], undefined, 'an adapter-less pin must not become a dead route')
  await rm(own, { recursive: true, force: true }).catch(() => {})
})

`

s = s.slice(0, start) + block + s.slice(end)
fs.writeFileSync(p, s)
console.log('test rewritten to fail through the event feed')
