/**
 * Engine-level verification for dsh-agent-dispatch.
 *
 * The plugin imports no `@deepseek-ai/*` module, so its whole Host half can be
 * driven from plain Node with a structural stand-in for the pieces of `ctx` it
 * touches. This exercises the real code paths: routing, the dependency DAG,
 * concurrency, failure propagation, timeout, persistence and the HTTP payload.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import('../plugin/index.js')

let failures = 0
const results = []

async function test(name, body) {
  try {
    await body()
    results.push(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    results.push(`FAIL  ${name}\n        ${String(error?.message ?? error).split('\n').join('\n        ')}`)
  }
}

/** Set by makeCtx so fake child agents can publish committed session events. */
let emitSession = () => {}

/** A ctx stand-in: records tool definitions, answers `get`, and carries an event feed. */
function makeCtx({ services = {} } = {}) {
  const tools = new Map()
  const routes = new Map()
  const listeners = new Map()
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose
    },
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        }
      }
      return services[name]
    },
  }
  emitSession = (session, event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
  }
  return { ctx, tools, routes }
}

/** A fake DSH agent registry whose children answer with predictable text. */
function makeAgents({ text = (prompt) => `echo:${prompt}`, delayMs = 0, onDispose } = {}) {
  // Used by the acceptance tests: each review call consumes one verdict.
  return makeAgentsInner({ text, delayMs, onDispose })
}

function makeAgentsInner({ text, delayMs, onDispose }) {
  const spawned = []
  return {
    spawned,
    list: () => [],
    async create(options) {
      spawned.push(options)
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const agent = {
        session,
        get status() { return 'idle' },
        followup(message) {
          const prompt = message.content?.[0]?.text ?? ''
          setTimeout(() => {
            emitSession(session, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: text(prompt) }] } },
            })
            emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }, delayMs)
        },
        async whenIdle() {
          await new Promise((done) => setTimeout(done, delayMs + 5))
        },
        cancel() {},
      }
      return {
        agent,
        async dispose() {
          disposed = true
          onDispose?.(options)
        },
      }
    },
  }
}

/** Routes the fake llm refuses, so probe tests can simulate an expired key. */
const deadRoutes = new Set()

/** A fake llm registry: one text provider, one with a vision and a long-context model. */
function makeLlm() {
  const table = {
    p1: [{ id: 'text-1', name: 'Text One', inputModalities: ['text'] }],
    p2: [
      { id: 'vision-1', name: 'Vision One', inputModalities: ['text', 'image'], contextWindow: 200_000 },
      { id: 'long-1', name: 'Long One', inputModalities: ['text'], contextWindow: 1_000_000 },
    ],
  }
  return {
    stream({ provider, model }) {
      const key = `${provider}/${model}`
      return (async function* () {
        if (deadRoutes.has(key)) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'api key invalid' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: 'O' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }],
    async listModels(provider) {
      if (table[provider] === undefined) throw new Error(`unknown provider ${provider}`)
      return table[provider]
    },
  }
}

/* ───────────────────────────── infrastructure ───────────────────────────── */

const workdir = await mkdtemp(join(tmpdir(), 'agent-dispatch-test-'))
const cwd = workdir
const exec = { agent: { session: { header: { cwd } } } }

/* ───────────────────────────── tests ───────────────────────────── */

await test('registers the twelve dispatch tools', async () => {
  const { ctx, tools } = makeCtx()
  plugin.apply(ctx, {})
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['dispatch_cancel', 'dispatch_capabilities', 'dispatch_cloud', 'dispatch_models', 'dispatch_probe', 'dispatch_research', 'dispatch_result', 'dispatch_run', 'dispatch_status', 'dispatch_workers', 'outsource_run', 'outsource_team'],
  )
})

await test('dispatch_models reads the live llm registry with vision flags', async () => {
  const llm = makeLlm()
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_models').execute({ refresh: true }, exec)
  assert.equal(value.available, true)
  assert.equal(value.providers.length, 2)
  const vision = value.routes.filter((route) => route.vision).map((route) => route.model)
  assert.deepEqual(vision, ['vision-1'], 'only the image-capable model may be flagged')
  const longCtx = value.routes.find((route) => route.model === 'long-1')
  assert.equal(longCtx.contextWindow, 1_000_000)
})

await test('a task that needs vision is routed to the image-capable model', async () => {
  const agents = makeAgents()
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_run').execute({
    goal: 'capability routing',
    wait: true,
    tasks: [
      { id: 'look', prompt: 'describe this screenshot', type: 'image', needs: ['vision'] },
      { id: 'plain', prompt: 'write code', type: 'implement' },
    ],
  }, exec)
  const byId = Object.fromEntries(value.tasks.map((task) => [task.id, task]))
  assert.equal(byId.look.model, 'vision-1', 'vision task must reach the vision model')
  assert.equal(byId.plain.status, 'done')
  assert.notEqual(byId.plain.model, 'vision-1', 'a plain task keeps the default route')
  // The route must reach the child agent, not just the board.
  const routes = agents.spawned.map((entry) => entry.agentOptions?.model ?? null)
  assert.ok(routes.includes('vision-1'), `spawned routes: ${JSON.stringify(routes)}`)
})

await test('a declared capability class routes to the model named for it', async () => {
  const agents = makeAgents()
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {
    capabilities: { coding: ['p2/long-1'], reasoning: ['p2/vision-1'] },
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'capability class',
    wait: true,
    tasks: [
      { id: 'c', prompt: 'write code', type: 'implement', needs: ['coding'] },
      { id: 'r', prompt: 'think hard', type: 'review', needs: ['reasoning'] },
    ],
  }, exec)
  const byId = Object.fromEntries(value.tasks.map((task) => [task.id, task]))
  assert.equal(byId.c.model, 'long-1', 'coding class must win over modality facts')
  assert.equal(byId.r.model, 'vision-1')
})

await test('dispatch_capabilities resolves every entry against the live catalog', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm: makeLlm() } })
  plugin.apply(ctx, {
    capabilities: { coding: ['p2/long-1'], fast: ['p9/ghost-1'] },
  })
  const value = await tools.get('dispatch_capabilities').execute({ refresh: true }, exec)
  const byNeed = Object.fromEntries(value.declared.map((entry) => [entry.need, entry]))
  assert.equal(byNeed.coding.known, true)
  assert.equal(byNeed.fast.known, false, 'an invented route must be reported, not trusted')
  assert.match(byNeed.fast.detail, /not in the live catalog/)
})

await test('dispatch_research drops routes the catalog does not serve', async () => {
  const agents = makeAgents({
    text: (prompt) => prompt.includes('用人能力表')
      ? '这是我的结论：{"coding":["p2/long-1","p9/invented"],"reasoning":["p2/vision-1"]} 以上。'
      : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { fast: ['p2/long-1'] } })
  const value = await tools.get('dispatch_research').execute({ scout: 'p1/text-1' }, exec)
  const byNeed = Object.fromEntries(value.capabilities.map((entry) => [entry.need, entry.routes]))
  assert.deepEqual(byNeed.coding, ['p2/long-1'], 'an invented model must be dropped')
  assert.ok(value.rejected.includes('p9/invented'), `rejected: ${JSON.stringify(value.rejected)}`)
  assert.equal(value.file.endsWith('capabilities.json'), true)
})

await test('a researched capability table routes a later run', async () => {
  const agents = makeAgents({
    text: (prompt) => prompt.includes('用人能力表')
      ? '{"coding":["p2/long-1"]}'
      : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {})
  await tools.get('dispatch_research').execute({ scout: 'p1/text-1' }, exec)
  const value = await tools.get('dispatch_run').execute({
    goal: 'after research',
    wait: true,
    tasks: [{ id: 'c', prompt: 'write code', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].model, 'long-1', 'the researched table must drive routing')
})

await test('an explicit model on a task overrides routing', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm: makeLlm() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_run').execute({
    goal: 'explicit route',
    wait: true,
    tasks: [{ id: 'pin', prompt: 'x', needs: ['vision'], provider: 'p1', model: 'text-1' }],
  }, exec)
  assert.equal(value.tasks[0].model, 'text-1')
})

await test('a profile without the llm service degrades instead of throwing', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_models').execute({}, exec)
  assert.equal(value.available, false)
  assert.match(value.error, /llm service/)
  const run = await tools.get('dispatch_run').execute({
    goal: 'no llm', wait: true, tasks: [{ id: 'a', prompt: 'x', needs: ['vision'] }],
  }, exec)
  assert.equal(run.status, 'done', 'the run must still work on the default route')
})

