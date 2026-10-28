import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

const anchor = "  }), 'agent-dispatch.route.log')"
if (!s.includes(anchor)) throw new Error('anchor missing')

const routes = anchor + `

  // ── key configuration surface for the plugin's settings page ──
  const httpWorkersFor = () => engine.workers(process.cwd()).filter((worker) => worker.kind === 'http')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/agent-dispatch/keys',
    handler: guard(async (req, res) => {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const workerId = typeof body.workerId === 'string' ? body.workerId : ''
        const value = typeof body.value === 'string' ? body.value : ''
        const worker = httpWorkersFor().find((entry) => entry.id === workerId)
        if (worker === undefined) return json(res, { ok: false, error: \`unknown worker "\${workerId}"\` }, 400)
        if (worker.apiKeyEnv === undefined) return json(res, { ok: false, error: 'this worker declares no apiKeyEnv' }, 400)
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return json(res, { ok: false, error: 'the credentials service is unavailable in this profile' }, 400)
        try {
          if (value === '') await credentials.unset(worker.apiKeyEnv)
          else await credentials.set(worker.apiKeyEnv, value)
        } catch (error) {
          return json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
        }
        const described = await describeWorkerKey(ctx, worker)
        return json(res, { ok: true, workerId, configured: described.configured, writable: described.writable })
      }
      const credentials = ctx.get('credentials')
      const workers = []
      for (const worker of httpWorkersFor()) {
        const described = await describeWorkerKey(ctx, worker)
        workers.push({
          id: worker.id,
          label: worker.label ?? worker.id,
          baseUrl: worker.baseUrl,
          model: worker.model,
          envName: described.envName,
          configured: described.configured,
          source: described.source,
          writable: described.writable,
          canEdit: credentials !== undefined && worker.apiKeyEnv !== undefined,
        })
      }
      json(res, { workers })
    }),
  }), 'agent-dispatch.route.keys')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/agent-dispatch/keys/test',
    handler: guard(async (req, res) => {
      if (req.method !== 'POST') return json(res, { ok: false, error: 'POST only' }, 405)
      const body = await readBody(req)
      const workerId = typeof body.workerId === 'string' ? body.workerId : ''
      const worker = httpWorkersFor().find((entry) => entry.id === workerId)
      if (worker === undefined) return json(res, { ok: false, error: \`unknown worker "\${workerId}"\` }, 400)
      const key = await resolveWorkerKey(ctx, worker)
      if (key === undefined) return json(res, { ok: false, error: 'no key configured' })
      const baseUrl = worker.baseUrl
      if (baseUrl === undefined) return json(res, { ok: false, error: 'no baseUrl' })
      const root = baseUrl.replace(/[/]+$/, '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(\`\${root}/models\`, {
          headers: { authorization: \`Bearer \${key}\` },
          signal: controller.signal,
        })
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          return json(res, { ok: false, status: response.status, error: \`HTTP \${response.status}\${text === '' ? '' : \`: \${text.slice(0, 200)}\`}\` })
        }
        let models = []
        try {
          const payload = JSON.parse(text)
          models = (Array.isArray(payload?.data) ? payload.data : []).map((model) => model?.id).filter((id) => typeof id === 'string')
        } catch {
          models = []
        }
        return json(res, { ok: true, status: response.status, models: models.slice(0, 40), count: models.length })
      } catch (error) {
        return json(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearTimeout(timer)
      }
    }),
  }), 'agent-dispatch.route.keys-test')`

s = s.replace(anchor, routes)

// a small body reader + a status parameter on the json helper
s = s.replace(
  "  const json = (res, value) => {\n    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })\n    res.end(JSON.stringify(value))\n  }",
  "  const json = (res, value, status = 200) => {\n    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })\n    res.end(JSON.stringify(value))\n  }\n\n  const readBody = async (req) => {\n    const chunks = []\n    let size = 0\n    for await (const chunk of req) {\n      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)\n      size += part.length\n      if (size > 64_000) throw new Error('request body too large')\n      chunks.push(part)\n    }\n    const raw = Buffer.concat(chunks).toString('utf8').trim()\n    if (raw === '') return {}\n    try {\n      const value = JSON.parse(raw)\n      return value !== null && typeof value === 'object' ? value : {}\n    } catch {\n      return {}\n    }\n  }")

fs.writeFileSync(p, s)
console.log('key routes added')
