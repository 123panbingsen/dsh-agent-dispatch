import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

// ── 1) discovery tables next to the other constants ──
const constAnchor = 'const DEFAULT_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000'
if (!s.includes(constAnchor)) throw new Error('const anchor missing')
s = s.replace(constAnchor, constAnchor + `
/**
 * Local endpoints and agent binaries worth adopting as workers. A desktop app
 * that only draws a window cannot be driven, but a local gateway and a CLI
 * agent can — and they usually carry their own credits, so they cost the user
 * nothing extra.
 */
const LOCAL_GATEWAYS = [
  { id: 'local-ccswitch', label: '本机网关（CC Switch）', baseUrl: 'http://127.0.0.1:15721/v1', hintModel: 'gpt-6-luna' },
  { id: 'local-ollama', label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', hintModel: undefined },
  { id: 'local-lmstudio', label: '本机 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', hintModel: undefined },
  { id: 'local-vllm', label: '本机 vLLM', baseUrl: 'http://127.0.0.1:8000/v1', hintModel: undefined },
]
const LOCAL_CLIS = [
  { id: 'local-codex', command: 'codex', label: '本机 Codex CLI', versionArgs: ['--version'] },
  { id: 'local-claude', command: 'claude', label: '本机 Claude CLI', versionArgs: ['--version'] },
  { id: 'local-gemini', command: 'gemini', label: '本机 Gemini CLI', versionArgs: ['--version'] },
  { id: 'local-cursor', command: 'cursor-agent', label: '本机 Cursor Agent', versionArgs: ['--version'] },
  { id: 'local-aider', command: 'aider', label: '本机 Aider', versionArgs: ['--version'] },
]`)

// ── 2) the discovery pass on the engine ──
const engineAnchor = '  workers(cwd) {'
if (!s.includes(engineAnchor)) throw new Error('engine anchor missing')
s = s.replace(engineAnchor, `  /**
   * Adopt whatever local agents this machine actually has. A closed desktop app
   * is not callable, so only two shapes count: an OpenAI-compatible endpoint on
   * loopback, and a CLI binary that answers --version.
   */
  async refreshLocalWorkers() {
    if (this.config.discoverLocals === false) {
      this.localWorkers = []
      return this.localWorkers
    }
    const found = []
    for (const gateway of LOCAL_GATEWAYS) {
      const root = gateway.baseUrl.replace(/[/]+$/, '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      try {
        const response = await fetch(\`\${root}/models\`, { signal: controller.signal })
        if (!response.ok) continue
        const payload = await response.json().catch(() => undefined)
        const listed = asArray(payload?.data).map((model) => model?.id).filter((id) => typeof id === 'string')
        const model = listed[0] ?? gateway.hintModel
        if (model === undefined) continue
        found.push({
          id: gateway.id,
          label: \`\${gateway.label} · \${model}\`,
          kind: 'http',
          baseUrl: root,
          model,
          capabilities: ['implement', 'fast', 'docs', 'test'],
          local: true,
        })
      } catch {
        /* nothing listening: not a worker */
      } finally {
        clearTimeout(timer)
      }
    }
    for (const cli of LOCAL_CLIS) {
      const path = await findExecutable(cli.command).catch(() => undefined)
      if (path === undefined) continue
      found.push({
        id: cli.id,
        label: cli.label,
        kind: 'cli',
        command: cli.command,
        args: ['exec'],
        capabilities: ['implement', 'review', 'test'],
        local: true,
      })
    }
    this.localWorkers = found
    return found
  }

` + engineAnchor)

fs.writeFileSync(p, s)
console.log('local discovery added')