await test('dispatch_workers reports an available dsh worker and a missing CLI', async () => {
  const agents = makeAgents()
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {
    workers: [
      { id: 'dsh', kind: 'dsh' },
      { id: 'nope', kind: 'cli', command: 'definitely-not-a-real-binary-xyz' },
    ],
  })
  const value = await tools.get('dispatch_workers').execute({}, exec)
  const byId = Object.fromEntries(value.workers.map((worker) => [worker.id, worker]))
  assert.equal(byId.dsh.available, true)
  assert.equal(byId.dsh.kind, 'dsh')
  assert.equal(byId.nope.available, false, 'a missing binary must be reported unavailable')
  assert.match(byId.nope.detail, /not found/)
})

await test('dispatch_run executes a dependency DAG in order and persists state', async () => {
  const agents = makeAgents()
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { stateDir: '.agent-dispatch', maxParallel: 2 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'verify the dag',
    wait: true,
    tasks: [
      { id: 'a', prompt: 'first', type: 'research' },
      { id: 'b', prompt: 'second', type: 'implement', dependsOn: ['a'] },
      { id: 'c', prompt: 'third', type: 'test' },
    ],
  }, exec)

  assert.equal(value.status, 'done')
  const byId = Object.fromEntries(value.tasks.map((task) => [task.id, task]))
  for (const id of ['a', 'b', 'c']) {
    assert.equal(byId[id].status, 'done', `task ${id} should be done`)
    assert.equal(byId[id].worker, 'dsh', `task ${id} should route to the dsh worker`)
  }
  assert.deepEqual(agents.spawned.map((entry) => entry.meta.cwd), [cwd, cwd, cwd])

  const stored = JSON.parse(await readFile(join(cwd, '.agent-dispatch', 'state.json'), 'utf8'))
  assert.equal(stored.version, 1)
  const mine = stored.runs.find((entry) => entry.id === value.run_id)
  assert.ok(mine, 'the finished run must be persisted under its own id')
  assert.equal(mine.tasks.length, 3)
})

await test('a dependency runs strictly after the task it depends on', async () => {
  const order = []
  const agents = makeAgents()
  const original = agents.create.bind(agents)
  agents.create = async (options) => {
    const handle = await original(options)
    order.push(options.meta.cwd)
    return handle
  }
  // Record the order tasks actually finish in.
  const finished = []
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { maxParallel: 2 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'ordering',
    wait: true,
    tasks: [
      { id: 'late', prompt: 'L', dependsOn: ['early'] },
      { id: 'early', prompt: 'E' },
    ],
  }, exec)
  assert.equal(value.status, 'done')
  const statuses = Object.fromEntries(value.tasks.map((task) => [task.id, task.status]))
  assert.equal(statuses.early, 'done')
  assert.equal(statuses.late, 'done')
})

await test('a failed task skips its dependents instead of running them', async () => {
  const { ctx, tools } = makeCtx({
    services: {
      agents: makeAgents({ text: () => '' }),
    },
  })
  plugin.apply(ctx, { maxParallel: 1 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'failure propagation',
    wait: true,
    tasks: [
      { id: 'root', prompt: 'will fail' },
      { id: 'child', prompt: 'must not run', dependsOn: ['root'] },
    ],
  }, exec)
  const byId = Object.fromEntries(value.tasks.map((task) => [task.id, task]))
  assert.equal(byId.root.status, 'failed')
  assert.match(byId.root.error, /without assistant text/)
  assert.equal(byId.child.status, 'skipped')
  assert.match(byId.child.error, /dependency/)
})

await test('a dependency cycle is rejected before any worker starts', async () => {
  const agents = makeAgents()
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {})
  await assert.rejects(
    () => tools.get('dispatch_run').execute({
      goal: 'cycle',
      tasks: [
        { id: 'x', prompt: 'x', dependsOn: ['y'] },
        { id: 'y', prompt: 'y', dependsOn: ['x'] },
      ],
    }, exec),
    /cycle/,
  )
  assert.equal(agents.spawned.length, 0, 'nothing may spawn for a rejected plan')
})

await test('an unknown dependency is rejected', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {})
  await assert.rejects(
    () => tools.get('dispatch_run').execute({
      goal: 'bad dep',
      tasks: [{ id: 'x', prompt: 'x', dependsOn: ['ghost'] }],
    }, exec),
    /unknown task "ghost"/,
  )
})

await test('a hanging worker is killed by the timeout and marked failed', async () => {
  const agents = {
    list: () => [],
    async create() {
      return {
        agent: {
          session: { id: 'silent-child', header: { cwd: workdir } },
          get status() { return 'idle' },
          followup() {},
          async whenIdle() { await new Promise(() => {}) }, // never settles
          cancel() {},
        },
        async dispose() {},
      }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { timeoutMs: 120 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'timeout',
    wait: true,
    tasks: [{ id: 'stuck', prompt: 'never finishes' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.match(value.tasks[0].error, /never started a turn|timed out/)
})

await test('dispatch_status and dispatch_result read a settled run back', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents({ text: (p) => `result for ${p}` }) } })
  plugin.apply(ctx, {})
  const run = await tools.get('dispatch_run').execute({
    goal: 'read back',
    wait: true,
    tasks: [{ id: 'only', prompt: 'payload' }],
  }, exec)
  const status = await tools.get('dispatch_status').execute({ run_id: run.run_id }, exec)
  assert.equal(status.status, 'done')
  assert.equal(status.tasks[0].id, 'only')
  const detail = await tools.get('dispatch_result').execute({ task_id: 'only', run_id: run.run_id }, exec)
  assert.match(detail.output, /result for payload/)
})

await test('routing by task type prefers a worker declared for that type', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{ id: 'dsh', kind: 'dsh' }, { id: 'slow-cli', kind: 'cli', command: 'node' }],
    routing: { implement: ['slow-cli'], review: ['dsh'] },
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'routing',
    tasks: [{ id: 'forced', prompt: 'x', type: 'implement', worker: 'dsh' }],
  }, exec)
  // An explicit worker must win over the type routing table.
  assert.equal(value.tasks[0].worker, 'dsh')
})

await test('the state route answers with runs and without leaking a bare 500', async () => {
  const { ctx, routes } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, { stateDir: '.agent-dispatch' })
  const route = routes.get('/api/agent-dispatch/state')
  assert.ok(route, 'the state route must be mounted')
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status) { captured.status = status; return this },
    end(body) { captured.body = body ?? ''; return this },
  }
  await route.handler({ url: '/api/agent-dispatch/state', headers: {} }, res)
  assert.equal(captured.status, 200)
  const payload = JSON.parse(captured.body)
  assert.equal(payload.version, 1)
  assert.ok(Array.isArray(payload.runs))
  // the board needs the staff list, with a revision it can diff
  assert.ok(Array.isArray(payload.workers), 'the board must receive the worker roster')
  assert.ok(payload.workers.length > 0, 'the roster must not be empty')
  assert.equal(typeof payload.rosterRevision, 'string')
  for (const worker of payload.workers) {
    assert.equal(typeof worker.id, 'string')
    assert.ok(['alive', 'dead', 'unknown'].includes(worker.status), `bad status: ${worker.status}`)
  }
})

await test('the roster revision tracks worker changes', async () => {
  const read = async (routes) => {
    const captured = { body: '' }
    await routes.get('/api/agent-dispatch/state').handler(
      { url: '/api/agent-dispatch/state', headers: {} },
      { writeHead() { return this }, end(body) { captured.body = body ?? ''; return this } },
    )
    return JSON.parse(captured.body)
  }
  const a = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(a.ctx, { workers: [{ id: 'only', kind: 'dsh' }] })
  const first = await read(a.routes)
  const second = await read(a.routes)
  assert.equal(first.workers.length, 1, 'the roster must list the declared worker')
  assert.equal(first.workers[0].id, 'only')
  assert.equal(second.rosterRevision, first.rosterRevision, 'an unchanged roster keeps its revision')

  const b = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(b.ctx, { workers: [{ id: 'only', kind: 'dsh', provider: 'p1', model: 'text-1' }] })
  const third = await read(b.routes)
  assert.equal(third.workers[0].model, 'text-1', 'the roster must report the bound route')
  assert.notEqual(third.rosterRevision, first.rosterRevision, 'a binding change must change the revision')
})

