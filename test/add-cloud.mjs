import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

const anchor = "  }), 'agent-dispatch.probe')"
if (!s.includes(anchor)) throw new Error('anchor missing')

const tool = anchor + `

  ctx.effect(() => tools.register({
    name: 'dispatch_cloud',
    description: 'Interrogate the configured cloud (http) workers: list the models each key can actually reach via /models, then send one minimal chat request per model to find out whether that account still has quota. Results are written into the health memory so the board and the router see them. Use this instead of guessing model ids from documentation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        worker: { type: 'string', description: 'Only interrogate this http worker id.' },
        sample: { type: 'number', description: 'How many models per worker to quota-test (default 4, max 12).' },
        timeoutMs: { type: 'number', description: 'Per-request budget in milliseconds (default 15000).' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          workers: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, label: { type: 'string' }, baseUrl: { type: 'string' },
                keyEnv: { type: 'string' }, keyState: { type: 'string' },
                reachable: { type: 'boolean' }, detail: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
                quota: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      model: { type: 'string' }, ok: { type: 'boolean' },
                      latencyMs: { type: 'number' }, error: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = []
        for (const worker of value.workers) {
          lines.push(\`■ \${worker.label ?? worker.id}  \${worker.baseUrl ?? '(no baseUrl)'}\`)
          if (worker.keyEnv !== undefined) lines.push(\`   key \${worker.keyEnv}: \${worker.keyState}\`)
          if (worker.reachable === false) {
            lines.push(\`   不可用 — \${worker.detail ?? 'unknown'}\`)
            continue
          }
          lines.push(\`   可访问，\${worker.models.length} 个模型\`)
          if (worker.models.length > 0) lines.push(\`   模型：\${worker.models.slice(0, 12).join(', ')}\${worker.models.length > 12 ? ' …' : ''}\`)
          for (const probe of worker.quota) {
            lines.push(\`   \${probe.ok ? '✓' : '✗'} \${probe.model}\${probe.latencyMs === undefined ? '' : \` \${probe.latencyMs}ms\`}\${probe.ok ? ' 有额度' : \` — \${probe.error}\`}\`)
          }
        }
        return lines.length === 0 ? textBlock('没有配置任何 http 工人。') : textBlock(lines.join(String.fromCharCode(10)))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const requested = asString(args.worker)
      const sample = Number.isFinite(Number(args.sample)) && Number(args.sample) > 0 ? Math.min(Math.floor(Number(args.sample)), 12) : 4
      const budget = Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0
        ? Math.min(Number(args.timeoutMs), 60_000)
        : 15_000

      const httpWorkers = engine.workers(cwd).filter((worker) => worker.kind === 'http')
        .filter((worker) => requested === undefined || worker.id === requested)
      if (httpWorkers.length === 0) {
        throw new Error(requested === undefined
          ? 'no http worker is configured; add one under workers: in the plugin config'
          : \`no http worker named "\${requested}"\`)
      }

      const results = []
      const healthUpdates = []
      for (const worker of httpWorkers) {
        const baseUrl = worker.baseUrl
        const entry = {
          id: worker.id,
          label: worker.label ?? worker.id,
          baseUrl,
          keyEnv: worker.apiKeyEnv,
          keyState: '未要求',
          reachable: false,
          models: [],
          quota: [],
        }
        if (baseUrl === undefined) {
          entry.detail = 'no baseUrl declared'
          results.push(entry)
          continue
        }
        const headers = {}
        if (worker.apiKeyEnv !== undefined) {
          const key = process.env[worker.apiKeyEnv]
          if (typeof key !== 'string' || key === '') {
            entry.keyState = '未设置（请先设置这个环境变量，然后重启）'
            entry.detail = \`环境变量 \${worker.apiKeyEnv} 未设置\`
            results.push(entry)
            continue
          }
          entry.keyState = '已设置'
          headers.authorization = \`Bearer \${key}\`
        }

        const root = baseUrl.replace(/[/]+$/, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), budget)
        try {
          const response = await fetch(\`\${root}/models\`, { headers, signal: controller.signal })
          const body = await response.text().catch(() => '')
          if (!response.ok) {
            entry.detail = \`/models 返回 HTTP \${response.status}\${body === '' ? '' : \`: \${body.slice(0, 200)}\`}\`
            results.push(entry)
            await engine.applyProbeResults(cwd, [{ provider: worker.id, model: worker.model ?? '?', ok: false, error: entry.detail }])
            continue
          }
          entry.reachable = true
          let payload
          try { payload = JSON.parse(body) } catch { payload = undefined }
          const ids = asArray(payload?.data).map((model) => model?.id).filter((id) => typeof id === 'string')
          entry.models = ids
        } catch (error) {
          entry.detail = \`/models 请求失败: \${error instanceof Error ? error.message : String(error)}\`
          results.push(entry)
          continue
        } finally {
          clearTimeout(timer)
        }

        // Quota can only be answered by spending one token.
        const preferred = [worker.model, ...entry.models].filter((id) => typeof id === 'string')
        const picks = [...new Set(preferred)].slice(0, sample)
        for (const model of picks) {
          const started = Date.now()
          const inner = new AbortController()
          const innerTimer = setTimeout(() => inner.abort(), budget)
          try {
            const response = await fetch(\`\${root}/chat/completions\`, {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              signal: inner.signal,
              body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
                stream: false,
              }),
            })
            if (!response.ok) {
              const body = await response.text().catch(() => '')
              const reason = \`HTTP \${response.status}\${body === '' ? '' : \`: \${body.slice(0, 180)}\`}\`
              entry.quota.push({ model, ok: false, latencyMs: Date.now() - started, error: reason })
              healthUpdates.push({ provider: worker.id, model, ok: false, error: reason })
              continue
            }
            await response.json().catch(() => undefined)
            entry.quota.push({ model, ok: true, latencyMs: Date.now() - started })
            healthUpdates.push({ provider: worker.id, model, ok: true, latencyMs: Date.now() - started })
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            entry.quota.push({ model, ok: false, latencyMs: Date.now() - started, error: reason })
            healthUpdates.push({ provider: worker.id, model, ok: false, error: reason })
          } finally {
            clearTimeout(innerTimer)
          }
        }
        results.push(entry)
      }

      if (healthUpdates.length > 0) await engine.applyProbeResults(cwd, healthUpdates)
      return { workers: results }
    },
  }), 'agent-dispatch.cloud')`

s = s.replace(anchor, tool)
fs.writeFileSync(p, s)
console.log('dispatch_cloud registered')
