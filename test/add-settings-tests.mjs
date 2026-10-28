import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/test/engine.test.mjs'
let s = fs.readFileSync(p, 'utf8')

const anchor = "/* ───────────────────────────── report ───────────────────────────── */"
if (!s.includes(anchor)) throw new Error('anchor missing')

const extra = `/** A stand-in for the host credentials service. */
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
      workers: [{ id: 'cloud', kind: 'http', baseUrl: \`http://127.0.0.1:\${port}/v1\`, apiKeyEnv: 'MY_CLOUD_KEY', model: 'm1' }],
      routing: { any: ['cloud'] },
      maxRetries: 0,
    })
    const value = await tools.get('dispatch_run').execute({
      goal: 'stored key', wait: true,
      tasks: [{ id: 'c', prompt: 'hi', subject: 'C' }],
    }, exec)
    assert.equal(value.tasks[0].status, 'done', \`http task failed: \${value.tasks[0].error ?? ''}\`)
    assert.match(value.tasks[0].output, /FROM-CLOUD/)
    assert.ok(seen.includes('Bearer stored-key-456'), \`the stored key must be sent: \${JSON.stringify(seen)}\`)
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
      workers: [{ id: 'cloud', kind: 'http', baseUrl: \`http://127.0.0.1:\${port}/v1\`, apiKeyEnv: 'K', model: 'alpha' }],
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

` + anchor

s = s.replace(anchor, extra)
fs.writeFileSync(p, s)
console.log('settings-page tests added')