await test('unload cancels every live run', async () => {
  const agents = {
    list: () => [],
    async create() {
      return {
        agent: {
          session: { id: 'silent-child', header: { cwd: workdir } },
          get status() { return 'idle' },
          followup() {},
          async whenIdle() { await new Promise(() => {}) },
          cancel() {},
        },
        async dispose() {},
      }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  let teardown
  const originalEffect = ctx.effect
  ctx.effect = (fn, label) => {
    const dispose = fn()
    if (label === 'agent-dispatch.teardown') teardown = dispose
    return () => dispose?.()
  }
  plugin.apply(ctx, { timeoutMs: 60_000 })
  const run = await tools.get('dispatch_run').execute({
    goal: 'cancel on unload',
    tasks: [{ id: 'live', prompt: 'hangs' }],
  }, exec)
  assert.equal(run.status, 'running')
  assert.equal(typeof teardown, 'function')
  teardown()
  ctx.effect = originalEffect
  await new Promise((done) => setTimeout(done, 400))
  const status = await tools.get('dispatch_status').execute({ run_id: run.run_id }, exec)
  assert.ok(['cancelled', 'failed'].includes(status.status), `expected cancellation, got ${status.status}`)
})

await test('a cli worker runs a real subprocess and substitutes placeholders', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{
      id: 'node-cli',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("cli-saw:" + process.argv[1])', '{prompt}'],
    }],
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'cli adapter',
    wait: true,
    tasks: [{ id: 'one', prompt: 'HELLO', type: 'implement' }],
  }, exec)
  assert.equal(value.tasks[0].worker, 'node-cli')
  assert.equal(value.tasks[0].status, 'done', `cli task failed: ${value.tasks[0].error ?? ''}`)
  assert.match(value.tasks[0].output, /cli-saw:HELLO/)
})

await test('a cli worker that never exits is killed by the timeout', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    timeoutMs: 700,
    workers: [{
      id: 'hang',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
    }],
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'cli timeout',
    wait: true,
    tasks: [{ id: 'hang', prompt: 'x' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.match(value.tasks[0].error, /timed out after/)
})

await test('a cli worker with a non-zero exit is reported as failed', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{
      id: 'boom',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'console.error("nope"); process.exit(3)'],
    }],
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'exit code',
    wait: true,
    tasks: [{ id: 'boom', prompt: 'x' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.match(value.tasks[0].error, /code 3/)
})

/* ───────────────────── acceptance (AI outsourcing) ───────────────────── */

const ROUTED_WORKERS = [
  { id: 'dsh', kind: 'dsh', provider: 'p1', model: 'text-1' },
  { id: 'rev', kind: 'dsh', provider: 'p2', model: 'vision-1' },
]

/** Answer review prompts from a script; everything else is ordinary work. */
function reviewScript(verdicts) {
  let index = 0
  return (prompt) => {
    if (prompt.includes('你是验收方')) {
      const verdict = verdicts[Math.min(index, verdicts.length - 1)]
      index += 1
      return verdict === 'pass'
        ? '{"verdict":"pass","issues":[]}'
        : '{"verdict":"block","issues":["缺少错误处理","未覆盖边界"]}'
    }
    return `work:${prompt.split(String.fromCharCode(10))[0].slice(0, 40)}`
  }
}

await test('a passed acceptance records the reviewer and delivers', async () => {
  const agents = makeAgents({ text: reviewScript(['pass']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] } })
  const value = await tools.get('outsource_run').execute({
    goal: 'outsource a report',
    tasks: [{ id: 'a', prompt: 'write the report', subject: '报告' }],
  }, exec)
  assert.equal(value.status, 'done')
  assert.equal(value.delivered, 1)
  assert.equal(value.tasks[0].verdict, 'pass')
  assert.match(value.tasks[0].reviewBy, /vision-1/, 'the reviewer must be the other route')
})

await test('the reviewer is a different model than the implementer', async () => {
  const agents = makeAgents({ text: reviewScript(['pass']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] } })
  await tools.get('outsource_run').execute({
    goal: 'separation of duty',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  const used = agents.spawned.map((entry) => entry.agentOptions?.model).filter(Boolean)
  assert.ok(used.includes('text-1'), `implementer route missing: ${JSON.stringify(used)}`)
  assert.ok(used.includes('vision-1'), `reviewer route missing: ${JSON.stringify(used)}`)
})

await test('a blocked deliverable is sent back once and then passes', async () => {
  const agents = makeAgents({ text: reviewScript(['block', 'pass']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRework: 2 })
  const value = await tools.get('outsource_run').execute({
    goal: 'rework once',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done')
  assert.equal(value.tasks[0].verdict, 'pass')
  assert.equal(value.tasks[0].rework, 1)
  assert.equal(value.reworks, 1)
})

await test('a deliverable that never passes acceptance fails with the reason', async () => {
  const agents = makeAgents({ text: reviewScript(['block']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRework: 1 })
  const value = await tools.get('outsource_run').execute({
    goal: 'never good enough',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.equal(value.tasks[0].verdict, 'block')
  assert.match(value.tasks[0].error, /验收未通过/)
  assert.equal(value.blocked, 1)
  assert.equal(value.delivered, 0)
})

await test('a verdict wrapped in prose still counts as pass', async () => {
  const agents = makeAgents({
    text: (prompt) => prompt.includes('你是验收方')
      ? '满足要求：格式说明如下 {"verdict":"pass","issues":[]} 通过'
      : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] } })
  const value = await tools.get('outsource_run').execute({
    goal: 'prose verdict',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].verdict, 'pass')
  assert.equal(value.tasks[0].rework ?? 0, 0, 'a wrapped verdict must not trigger rework')
})

await test('an unreadable verdict passes instead of failing the deliverable', async () => {
  const agents = makeAgents({
    text: (prompt) => prompt.includes('你是验收方') ? '……' : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] } })
  const value = await tools.get('outsource_run').execute({
    goal: 'unreadable verdict',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done')
  assert.equal(value.tasks[0].verdict, 'pass')
})

await test('acceptance is skipped, not failed, when no second route exists', async () => {
  const agents = makeAgents({ text: reviewScript(['block']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: [{ id: 'solo', kind: 'dsh' }], routing: { any: ['solo'] } })
  const value = await tools.get('outsource_run').execute({
    goal: 'single route',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done')
  assert.equal(value.tasks[0].verdict, 'pass', 'no reviewer means nothing to block on')
})

/* ───────────────────────────── automatic retry ───────────────────────────── */

/** Fails the first `failures` worker calls, then succeeds. Reviews always pass. */
function flakyAgents(failures, { text = 'ok' } = {}) {
  let workerCalls = 0
  const agents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const isReviewer = options?.agentOptions?.model === 'vision-1' && options?.agentOptions?.provider === 'p2'
      const agent = {
        session,
        get status() { return 'idle' },
        followup(message) {
          const prompt = message.content?.[0]?.text ?? ''
          setTimeout(() => {
            if (isReviewer) {
              emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"verdict":"pass","issues":[]}' }] } } })
              emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
              return
            }
            workerCalls += 1
            if (workerCalls <= failures) {
              emitSession(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: `upstream 503 on call ${workerCalls}` } } } })
              return
            }
            emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${text}${workerCalls}` }] } } })
            emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }, 0)
        },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, async dispose() {} }
    },
  }
  return agents
}

await test('a failed attempt is retried and can still deliver', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: flakyAgents(1) } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRetries: 2, retryDelayMs: 0 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'retry once',
    wait: true,
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done', 'the retry must rescue the task')
  assert.equal(value.tasks[0].attempts, 2, 'attempts must count the retry')
})

await test('retries stop at maxRetries and the task fails', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: flakyAgents(99) } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRetries: 2, retryDelayMs: 0 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'always fails',
    wait: true,
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.equal(value.tasks[0].attempts, 3, '1 initial + 2 retries')
})

await test('maxRetries 0 disables retrying', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: flakyAgents(1) } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRetries: 0 })
  const value = await tools.get('dispatch_run').execute({
    goal: 'no retry',
    wait: true,
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.equal(value.tasks[0].attempts, 1)
})

await test('a rejected deliverable is not retried as a flaky failure', async () => {
  const agents = makeAgents({ text: reviewScript(['block']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRework: 0, maxRetries: 3, retryDelayMs: 0 })
  const value = await tools.get('outsource_run').execute({
    goal: 'permanent rejection',
    tasks: [{ id: 'a', prompt: 'do the work', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.equal(value.tasks[0].attempts ?? 1, 1, 'acceptance exhaustion must not burn retries')
})

await test('a failing capability candidate fails over to the next one', async () => {
  // First candidate explodes, second works: the job must still be delivered.
  const agents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const model = options?.agentOptions?.model
      const agent = {
        session,
        get status() { return 'idle' },
        followup(message) {
          const prompt = message.content?.[0]?.text ?? ''
          setTimeout(() => {
            if (prompt.includes('你是验收方')) {
              emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"verdict":"pass","issues":[]}' }] } } })
              emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
              return
            }
            if (model === 'dead-model') {
              emitSession(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Authentication Fails' } } } })
              return
            }
            emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'delivered' }] } } })
            emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }, 0)
        },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, async dispose() {} }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {
    capabilities: { coding: ['p1/dead-model', 'p2/vision-1'] },
    maxRetries: 2,
    retryDelayMs: 0,
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'failover',
    wait: true,
    tasks: [{ id: 'c', prompt: 'write code', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done', `failover must rescue the task: ${value.tasks[0].error ?? ''}`)
  assert.equal(value.tasks[0].provider, 'p2')
  assert.equal(value.tasks[0].model, 'vision-1', 'the second candidate must serve the work')
  assert.equal(value.tasks[0].attempts, 2)
})

await test('a dead reviewer skips acceptance instead of failing the task', async () => {
  let calls = 0
  const agents = {
    list: () => [],
    async create(options) {
      calls += 1
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const isReviewer = options?.agentOptions?.provider === 'p2'
      const agent = {
        session,
        get status() { return 'idle' },
        followup() {
          setTimeout(() => {
            if (isReviewer) {
              emitSession(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'api key invalid' } } } })
              return
            }
            emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'good work' }] } } })
            emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }, 0)
        },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, async dispose() {} }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxRework: 2 })
  const value = await tools.get('outsource_run').execute({
    goal: 'dead reviewer',
    tasks: [{ id: 'a', prompt: 'do it', subject: 'A' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done', 'a dead reviewer must not fail the deliverable')
  assert.equal(value.tasks[0].verdict, 'pass')
  assert.ok(calls >= 2, 'worker and reviewer were both attempted')
})

await test('providerPreference.last pushes a provider to the back', async () => {
  const agents = makeAgents({ text: () => 'ok' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {
    capabilities: { coding: ['p1/text-1', 'p2/long-1'] },
    providerPreference: { last: ['p1'] },
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'official last',
    wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].provider, 'p2', 'the de-prioritised provider must not win')
  assert.equal(value.tasks[0].model, 'long-1')
})

await test('a recently failed route is demoted below a healthy one', async () => {
  const healthDir = join(cwd, '.agent-dispatch')
  await mkdir(healthDir, { recursive: true })
  await writeFile(join(healthDir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: { 'p1/text-1': { at: Date.now(), reason: 'api key invalid' } },
  }), 'utf8')
  const agents = makeAgents({ text: () => 'ok' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  const value = await tools.get('dispatch_run').execute({
    goal: 'health demotion',
    wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].model, 'long-1', 'the route that just failed must sink')
})

await test('the reviewer prefers a genuinely different model over another endpoint of the same one', async () => {
  const agents = makeAgents({ text: reviewScript(['pass']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {
    // same weights on three endpoints plus one genuinely different model
    workers: [
      { id: 'a', kind: 'dsh', provider: 'p1', model: 'glm-x' },
      { id: 'b', kind: 'dsh', provider: 'p2', model: 'glm-x' },
      { id: 'c', kind: 'dsh', provider: 'p9', model: 'other-model' },
    ],
    routing: { any: ['a'] },
    capabilities: { coding: ['p2/glm-x'] },
  })
  await tools.get('outsource_run').execute({
    goal: 'independent reviewer',
    tasks: [{ id: 't', prompt: 'work', subject: 'T', needs: ['coding'] }],
  }, exec)
  const routes = agents.spawned.map((entry) => entry.agentOptions?.model).filter(Boolean)
  assert.ok(routes.includes('glm-x'), `worker route missing: ${JSON.stringify(routes)}`)
  assert.ok(routes.includes('other-model'), `reviewer must be a different model, got: ${JSON.stringify(routes)}`)
})

await test('a vendor-namespaced twin of the same model is not a second opinion', async () => {
  // The real failure: `z-ai/glm-5.3` delivered, `GLM-5.3` was picked to review.
  // Strings differ; the weights do not.
  const agents = makeAgents({ text: reviewScript(['pass']) })
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {
    workers: [
      { id: 'twin', kind: 'dsh', provider: 'modlens-zcode', model: 'GLM-5.3' },
      { id: 'family', kind: 'dsh', provider: 'zcode', model: 'GLM-5.3-Flash' },
      { id: 'other', kind: 'dsh', provider: 'trae', model: 'Doubao-Seed-2.1-Pro' },
    ],
    routing: { any: ['twin'] },
    capabilities: { coding: ['modlens-our-free-model/z-ai/glm-5.3'] },
  })
  await tools.get('outsource_run').execute({
    goal: 'normalised reviewer',
    tasks: [{ id: 't', prompt: 'work', subject: 'T', needs: ['coding'] }],
  }, exec)
  const routes = agents.spawned.map((entry) => entry.agentOptions?.model).filter(Boolean)
  assert.ok(routes.includes('z-ai/glm-5.3'), `deliverable route missing: ${JSON.stringify(routes)}`)
  assert.ok(!routes.includes('GLM-5.3'), `reviewer must not be the same weights: ${JSON.stringify(routes)}`)
  assert.ok(routes.includes('Doubao-Seed-2.1-Pro'), `expected the different family as reviewer: ${JSON.stringify(routes)}`)
})

await test('dispatch_probe finds the dead route and records it', async () => {
  deadRoutes.clear()
  deadRoutes.add('p2/long-1')
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm: makeLlm() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_probe').execute({
    routes: ['p1/text-1', 'p2/long-1'],
    timeoutMs: 2000,
  }, exec)
  assert.equal(value.probed, 2)
  assert.equal(value.alive, 1)
  assert.equal(value.dead, 1)
  const dead = value.routes.find((route) => !route.ok)
  assert.equal(dead.model, 'long-1')
  assert.match(dead.error, /api key/)
  // the verdict must reach the health memory the router reads
  const health = JSON.parse(await readFile(join(cwd, '.agent-dispatch', 'route-health.json'), 'utf8'))
  assert.ok(health.routes['p2/long-1'], 'the dead route must be remembered')
  deadRoutes.clear()
})

await test('a probed route is avoided by the next routing decision', async () => {
  // the previous case wrote a verdict for p2/long-1 into the shared workspace
  await rm(join(cwd, '.agent-dispatch', 'route-health.json'), { force: true }).catch(() => {})
  deadRoutes.clear()
  deadRoutes.add('p1/text-1')
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  await tools.get('dispatch_probe').execute({ routes: ['p1/text-1'], timeoutMs: 2000 }, exec)
  const value = await tools.get('dispatch_run').execute({
    goal: 'after probe',
    wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].model, 'long-1', 'the probed-dead route must sink')
  deadRoutes.clear()
})

await test('an http worker drives a local OpenAI-compatible endpoint', async () => {
  let seenModel
  const server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try { seenModel = JSON.parse(body).model } catch { seenModel = undefined }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'LOCAL-OK' } }] }))
      })
      return
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [{ id: 'local', kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1/`, model: 'local-model', label: '本机' }],
      routing: { any: ['local'] },
    })
    const health = await tools.get('dispatch_workers').execute({}, exec)
    const local = health.workers.find((worker) => worker.id === 'local')
    assert.equal(local.kind, 'http')
    assert.equal(local.available, true, `local endpoint must be reachable: ${local.detail}`)

    const value = await tools.get('dispatch_run').execute({
      goal: 'local endpoint',
      wait: true,
      tasks: [{ id: 'l', prompt: 'say hi', subject: 'L' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'done', `http task failed: ${value.tasks[0].error ?? ''}`)
    assert.equal(value.tasks[0].worker, 'local')
    assert.match(value.tasks[0].output, /LOCAL-OK/)
    assert.equal(seenModel, 'local-model', 'the model id must reach the endpoint')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('an unreachable http endpoint is reported, not silently skipped', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{ id: 'dead', kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }],
    routing: { any: ['dead'] },
    maxRetries: 0,
  })
  const health = await tools.get('dispatch_workers').execute({}, exec)
  const dead = health.workers.find((worker) => worker.id === 'dead')
  assert.equal(dead.available, false)
  assert.match(dead.detail, /unreachable/)
  const value = await tools.get('dispatch_run').execute({
    goal: 'dead endpoint', wait: true, tasks: [{ id: 'd', prompt: 'x' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
})

await test('a permanent failure outlives the transient TTL', async () => {
  const healthDir = join(cwd, '.agent-dispatch')
  await mkdir(healthDir, { recursive: true })
  // stamped just outside the 10-minute transient window, but a dead key
  await writeFile(join(healthDir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: {
      'p1/text-1': { at: Date.now() - 20 * 60 * 1000, kind: 'permanent', reason: 'Authentication Fails, api key invalid' },
      'p2/long-1': { at: Date.now() - 20 * 60 * 1000, kind: 'transient', reason: 'concurrency limit exceeded' },
    },
    alive: {},
  }), 'utf8')
  const agents = makeAgents({ text: () => 'ok' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  const value = await tools.get('dispatch_run').execute({
    goal: 'kind-aware ttl',
    wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  // the permanently-dead route must stay demoted; the transient one is forgiven
  assert.equal(value.tasks[0].model, 'long-1', 'a dead key must not be forgiven after 10 minutes')
})

await test('research drops a pick the probe finds dead and backfills', async () => {
  await rm(join(cwd, '.agent-dispatch', 'route-health.json'), { force: true }).catch(() => {})
  await rm(join(cwd, '.agent-dispatch', 'capabilities.json'), { force: true }).catch(() => {})
  deadRoutes.clear()
  deadRoutes.add('p1/text-1')            // the scout's first pick is dead
  const agents = makeAgents({
    text: (prompt) => prompt.includes('用人能力表')
      ? '{"coding":["p1/text-1"]}'        // only the dead one
      : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_research').execute({
    scout: 'p2/vision-1',
    verify: true,
    probeTimeoutMs: 2000,
    needs: ['coding'],
    refresh: true,
  }, exec)
  const coding = value.capabilities.find((entry) => entry.need === 'coding')
  assert.ok(coding !== undefined, 'coding must still get a route')
  assert.ok(!coding.routes.includes('p1/text-1'), 'a probe-dead pick must not be saved')
  assert.ok(value.rejected.some((entry) => entry.includes('probe failed')), `rejected: ${JSON.stringify(value.rejected)}`)
  deadRoutes.clear()
})

await test('research with verify false trusts the scout', async () => {
  await rm(join(cwd, '.agent-dispatch', 'route-health.json'), { force: true }).catch(() => {})
  deadRoutes.clear()
  deadRoutes.add('p1/text-1')
  const agents = makeAgents({
    text: (prompt) => prompt.includes('用人能力表') ? '{"coding":["p1/text-1"]}' : 'work',
  })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {})
  const value = await tools.get('dispatch_research').execute({
    scout: 'p2/vision-1', verify: false, needs: ['coding'], refresh: true,
  }, exec)
  const coding = value.capabilities.find((entry) => entry.need === 'coding')
  assert.deepEqual(coding.routes, ['p1/text-1'], 'verify:false must keep the raw pick')
  deadRoutes.clear()
})


/**
 * Every tool declares `additionalProperties: false`, so one undeclared field in
 * a returned value makes the whole call fail at validation — while any side
 * effects have already landed. This guard compares real return values against
 * the declared schema so that mismatch cannot ship again.
 */
function assertConforms(schema, value, path) {
  if (schema === undefined || value === undefined || value === null) return
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} must be an array`)
    for (let index = 0; index < value.length; index += 1) assertConforms(schema.items, value[index], `${path}[${index}]`)
    return
  }
  if (schema.properties !== undefined || schema.type === 'object') {
    assert.equal(typeof value, 'object', `${path} must be an object`)
    assert.ok(!Array.isArray(value), `${path} must not be an array`)
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).filter((key) => !(key in properties))
      assert.deepEqual(extra, [], `${path} has undeclared properties: ${extra.join(', ')}`)
    }
    for (const [key, sub] of Object.entries(properties)) assertConforms(sub, value[key], `${path}.${key}`)
    return
  }
  if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} must be a number`)
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} must be a boolean`)
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} must be a string`)
}

await test('every tool return value matches its declared output schema', async () => {
  await rm(join(cwd, '.agent-dispatch', 'route-health.json'), { force: true }).catch(() => {})
  await rm(join(cwd, '.agent-dispatch', 'capabilities.json'), { force: true }).catch(() => {})
  deadRoutes.clear()
  const agents = makeAgents({ text: (prompt) => prompt.includes('你是验收方')
    ? '{"verdict":"pass","issues":[]}'
    : prompt.includes('用人能力表') ? '{"coding":["p2/long-1"]}' : 'work' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {
    workers: ROUTED_WORKERS,
    routing: { any: ['dsh'] },
    maxRetries: 0,
    retryDelayMs: 0,
  })

  const cases = [
    ['dispatch_workers', {}],
    ['dispatch_models', {}],
    ['dispatch_capabilities', {}],
    ['dispatch_probe', { routes: ['p1/text-1'], timeoutMs: 2000 }],
    ['dispatch_research', { scout: 'p2/vision-1', verify: true, probeTimeoutMs: 2000, needs: ['coding'], refresh: true }],
    ['dispatch_run', { goal: 'schema', wait: true, tasks: [{ id: 'a', prompt: 'x', subject: 'A' }] }],
    ['dispatch_status', {}],
    ['outsource_run', { goal: 'schema out', tasks: [{ id: 'o', prompt: 'x', subject: 'O' }] }],
  ]
  for (const [name, args] of cases) {
    const definition = tools.get(name)
    assert.ok(definition !== undefined, `${name} is not registered`)
    const value = await definition.execute(args, exec)
    assertConforms(definition.output.schema, value, name)
    // the renderer must also accept the very value execute produced
    const blocks = definition.output.render(args, value)
    assert.ok(Array.isArray(blocks), `${name} render did not return content blocks`)
  }
  const cancel = await tools.get('dispatch_cancel').execute({}, exec)
  assertConforms(tools.get('dispatch_cancel').output.schema, cancel, 'dispatch_cancel')
  const failed = await tools.get('dispatch_run').execute({ goal: 'g', wait: true, tasks: [{ id: 'z', prompt: 'x' }] }, exec)
  const detail = await tools.get('dispatch_result').execute({ task_id: 'z', run_id: failed.run_id }, exec)
  assertConforms(tools.get('dispatch_result').output.schema, detail, 'dispatch_result')
  deadRoutes.clear()
})

await test('dispatch_capabilities reports the route routing will actually use', async () => {
  const healthDir = join(cwd, '.agent-dispatch')
  await mkdir(healthDir, { recursive: true })
  await writeFile(join(healthDir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: { 'p1/text-1': { at: Date.now(), kind: 'permanent', reason: 'api key invalid' } },
    alive: {},
  }), 'utf8')
  await rm(join(healthDir, 'capabilities.json'), { force: true }).catch(() => {})
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  const value = await tools.get('dispatch_capabilities').execute({}, exec)
  const coding = value.declared.find((entry) => entry.need === 'coding')
  assert.equal(coding.provider, 'p1', 'the declared head is reported as declared')
  assert.equal(coding.effectiveProvider, 'p2', 'the effective route must skip the dead provider')
  assert.notEqual(coding.effectiveModel, 'text-1')
  assert.equal(coding.demoted, true)
  const rendered = tools.get('dispatch_capabilities').output.render({}, value)
  assert.match(rendered[0].text, /p2\//, 'the rendered table shows the effective route')
  assert.match(rendered[0].text, /the declared head is known dead/)
})

await test('a hung reviewer is skipped after its own timeout, not the task budget', async () => {
  let reviewerCalls = 0
  const agents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      const isReviewer = options?.agentOptions?.provider === 'p2'
      const agent = {
        session,
        get status() { return 'idle' },
        followup() {
          if (isReviewer) { reviewerCalls += 1; return } // never answers
          setTimeout(() => {
            emitSession(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'delivered' }] } } })
            emitSession(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }, 0)
        },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, async dispose() {} }
    },
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  const started = Date.now()
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, reviewTimeoutMs: 300, timeoutMs: 600_000 })
  const value = await tools.get('outsource_run').execute({
    goal: 'hung reviewer',
    tasks: [{ id: 'a', prompt: 'do it', subject: 'A' }],
  }, exec)
  const elapsed = Date.now() - started
  assert.equal(value.tasks[0].status, 'done', 'the deliverable must still be delivered')
  assert.equal(value.tasks[0].verdict, 'pass')
  assert.ok(elapsed < 20_000, `the reviewer budget must bound the wait, took ${elapsed}ms`)
  assert.ok(reviewerCalls >= 1)
})

await test('recording a failure keeps the verified-alive evidence', async () => {
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

await test('a stored run with a stale running task reads back as cancelled', async () => {
  const dir = join(cwd, '.agent-dispatch')
  await mkdir(dir, { recursive: true })
  // a record written before the cancel rule existed
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    runs: [{
      id: 'run-legacy', goal: 'legacy', cwd, status: 'cancelled', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tasks: [
        { id: 'a', subject: 'A', status: 'running', logPath: 'x' },
        { id: 'b', subject: 'B', status: 'done', logPath: 'y' },
      ],
    }],
  }), 'utf8')
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {})
  const status = await tools.get('dispatch_status').execute({ run_id: 'run-legacy' }, exec)
  const byId = Object.fromEntries(status.tasks.map((task) => [task.id, task.status]))
  assert.equal(byId.a, 'cancelled', 'a settled run must not report live work')
  assert.equal(byId.b, 'done')
})

await test('dispatch_workers resolves liveness from the session workspace', async () => {
  const dir = join(cwd, '.agent-dispatch')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: { 'p1/dead-1': { at: Date.now(), kind: 'permanent', reason: 'api key invalid' } },
    alive: { 'p2/live-1': { at: Date.now(), latencyMs: 1234 } },
  }), 'utf8')
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [
      { id: 'down', kind: 'dsh', provider: 'p1', model: 'dead-1' },
      { id: 'up', kind: 'dsh', provider: 'p2', model: 'live-1' },
    ],
  })
  const value = await tools.get('dispatch_workers').execute({}, exec)
  const byId = Object.fromEntries(value.workers.map((worker) => [worker.id, worker]))
  assert.equal(byId.down.status, 'dead', 'a dead pin must be reported dead')
  assert.equal(byId.up.status, 'alive')
  assert.equal(byId.up.latencyMs, 1234, 'the probed latency must reach the worker list')
  const text = tools.get('dispatch_workers').output.render({}, value)[0].text
  assert.match(text, /✗ down/)
  assert.match(text, /✓ up/)
})

await test('the bench lists contract models but not the declared staff', async () => {
  const dir = join(cwd, '.agent-dispatch')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    runs: [{
      id: 'run-bench', goal: 'bench', cwd, status: 'done',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tasks: [
        { id: 'a', subject: 'A', status: 'done', provider: 'p9', model: 'contract-1', endedAt: new Date().toISOString(), logPath: 'x' },
        { id: 'b', subject: 'B', status: 'done', provider: 'p1', model: 'text-1', endedAt: new Date().toISOString(), logPath: 'y' },
      ],
    }],
  }), 'utf8')
  const agents = makeAgents()
  // the board discovers the workspace from live sessions; model that here
  agents.list = () => [{ session: { header: { cwd } } }]
  const { ctx, routes } = makeCtx({ services: { agents } })
  plugin.apply(ctx, {
    workers: [{ id: 'staff', kind: 'dsh', provider: 'p1', model: 'text-1' }],
  })
  const captured = { body: '' }
  await routes.get('/api/agent-dispatch/state').handler(
    { url: '/api/agent-dispatch/state', headers: {} },
    { writeHead() { return this }, end(body) { captured.body = body ?? ''; return this } },
  )
  const payload = JSON.parse(captured.body)
  const ids = payload.contractors.map((entry) => entry.id)
  assert.ok(ids.includes('p9/contract-1'), `the contract model must be on the bench: ${JSON.stringify(ids)}`)
  assert.ok(!ids.includes('p1/text-1'), 'a declared worker route is staff, not a contractor')
  const bench = payload.contractors.find((entry) => entry.id === 'p9/contract-1')
  assert.equal(bench.tasks, 1)
  assert.equal(bench.working, false, 'an idle contractor stays on the bench, not working')
})

await test('routing prefers the fastest verified route among candidates', async () => {
  const dir = join(cwd, '.agent-dispatch')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: {},
    alive: {
      'p1/text-1': { at: Date.now(), latencyMs: 12000 },
      'p2/long-1': { at: Date.now(), latencyMs: 520 },
    },
  }), 'utf8')
  await rm(join(dir, 'capabilities.json'), { force: true }).catch(() => {})
  const agents = makeAgents({ text: () => 'ok' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  // declared order puts the slow one first
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  const value = await tools.get('dispatch_run').execute({
    goal: 'fastest wins', wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  assert.equal(value.tasks[0].provider, 'p2', 'the 0.5s route must beat the 12s one')
  assert.equal(value.tasks[0].model, 'long-1')
})

await test('a stale latency measurement is not replayed as current', async () => {
  const dir = join(cwd, '.agent-dispatch')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'route-health.json'), JSON.stringify({
    version: 1,
    routes: {},
    alive: {
      'p1/text-1': { at: Date.now() - 5 * 3600 * 1000, latencyMs: 200 },
      'p2/long-1': { at: Date.now(), latencyMs: 3000 },
    },
  }), 'utf8')
  await rm(join(dir, 'capabilities.json'), { force: true }).catch(() => {})
  const agents = makeAgents({ text: () => 'ok' })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { capabilities: { coding: ['p1/text-1', 'p2/long-1'] } })
  const value = await tools.get('dispatch_run').execute({
    goal: 'stale latency', wait: true,
    tasks: [{ id: 'c', prompt: 'x', type: 'implement', needs: ['coding'] }],
  }, exec)
  // the declared head measured 200ms five hours ago; the other one measured
  // 3s a moment ago. Fresh evidence must win, and the stale figure must not be
  // replayed as if it were current.
  assert.equal(value.tasks[0].provider, 'p2', 'a stale fast measurement must not outrank a fresh one')
})

await test('the leader splits a goal, dispatches the group, and consolidates', async () => {
  await rm(join(cwd, '.agent-dispatch', 'capabilities.json'), { force: true }).catch(() => {})
  await rm(join(cwd, '.agent-dispatch', 'route-health.json'), { force: true }).catch(() => {})
  deadRoutes.clear()
  const order = '{"tasks":['
    + '{"id":"t1","subject":"调研","type":"research","needs":["coding"],"dependsOn":[],"prompt":"调研一下","acceptCriteria":"有结论"},'
    + '{"id":"t2","subject":"实现","type":"implement","needs":["coding"],"dependsOn":["t1"],"prompt":"照着做","acceptCriteria":"能跑"}'
    + '],"note":"先调研再实现"}'
  const agents = makeAgents({
    text: (prompt) => {
      if (prompt.includes('把客户的目标拆成一份可执行的工单')) return order
      if (prompt.includes('向客户交付')) return 'FINAL-DELIVERY'
      if (prompt.includes('你是验收方')) return '{"verdict":"pass","issues":[]}'
      return 'work-output'
    },
  })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, {
    workers: ROUTED_WORKERS,
    routing: { any: ['dsh'] },
    capabilities: { coding: ['p2/vision-1'], reasoning: ['p1/text-1'] },
    leader: 'p1/text-1',
    maxRetries: 0,
  })
  const value = await tools.get('outsource_team').execute({ goal: '做个小工具' }, exec)
  assert.equal(value.leader, 'p1/text-1')
  assert.equal(value.plan.length, 2, 'the leader order must become the plan')
  assert.deepEqual(value.plan.map((task) => task.id), ['t1', 't2'])
  assert.deepEqual(value.plan[1].dependsOn, ['t1'], 'the dependency must survive')
  assert.equal(value.status, 'done')
  assert.equal(value.delivered, 2)
  assert.equal(value.note, '先调研再实现')
  assert.match(value.final, /FINAL-DELIVERY/, 'the leader must consolidate')
  const text = tools.get('outsource_team').output.render({}, value)[0].text
  assert.match(text, /领导 p1\/text-1 组队/)
  assert.match(text, /最终交付/)
})

await test('planOnly returns the work order without dispatching it', async () => {
  const order = '{"tasks":[{"id":"t1","subject":"X","type":"docs","needs":["fast"],"prompt":"写点东西","acceptCriteria":"有内容"}]}'
  const seen = []
  const agents = makeAgents({ text: (prompt) => (prompt.includes('把客户的目标拆成') ? order : 'ok') })
  const original = agents.create.bind(agents)
  agents.create = async (options) => { seen.push(options); return original(options) }
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, leader: 'p1/text-1' })
  const value = await tools.get('outsource_team').execute({ goal: '随便', planOnly: true }, exec)
  assert.equal(value.status, 'planned')
  assert.equal(value.run_id, undefined)
  assert.equal(value.plan.length, 1)
  assert.equal(seen.length, 1, 'only the leader call may happen; nothing is dispatched')
})

await test('an unreadable work order is refused, not silently run', async () => {
  const agents = makeAgents({ text: (prompt) => (prompt.includes('把客户的目标拆成') ? '我建议先做调研。' : 'ok') })
  const { ctx, tools } = makeCtx({ services: { agents, llm: makeLlm() } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, leader: 'p1/text-1' })
  await assert.rejects(
    () => tools.get('outsource_team').execute({ goal: 'x' }, exec),
    /no usable work order/,
  )
})

await test('dispatch_cloud lists models and tests quota against a real endpoint', async () => {
  const seen = []
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      seen.push(req.headers.authorization ?? 'none')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        if (parsed.model === 'model-b') {
          res.writeHead(429, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'quota exhausted' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  process.env.AGENT_DISPATCH_TEST_KEY = 'test-key'
  try {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [{
        id: 'cloud',
        kind: 'http',
        label: 'mock cloud',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: 'AGENT_DISPATCH_TEST_KEY',
        model: 'model-a',
      }],
    })
    const value = await tools.get('dispatch_cloud').execute({ sample: 2, timeoutMs: 5000 }, exec)
    const entry = value.workers[0]
    assert.equal(entry.reachable, true)
    assert.deepEqual(entry.models, ['model-a', 'model-b'], 'the /models list must be reported')
    assert.equal(entry.keyState, '已设置')
    assert.equal(seen[0], 'Bearer test-key', 'the key must be sent')
    const byModel = Object.fromEntries(entry.quota.map((probe) => [probe.model, probe]))
    assert.equal(byModel['model-a'].ok, true, 'a 200 means quota remains')
    assert.equal(byModel['model-b'].ok, false, 'a 429 must be reported as no quota')
    assert.match(byModel['model-b'].error, /429/)
    const text = tools.get('dispatch_cloud').output.render({}, value)[0].text
    assert.match(text, /有额度/)
  } finally {
    delete process.env.AGENT_DISPATCH_TEST_KEY
    await new Promise((done) => server.close(done))
  }
})

await test('dispatch_cloud refuses to guess when the key is missing', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{ id: 'cloud', kind: 'http', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'NOT_SET_ANYWHERE_123', model: 'm' }],
  })
  const value = await tools.get('dispatch_cloud').execute({}, exec)
  const entry = value.workers[0]
  assert.equal(entry.reachable, false)
  assert.match(entry.keyState, /未设置/)
  assert.match(entry.detail, /NOT_SET_ANYWHERE_123/)
})

/** A stand-in for the host credentials service. */
function makeCredentials() {
  const store = new Map()
  return {
    store,
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'store' }
    },
    async describe(ref) {
      return { configured: store.has(ref), ...(store.has(ref) ? { source: 'store' } : {}), writable: true }
    },
    async set(ref, value) { store.set(ref, value) },
    async unset(ref) { store.delete(ref) },
  }
}

/** Build a request the route can read: an async-iterable body plus method/url. */
function makeReq(path, method, body) {
  const base = { method, url: path, headers: {} }
  if (body === undefined) return base
  const generator = (async function* () { yield Buffer.from(JSON.stringify(body)) })()
  Object.assign(generator, base)
  return generator
}

function makeRes() {
  const captured = { status: 0, body: '' }
  return {
    captured,
    writeHead(status) { captured.status = status; return this },
    end(payload) { captured.body = payload ?? ''; return this },
  }
}

await test('the settings page can store and clear a cloud key', async () => {
  const credentials = makeCredentials()
  const { ctx, routes } = makeCtx({ services: { agents: makeAgents(), credentials } })
  plugin.apply(ctx, {
    workers: [{ id: 'aliyun', kind: 'http', label: '阿里云', baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen-plus' }],
  })
  const route = routes.get('/api/agent-dispatch/keys')
  assert.ok(route !== undefined, 'the keys route must be mounted')

  const before = makeRes()
  await route.handler(makeReq('/api/agent-dispatch/keys', 'GET'), before)
  const listed = JSON.parse(before.captured.body)
  assert.equal(listed.workers.length, 1)
  assert.equal(listed.workers[0].id, 'aliyun')
  assert.equal(listed.workers[0].configured, false)
  assert.equal(listed.workers[0].canEdit, true, 'a key must be editable when the service is present')
  assert.equal(listed.workers[0].envName, 'DASHSCOPE_API_KEY')

  const saved = makeRes()
  await route.handler(makeReq('/api/agent-dispatch/keys', 'POST', { workerId: 'aliyun', value: 'sk-test-123' }), saved)
  assert.equal(JSON.parse(saved.captured.body).ok, true)
  assert.equal(credentials.store.get('DASHSCOPE_API_KEY'), 'sk-test-123', 'the key must reach the credential store')

  const after = makeRes()
  await route.handler(makeReq('/api/agent-dispatch/keys', 'GET'), after)
  assert.equal(JSON.parse(after.captured.body).workers[0].configured, true)

  const cleared = makeRes()
  await route.handler(makeReq('/api/agent-dispatch/keys', 'POST', { workerId: 'aliyun', value: '' }), cleared)
  assert.equal(JSON.parse(cleared.captured.body).ok, true)
  assert.equal(credentials.store.has('DASHSCOPE_API_KEY'), false, 'an empty value clears the key')
})

await test('a key stored through the settings page is used by the http worker', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? 'none')
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[{"id":"m1"}]}')
      return
    }
    if (req.url === '/v1/chat/completions') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'FROM-CLOUD' } }] }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const credentials = makeCredentials()
    credentials.store.set('MY_CLOUD_KEY', 'stored-key-456')
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), credentials } })
    plugin.apply(ctx, {
      workers: [{ id: 'cloud', kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'MY_CLOUD_KEY', model: 'm1' }],
      routing: { any: ['cloud'] },
      maxRetries: 0,
    })
    const value = await tools.get('dispatch_run').execute({
      goal: 'stored key', wait: true,
      tasks: [{ id: 'c', prompt: 'hi', subject: 'C' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'done', `http task failed: ${value.tasks[0].error ?? ''}`)
    assert.match(value.tasks[0].output, /FROM-CLOUD/)
    assert.ok(seen.includes('Bearer stored-key-456'), `the stored key must be sent: ${JSON.stringify(seen)}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('the key test route reports /models without exposing the key', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[{"id":"alpha"},{"id":"beta"}]}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const credentials = makeCredentials()
    credentials.store.set('K', 'secret-value')
    const { ctx, routes } = makeCtx({ services: { agents: makeAgents(), credentials } })
    plugin.apply(ctx, {
      workers: [{ id: 'cloud', kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'K', model: 'alpha' }],
    })
    const res = makeRes()
    await routes.get('/api/agent-dispatch/keys/test').handler(
      makeReq('/api/agent-dispatch/keys/test', 'POST', { workerId: 'cloud' }),
      res,
    )
    const payload = JSON.parse(res.captured.body)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.models, ['alpha', 'beta'])
    assert.ok(!res.captured.body.includes('secret-value'), 'the key must never come back in the response')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('an external worker ignores an LLM route pin instead of failing on it', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'FROM-HTTP' } }] }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const credentials = makeCredentials()
    credentials.store.set('K2', 'k2-value')
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents(), credentials } })
    plugin.apply(ctx, {
      workers: [{ id: 'volc', kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'K2', model: 'ep-1' }],
      routing: { any: ['volc'] },
      maxRetries: 0,
    })
    // a provider pin that the adapter registry does not know must not be used
    const value = await tools.get('dispatch_run').execute({
      goal: 'external pin', wait: true,
      tasks: [{ id: 'a', prompt: 'hi', worker: 'volc', provider: 'ark', model: 'ep-1' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'done', `must not fail on the pin: ${value.tasks[0].error ?? ''}`)
    assert.match(value.tasks[0].output, /FROM-HTTP/)
    assert.ok(seen.some((url) => String(url).includes('/chat/completions')))
    // and no fake route may be left behind for an adapter that does not exist
    const health = JSON.parse(await readFile(join(cwd, '.agent-dispatch', 'route-health.json'), 'utf8').catch(() => '{}'))
    assert.equal(health.routes?.['ark/ep-1'], undefined, 'a meaningless pin must not poison health')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('"no adapter registered" failures are never recorded as dead routes', async () => {
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

await test('routing rotates across candidates instead of draining one provider', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [
      { id: 'a', kind: 'dsh', capabilities: ['implement'] },
      { id: 'b', kind: 'dsh', capabilities: ['implement'] },
      { id: 'c', kind: 'dsh', capabilities: ['implement'] },
    ],
    routing: { implement: ['a', 'b', 'c'], any: ['a'] },
    maxParallel: 1,
    maxRetries: 0,
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'spread the load', wait: true,
    tasks: [
      { id: 't1', prompt: 'x', type: 'implement' },
      { id: 't2', prompt: 'x', type: 'implement' },
      { id: 't3', prompt: 'x', type: 'implement' },
    ],
  }, exec)
  const used = value.tasks.map((task) => task.worker)
  assert.deepEqual(used, ['a', 'b', 'c'], `each candidate must be used once: ${JSON.stringify(used)}`)
  assert.equal(new Set(used).size, 3, 'the work must not drain a single worker')
})

await test('a local gateway is adopted as a worker automatically', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'local-model-x' }] }))
      return
    }
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'FROM-LOCAL' } }] }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    const applied = plugin.apply(ctx, { workers: [{ id: 'dsh', kind: 'dsh' }], routing: { any: ['local-test'] }, maxRetries: 0 })
    // point discovery at the stand-in endpoint and run it explicitly
    const engine = applied.engine
    assert.ok(engine !== undefined, 'the engine must be reachable for discovery')
    engine.config.discoverLocals = true
    engine.localWorkers = [{
      id: 'local-test',
      label: 'local test',
      kind: 'http',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'local-model-x',
      capabilities: ['implement'],
      local: true,
    }]
    const value = await tools.get('dispatch_run').execute({
      goal: 'local', wait: true,
      tasks: [{ id: 'a', prompt: 'hi', worker: 'local-test' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'done', `local worker failed: ${value.tasks[0].error ?? ''}`)
    assert.match(value.tasks[0].output, /FROM-LOCAL/, 'the local gateway must serve the task')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('a cli worker receives its declared environment', async () => {
  // a stand-in agent binary that echoes one env var, so the wiring is provable
  const dir = await mkdtemp(join(tmpdir(), 'agent-dispatch-cli-'))
  const script = join(dir, 'fake-agent.mjs')
  await writeFile(script, [
    'const prompt = process.argv.slice(2).join(" ")',
    'process.stdout.write(String(process.env.FAKE_RELAY_URL ?? "MISSING") + "|" + prompt)',
  ].join(String.fromCharCode(10)), 'utf8')
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{
      id: 'relay', kind: 'cli', command: process.execPath, args: [script, '{prompt}'],
      env: { FAKE_RELAY_URL: 'http://127.0.0.1:15721/v1' },
      capabilities: ['docs'],
    }],
    routing: { docs: ['relay'] },
    maxRetries: 0,
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'env', wait: true,
    tasks: [{ id: 'a', prompt: 'hello', type: 'docs' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'done', `cli task failed: ${value.tasks[0].error ?? ''}`)
  assert.match(value.tasks[0].output, /http:\/\/127\.0\.0\.1:15721\/v1\|hello/,
    'the declared env must reach the child process')
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

await test('an Error inside a task never breaks the tool result', async () => {
  const agents = {
    list: () => [],
    async create(options) {
      const session = { id: options?.sessionId ?? 'child', header: { cwd: options?.meta?.cwd } }
      return {
        agent: {
          session,
          get status() { return 'idle' },
          followup() {
            setTimeout(() => emitSession(session, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } }), 0)
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
  const value = await tools.get('outsource_run').execute({
    goal: 'error payload', wait: true,
    tasks: [{ id: 'a', prompt: 'x' }],
  }, exec)
  // the whole payload must survive a strict JSON round-trip
  const round = JSON.parse(JSON.stringify(value))
  assert.deepEqual(round, value, 'the tool result must be losslessly serialisable')
  assert.equal(typeof round.tasks[0].error, 'string')
})

await test('a missing cli launcher fails with a clear message, not a crash', async () => {
  const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(ctx, {
    workers: [{ id: 'nope', kind: 'cli', command: 'definitely-not-installed-xyz', args: ['{prompt}'] }],
    routing: { any: ['nope'] },
    maxRetries: 0,
  })
  const value = await tools.get('dispatch_run').execute({
    goal: 'missing cli', wait: true,
    tasks: [{ id: 'a', prompt: 'x' }],
  }, exec)
  assert.equal(value.tasks[0].status, 'failed')
  assert.match(String(value.tasks[0].error), /ENOENT|not found|exited/i)
  JSON.parse(JSON.stringify(value))
})

await test('a requested concurrency limit is honoured, not silently widened', async () => {
  let live = 0
  let peak = 0
  const agents = makeAgents({ delayMs: 30 })
  const original = agents.create.bind(agents)
  agents.create = async (options) => {
    live += 1
    peak = Math.max(peak, live)
    const handle = await original(options)
    const dispose = handle.dispose
    handle.dispose = async () => { live -= 1; return dispose() }
    return handle
  }
  const { ctx, tools } = makeCtx({ services: { agents } })
  plugin.apply(ctx, { workers: ROUTED_WORKERS, routing: { any: ['dsh'] }, maxParallel: 3, maxRetries: 0 })
  await tools.get('dispatch_run').execute({
    goal: 'cap', wait: true, maxParallel: 1,
    tasks: [
      { id: 'a', prompt: 'x' }, { id: 'b', prompt: 'x' }, { id: 'c', prompt: 'x' },
    ],
  }, exec)
  assert.equal(peak, 1, `maxParallel 1 must not run two at once; peak was ${peak}`)
})

await test('a retiring model is used first until its deadline, then released', async () => {
  const build = (until) => {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [
        { id: 'retiring', kind: 'dsh', capabilities: ['implement'], ...(until === undefined ? {} : { useFirstUntil: until }) },
        { id: 'keeper', kind: 'dsh', capabilities: ['implement'] },
      ],
      routing: { implement: ['retiring', 'keeper'], any: ['retiring'] },
      maxParallel: 1,
      maxRetries: 0,
    })
    return tools
  }
  // deadline in the future: the retiring worker takes the work first
  const future = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
  const value = await build(future).get('dispatch_run').execute({
    goal: 'retiring', wait: true,
    tasks: [{ id: 'a', prompt: 'x', type: 'implement' }, { id: 'b', prompt: 'x', type: 'implement' }],
  }, exec)
  // "use it up before it retires" means the boosted worker takes the work
  // rather than sharing it: both tasks go to it while the window is open.
  assert.deepEqual(value.tasks.map((task) => task.worker), ['retiring', 'retiring'],
    'the retiring worker must absorb the work while its window is open')

  // deadline in the past: no preference, ordinary rotation applies
  const past = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const after = await build(past).get('dispatch_run').execute({
    goal: 'expired', wait: true,
    tasks: [{ id: 'a', prompt: 'x', type: 'implement' }, { id: 'b', prompt: 'x', type: 'implement' }],
  }, exec)
  assert.deepEqual(after.tasks.map((task) => task.worker), ['retiring', 'keeper'],
    'an expired window must fall back to plain rotation, not an inverted order')
  const third = await build(past).get('dispatch_run').execute({
    goal: 'expired2', wait: true,
    tasks: [{ id: 'a', prompt: 'x', type: 'implement' }],
  }, exec)
  assert.equal(third.tasks[0].worker, 'retiring', 'rotation still starts at the head after expiry')

  // a garbage deadline must not boost forever
  const junk = await build('not-a-date').get('dispatch_run').execute({
    goal: 'junk', wait: true,
    tasks: [{ id: 'a', prompt: 'x', type: 'implement' }],
  }, exec)
  assert.equal(junk.tasks[0].worker, 'retiring', 'unparseable deadline degrades to rotation')
})

await test('a quota refusal is permanent: it is not retried', async () => {
  let calls = 0
  const server = createServer((req, res) => {
    calls += 1
    req.resume()
    req.on('end', () => {
      // the shape Tencent TokenHub returns when a service has no quota
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        error: { type: 'permission_error', code: '401007', message: 'No free trial quota is available for the service and postpaid billing is not enabled' },
      }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [{ id: 'img', kind: 'http', mode: 'image', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', capabilities: ['image'] }],
      routing: { image: ['img'] },
      maxRetries: 3,
      retryDelayMs: 0,
    })
    const value = await tools.get('dispatch_run').execute({
      goal: 'quota', wait: true,
      tasks: [{ id: 'a', prompt: 'x', type: 'image' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'failed')
    assert.equal(value.tasks[0].attempts, 1, 'a 402 must not be retried')
    assert.equal(calls, 1, 'the endpoint must be called exactly once')
    assert.match(String(value.tasks[0].error), /402|quota/i)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('an image worker saves the generated bytes and reports the path', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
  const server = createServer((req, res) => {
    if (req.url === '/v1/images/generations') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const own = await mkdtemp(join(tmpdir(), 'agent-dispatch-image-'))
    const ownExec = { agent: { session: { header: { cwd: own } } } }
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [{ id: 'img', kind: 'http', mode: 'image', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', capabilities: ['image'] }],
      routing: { image: ['img'] },
      maxRetries: 0,
    })
    const value = await tools.get('dispatch_run').execute({
      goal: 'draw', wait: true,
      tasks: [{ id: 'a', prompt: '一只柴犬', type: 'image' }],
    }, ownExec)
    assert.equal(value.tasks[0].status, 'done', `image task failed: ${value.tasks[0].error ?? ''}`)
    const saved = value.tasks[0].imagePath
    assert.equal(typeof saved, 'string', 'the saved image path must be reported')
    const bytes = await readFile(saved)
    assert.deepEqual(bytes, png, 'the saved file must be the returned bytes')
    await rm(own, { recursive: true, force: true }).catch(() => {})
  } finally {
    await new Promise((done) => server.close(done))
  }
})

await test('token usage from the endpoint reaches the task report', async () => {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }))
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  try {
    const { ctx, tools } = makeCtx({ services: { agents: makeAgents() } })
    plugin.apply(ctx, {
      workers: [{ id: 'h', kind: 'http', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', capabilities: ['docs'] }],
      routing: { docs: ['h'] },
      maxRetries: 0,
    })
    const value = await tools.get('dispatch_run').execute({
      goal: 'usage', wait: true,
      tasks: [{ id: 'a', prompt: 'x', type: 'docs' }],
    }, exec)
    assert.deepEqual(value.tasks[0].tokens, { prompt: 120, completion: 30, total: 150 },
      'the endpoint usage must be reported, not discarded')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

/* ───────────────────────────── report ───────────────────────────── */

// Windows can hold a directory briefly after the last writer closes; cleanup
// is best-effort and must not turn a green run red.
await rm(workdir, { recursive: true, force: true }).catch(() => {})

process.stdout.write(`${results.join('\n')}\n`)
process.stdout.write(failures === 0
  ? `\nAll ${results.length} checks passed.\n`
  : `\n${failures} of ${results.length} checks FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
