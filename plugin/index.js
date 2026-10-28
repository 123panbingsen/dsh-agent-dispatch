/**
 * dsh-agent-dispatch — Host half.
 *
 * Splits a goal into routed tasks and hands each one to a worker that exists on
 * this machine: an in-process DSH child agent, or an external headless CLI
 * driven through a command template.
 *
 * The only exports trusted by the Loader are `name`, `inject` and `apply`.
 * Everything else is local. No `@deepseek-ai/*` import is used: a bundle
 * installed into a profile cannot resolve those specifiers at Node level, so
 * every registry contract here is honoured structurally instead.
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const name = 'agent-dispatch'
export const inject = ['tools']

/* ────────────────────────────── constants ────────────────────────────── */

const STATE_VERSION = 1
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_PARALLEL = 3
const DEFAULT_MAX_REWORK = 1
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 800
const DEFAULT_REVIEW_TIMEOUT_MS = 90 * 1000
const DEFAULT_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000
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
  // args are the exact non-interactive invocation; {prompt} is substituted.
  { id: 'local-codex', command: 'codex', label: '本机 Codex CLI', args: ['exec', '--skip-git-repo-check', '{prompt}'] },
  { id: 'local-claude', command: 'claude', label: '本机 Claude CLI', args: ['-p', '{prompt}'] },
  { id: 'local-gemini', command: 'gemini', label: '本机 Gemini CLI', args: ['-p', '{prompt}'] },
  { id: 'local-cursor', command: 'cursor-agent', label: '本机 Cursor Agent', args: ['-p', '{prompt}'] },
  { id: 'local-aider', command: 'aider', label: '本机 Aider', args: ['--yes', '--message', '{prompt}'] },
  { id: 'local-opencode', command: 'opencode', label: '本机 opencode', args: ['run', '{prompt}'] },
  { id: 'local-crush', command: 'crush', label: '本机 Crush', args: ['run', '{prompt}'] },
]
const DEFAULT_ROUTE_HEALTH_TTL_MS = 10 * 60 * 1000
const DEFAULT_PERMANENT_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ROUTE_CANDIDATES = 8

/**
 * A failure a retry cannot fix. Retrying a rejected deliverable or a missing
 * worker only burns tokens, so those opt out of the retry loop.
 */
class PermanentError extends Error {}

function permanent(message) {
  return new PermanentError(message)
}
const MAX_KEPT_RUNS = 20
const MAX_OUTPUT_CHARS = 40_000
const LOG_TAIL_LINES = 200

/** Task type → ordered worker ids. `cli` entries are appended after `dsh`. */
const DEFAULT_ROUTING = {
  implement: ['dsh', 'cli'],
  review: ['dsh', 'cli'],
  research: ['dsh', 'cli'],
  test: ['dsh', 'cli'],
  docs: ['dsh', 'cli'],
  any: ['dsh', 'cli'],
}

/* ────────────────────────────── utilities ────────────────────────────── */

const nowIso = () => new Date().toISOString()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function clampText(value, limit = MAX_OUTPUT_CHARS) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]` : value
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asString(value, fallback = undefined) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Resolve a timer against a cooperative abort signal without leaking it. */
function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer
  const guard = new Promise((_done, fail) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        /* the abort itself failed; still surface the timeout */
      }
      fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * Serialize read-modify-write cycles per file path across every engine in the
 * process: a reload can leave an old engine's write in flight next to a new
 * one's, and two writers interleaving on the same file corrupt it.
 */
const fileLocks = new Map()

function withFileLock(path, operation) {
  const previous = fileLocks.get(path) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  fileLocks.set(path, next.catch(() => {}))
  return next
}

async function atomicWriteJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/* ────────────────────────────── worker runtime ────────────────────────────── */

/**
 * One dispatch run owns its worker slots, its log files and its cancellation
 * state. Runs are independent: cancelling one never touches another.
 */
class DispatchEngine {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config ?? {}
    this.runs = new Map()
    this.controllers = new Map()
    this.pendingWrites = new Map()
  }

  get stateDir() {
    return this.config.stateDir ?? '.agent-dispatch'
  }

  rootFor(cwd) {
    return resolve(cwd ?? process.cwd(), this.stateDir)
  }

  fileFor(cwd) {
    return join(this.rootFor(cwd), 'state.json')
  }

  logPath(cwd, runId, taskId) {
    return join(this.rootFor(cwd), 'logs', runId, `${taskId}.log`)
  }

  /** Where a researched capability table lives for one workspace. */
  capabilitiesFile(cwd) {
    return join(this.rootFor(cwd), 'capabilities.json')
  }

  /** Where recently-failed routes are remembered, so a dead supplier is not retried forever. */
  routeHealthFile(cwd) {
    return join(this.rootFor(cwd), 'route-health.json')
  }

  routeHealthTtlMs() {
    const value = Number(this.config.routeHealthTtlMs)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROUTE_HEALTH_TTL_MS
  }

  routeHealthPermanentTtlMs() {
    const value = Number(this.config.routeHealthPermanentTtlMs)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_PERMANENT_TTL_MS
  }

  /** One predicate over a health snapshot, honouring each entry's failure kind. */
  routeHealthJudge(health) {
    const now = Date.now()
    const transientTtl = this.routeHealthTtlMs()
    const permanentTtl = this.routeHealthPermanentTtlMs()
    const cooldown = this.providerCooldownMs()
    const entryFor = (route) => health?.[`${route.provider}/${route.model}`]
    return {
      entryFor,
      isDead(route) {
        const entry = entryFor(route)
        if (entry === undefined) return false
        return Number(entry.at) > now - healthTtlFor(entry, transientTtl, permanentTtl)
      },
      /** The whole shop is cooling down: prefer another provider for a while. */
      isProviderHot(provider) {
        const entry = health?.providers?.[provider]
        if (entry === undefined) return false
        return Number(entry.at) > now - cooldown
      },
    }
  }

  async loadRouteHealth(cwd) {
    try {
      const stored = await readJson(this.routeHealthFile(cwd))
      const routes = stored !== null && typeof stored?.routes === 'object' && stored.routes !== null ? stored.routes : {}
      return routes
    } catch {
      return {}
    }
  }

  /** Routes a probe recently proved to be answering. */
  async loadRouteAlive(cwd) {
    try {
      const stored = await readJson(this.routeHealthFile(cwd))
      return stored !== null && typeof stored?.alive === 'object' && stored.alive !== null ? stored.alive : {}
    } catch {
      return {}
    }
  }

  /** Remember one failed route so the next decision can avoid it. */
  async recordRouteFailure(cwd, provider, model, reason) {
    if (provider === undefined || model === undefined) return
    // "no adapter registered" means the pin was never a route at all. Recording
    // it would leave a permanent corpse that no probe can ever clear.
    if (/no adapter registered/i.test(String(reason ?? ''))) return
    const key = `${provider}/${model}`
    const file = this.routeHealthFile(cwd)
    try {
      await mkdir(this.rootFor(cwd), { recursive: true })
      await withFileLock(file, async () => {
        const stored = (await readJson(file)) ?? { version: STATE_VERSION, routes: {}, alive: {} }
        const routes = stored.routes !== null && typeof stored.routes === 'object' ? stored.routes : {}
        // Keep the verified-alive map: a failure record must not erase the
        // evidence that other routes answered.
        const alive = stored.alive !== null && typeof stored.alive === 'object' ? stored.alive : {}
        const providers = stored.providers !== null && typeof stored.providers === 'object' ? stored.providers : {}
        delete alive[key]
        const kind = classifyFailure(reason)
        routes[key] = { at: Date.now(), kind, reason: String(reason ?? '').slice(0, 300) }
        // Quota and account problems are per SHOP, not per model: when one route
        // of a provider is out of allowance, its siblings usually are too, and
        // hammering them just burns the shared quota.
        if (kind === 'permanent' || /quota|限流|concurrency|额度|allowance|rate.?limit/i.test(String(reason ?? ''))) {
          providers[provider] = { at: Date.now(), kind, reason: String(reason ?? '').slice(0, 300) }
        }
        await atomicWriteJson(file, { version: STATE_VERSION, routes, alive, providers })
      })
    } catch {
      /* health memory is an optimisation, never a failure */
    }
  }

  /**
   * Verify routes with a real, tiny request instead of trusting the catalog.
   * Catalog membership only means a provider advertises the model; it says
   * nothing about an expired key, a disabled account, or a dead endpoint.
   *
   * The probe goes straight through the llm service rather than spawning a
   * child agent: one token in, one token out, no session, no tools.
   */
  async probeRoute(llm, route, timeoutMs) {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let sawOutput = false
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? 'the provider returned an error')
          if (chunk.reason?.kind === 'aborted') throw new Error('aborted before finishing')
          sawOutput = true
          break
        }
        if (chunk?.type === 'text-delta') sawOutput = true
      }
      if (!sawOutput) throw new Error('no output at all')
      return { ok: true, latencyMs: Date.now() - started }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Rewrite health entries from a probe batch: alive clears, dead records. */
  async applyProbeResults(cwd, results) {
    const file = this.routeHealthFile(cwd)
    try {
      await mkdir(this.rootFor(cwd), { recursive: true })
      await withFileLock(file, async () => {
        const stored = (await readJson(file)) ?? { version: STATE_VERSION, routes: {}, alive: {} }
        const routes = stored.routes !== null && typeof stored.routes === 'object' ? stored.routes : {}
        const alive = stored.alive !== null && typeof stored.alive === 'object' ? stored.alive : {}
        for (const result of results) {
          const key = `${result.provider}/${result.model}`
          if (result.ok) {
            delete routes[key]
            alive[key] = { at: Date.now(), latencyMs: result.latencyMs }
          } else {
            delete alive[key]
            routes[key] = { at: Date.now(), kind: classifyFailure(result.error), reason: String(result.error ?? 'probe failed').slice(0, 300) }
          }
        }
        await atomicWriteJson(file, { version: STATE_VERSION, routes, alive })
      })
    } catch {
      /* a probe that cannot be recorded still answered the caller */
    }
  }

  /**
   * The capability table routing actually uses: what the owner declared, plus
   * what a scout researched. A declared class always wins over a researched one.
   */
  async loadCapabilities(cwd) {
    const declared = this.config.capabilities !== null && typeof this.config.capabilities === 'object'
      ? this.config.capabilities
      : {}
    let researched = {}
    try {
      const stored = await readJson(this.capabilitiesFile(cwd))
      if (stored?.capabilities !== null && typeof stored?.capabilities === 'object') researched = stored.capabilities
    } catch {
      /* an unreadable or absent table simply means nothing was researched yet */
    }
    const merged = {}
    for (const [need, list] of Object.entries(researched)) merged[need] = list
    for (const [need, list] of Object.entries(declared)) merged[need] = list
    return merged
  }

  timeoutMs() {
    const value = Number(this.config.timeoutMs)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
  }

  /** How many times a failed attempt is retried before the task fails. */
  maxRetries() {
    const value = Number(this.config.maxRetries)
    if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_RETRIES
    return Math.min(Math.floor(value), 5)
  }

  /** How long a whole provider is avoided after a quota or account failure. */
  providerCooldownMs() {
    const value = Number(this.config.providerCooldownMs)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 24 * 3600_000) : DEFAULT_PROVIDER_COOLDOWN_MS
  }

  /** How long an acceptance reviewer may take before the gate is skipped. */
  reviewTimeoutMs() {
    const value = Number(this.config.reviewTimeoutMs)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 600_000) : DEFAULT_REVIEW_TIMEOUT_MS
  }

  retryDelayMs() {
    const value = Number(this.config.retryDelayMs)
    return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : DEFAULT_RETRY_DELAY_MS
  }

  /** How many times a blocked deliverable may be sent back before failing. */
  maxRework() {
    const value = Number(this.config.maxRework)
    if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_REWORK
    return Math.min(Math.floor(value), 5)
  }

  maxParallel(requested) {
    const configured = Number(this.config.maxParallel)
    const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PARALLEL
    const asked = Number(requested)
    if (Number.isFinite(asked) && asked > 0) return Math.min(Math.floor(asked), 8)
    return Math.min(base, 8)
  }

  /** Where per-worker overrides edited from the settings page live. */
  workerOverrideFile(cwd) {
    return join(this.rootFor(cwd), 'workers.json')
  }

  async loadWorkerOverrides(cwd) {
    try {
      const stored = await readJson(this.workerOverrideFile(cwd))
      const overrides = stored !== null && typeof stored?.overrides === 'object' && stored.overrides !== null ? stored.overrides : {}
      this.cachedOverrides = overrides
      return overrides
    } catch {
      return {}
    }
  }

  /** Refresh the worker overrides so a freshly saved model id applies at once. */
  async refreshWorkerOverrides(cwd) {
    await this.loadWorkerOverrides(cwd)
    return this
  }

  async saveWorkerOverride(cwd, workerId, patch) {
    const file = this.workerOverrideFile(cwd)
    await mkdir(this.rootFor(cwd), { recursive: true })
    await withFileLock(file, async () => {
      const stored = (await readJson(file)) ?? { version: STATE_VERSION, overrides: {} }
      const overrides = stored.overrides !== null && typeof stored.overrides === 'object' ? stored.overrides : {}
      const current = overrides[workerId] !== null && typeof overrides[workerId] === 'object' ? overrides[workerId] : {}
      overrides[workerId] = { ...current, ...patch }
      await atomicWriteJson(file, { version: STATE_VERSION, overrides })
      this.cachedOverrides = overrides
    })
  }

  /** Worker declarations: config workers win, built-ins fill the gaps. */
  /**
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
        const response = await fetch(`${root}/models`, { signal: controller.signal })
        if (!response.ok) continue
        const payload = await response.json().catch(() => undefined)
        const listed = asArray(payload?.data).map((model) => model?.id).filter((id) => typeof id === 'string')
        const model = listed[0] ?? gateway.hintModel
        if (model === undefined) continue
        found.push({
          id: gateway.id,
          label: `${gateway.label} · ${model}`,
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
        args: asArray(cli.args).length > 0 ? cli.args : ['{prompt}'],
        capabilities: ['implement', 'review', 'test'],
        local: true,
      })
    }
    this.localWorkers = found
    return found
  }

  workers(cwd) {
    const declared = asArray(this.config.workers)
    const base = declared.length > 0 ? declared : [{ id: 'dsh', kind: 'dsh' }]
    // Locals adopted by discovery ride along, unless the config already
    // declares that id (an explicit declaration always wins).
    const seenIds = new Set(base.map((worker) => asString(worker?.id)))
    const locals = asArray(this.localWorkers).filter((worker) => !seenIds.has(worker.id))
    const list = locals.length === 0 ? base : [...base, ...locals]
    return list
      .filter((worker) => worker && typeof worker === 'object')
      .map((worker, index) => {
        const kind = worker.kind === 'cli' ? 'cli' : worker.kind === 'http' ? 'http' : 'dsh'
        const workerId = asString(worker.id, kind === 'cli' ? `cli-${index}` : kind === 'http' ? `http-${index}` : 'dsh')
        // A model id edited from the settings page wins, so switching to a new
        // endpoint id does not require touching cordis.patch.yml.
        const override = this.cachedOverrides?.[workerId]
        return {
          id: workerId,
          label: asString(worker.label),
          kind,
          command: asString(worker.command),
          args: asArray(worker.args),
          provider: asString(worker.provider),
          model: asString(override?.model) ?? asString(worker.model),
          capabilities: asArray(worker.capabilities).filter((c) => typeof c === 'string'),
          // A model scheduled for retirement should be spent before it goes,
          // without anyone remembering to undo the preference afterwards.
          useFirstUntil: asString(worker.useFirstUntil),
          mode: worker.mode === 'image' ? 'image' : 'chat',
          size: asString(worker.size),
          responseFormat: asString(worker.responseFormat),
          cwd: asString(worker.cwd) ?? cwd,
          baseUrl: asString(worker.baseUrl),
          apiKeyEnv: asString(worker.apiKeyEnv),
          env: worker.env !== null && typeof worker.env === 'object'
            ? Object.fromEntries(Object.entries(worker.env).filter(([, value]) => typeof value === 'string'))
            : undefined,
          maxTokens: Number.isFinite(Number(worker.maxTokens)) ? Number(worker.maxTokens) : undefined,
        }
      })
  }

  /** Pick the first routed worker that is usable for this task. */
  routeWorker(taskType, requestedWorker, cwd) {
    const available = this.workers(cwd)
    if (requestedWorker) {
      const explicit = available.find((worker) => worker.id === requestedWorker)
      return explicit ? { worker: explicit, reason: 'requested' } : { worker: undefined, reason: `unknown worker "${requestedWorker}"` }
    }
    const routing = { ...DEFAULT_ROUTING, ...(this.config.routing && typeof this.config.routing === 'object' ? this.config.routing : {}) }
    const order = asArray(routing[taskType] ?? routing.any).filter((id) => typeof id === 'string')
    const candidates = order
      .map((id, index) => ({ worker: available.find((entry) => entry.id === id), index }))
      .filter((entry) => entry.worker !== undefined)
    if (candidates.length === 0) return { worker: available[0], reason: 'first available worker' }
    // Spread the work: taking the first candidate every time drains one
    // provider's quota while its siblings sit idle. Rotate to the least
    // recently used, so a shared allowance is spent across the whole bench.
    const use = this.workerUse ?? (this.workerUse = new Map())
    const now = Date.now()
    const boost = (worker) => {
      const until = worker.useFirstUntil
      if (typeof until !== 'string' || until === '') return 0
      const deadline = Date.parse(until)
      // An unparseable deadline must not silently boost forever.
      return Number.isFinite(deadline) && now < deadline ? 1 : 0
    }
    const pick = candidates
      .map((entry) => ({ ...entry, last: use.get(entry.worker.id) ?? 0, boost: boost(entry.worker) }))
      .sort((a, b) => (b.boost - a.boost) || (a.last - b.last) || (a.index - b.index))[0]
    use.set(pick.worker.id, Date.now())
    return { worker: pick.worker, reason: `routed by type "${taskType}" (least recently used of ${candidates.length})` }
  }

  /* ── run lifecycle ── */

  async createRun({ goal, tasks, cwd, maxParallel }) {
    const runId = `run-${randomUUID().slice(0, 8)}`
    const catalog = await resolveCatalog(this.ctx).catch(() => ({ available: false, providers: [], routes: [] }))
    const capabilities = await this.loadCapabilities(cwd)
    const health = await this.loadRouteHealth(cwd)
    const alive = await this.loadRouteAlive(cwd)
    const run = {
      id: runId,
      goal: asString(goal, '(no goal given)'),
      cwd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'running',
      // The caller's concurrency wish must travel with the run; dropping it here
      // silently fell back to the configured limit.
      ...(Number.isFinite(Number(maxParallel)) && Number(maxParallel) > 0
        ? { maxParallel: Math.min(Math.floor(Number(maxParallel)), 8) }
        : {}),
      catalogAvailable: catalog.available,
      tasks: tasks.map((task, index) => {
        const routed = this.routeWorker(task.type ?? 'any', task.worker, cwd)
        const taskId = asString(task.id) ?? `t${index + 1}`
        // A declared need outranks the worker's own route: the point of the
        // catalog is that the best-suited model gets the work.
        const capabilityRoute = routeForNeeds(catalog, task.needs, capabilities)
        const explicitRoute = asString(task.model) !== undefined
          ? { provider: asString(task.provider), model: asString(task.model) }
          : undefined
        const workerRoute = routed.worker?.provider !== undefined || routed.worker?.model !== undefined
          ? { provider: routed.worker.provider, model: routed.worker.model }
          : undefined
        // An external worker (cli/http) is addressed by `worker`, not by an LLM
        // route: its baseUrl and key decide where the request goes, and a
        // provider pin would be handed to the dsh adapter registry, which has no
        // such provider. So for those workers the LLM route is not consulted.
        const external = routed.worker !== undefined && routed.worker.kind !== 'dsh'
        // Precedence: an explicit per-task route wins, then a declared need,
        // then the worker's own route, then the Host default.
        const chosen = external ? workerRoute : (explicitRoute ?? capabilityRoute ?? workerRoute)
        // Every task gets a fallback chain, including one pinned to a staff
        // worker: "cannot work, switch to another" must hold for staff too.
        // An external worker (cli/http) is a DIFFERENT BACKEND, not another
        // route on the same llm service, so it must never fail over into the
        // dsh route pool — that would silently change how the work is executed.
        const primary = !external && chosen?.provider !== undefined && chosen?.model !== undefined
          ? [{ provider: chosen.provider, model: chosen.model }]
          : []
        const judgeForRun = this.routeHealthJudge(health)
        const ordered = external ? [] : orderCandidates(
          [...primary, ...(capabilityRoute?.candidates ?? [])],
          catalog,
          this.config.providerPreference,
          judgeForRun,
          alive,
        )
        // A pinned worker keeps the job while it is healthy: latency only
        // decides among the fallbacks, not over an explicit choice. Handing the
        // work to someone else is the reaction to "cannot work", not to
        // "someone else measured faster once".
        // Only an EXPLICIT choice is defended: a task's own provider/model, or
        // the worker's declared pin. The capability table's head is a shortlist,
        // so speed still decides inside it.
        const pinned = chosen === explicitRoute || chosen === workerRoute
        const head = pinned ? primary[0] : undefined
        let routeCandidates = ordered.length === 0 ? undefined : ordered
        if (head !== undefined && ordered.length > 0 && !judgeForRun.isDead(head) && judgeForRun.isProviderHot(head.provider) === false) {
          const at = ordered.findIndex((route) => route.provider === head.provider && route.model === head.model)
          routeCandidates = at > 0 ? [ordered[at], ...ordered.slice(0, at), ...ordered.slice(at + 1)] : ordered
        }
        return {
          id: taskId,
          subject: asString(task.subject, asString(task.id) ?? `task ${index + 1}`),
          prompt: asString(task.prompt, ''),
          type: asString(task.type, 'any'),
          needs: asArray(task.needs).filter((need) => typeof need === 'string'),
          dependsOn: asArray(task.dependsOn).filter((dep) => typeof dep === 'string'),
          worker: routed.worker?.id,
          workerKind: routed.worker?.kind,
          routeReason: capabilityRoute !== undefined
            ? `needs: ${(task.needs ?? []).join(',')}`
            : routed.reason,
          provider: chosen?.provider,
          model: chosen?.model,
          ...(routeCandidates === undefined ? {} : { routeCandidates }),
          routeIndex: 0,
          accept: task.accept === false ? false : (task.accept === true || this.config.accept === true),
          acceptCriteria: asString(task.acceptCriteria),
          rework: 0,
          verdict: undefined,
          reviewBy: undefined,
          review: undefined,
          status: 'pending',
          attempts: 0,
          startedAt: undefined,
          endedAt: undefined,
          durationMs: undefined,
          output: undefined,
          error: undefined,
          logPath: this.logPath(cwd, runId, taskId),
        }
      }),
    }
    // Reject cycles and unknown dependencies before any work starts.
    const ids = new Set(run.tasks.map((task) => task.id))
    for (const task of run.tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) throw new Error(`task "${task.id}" depends on unknown task "${dep}"`)
        if (dep === task.id) throw new Error(`task "${task.id}" depends on itself`)
      }
    }
    this.assertAcyclic(run.tasks)
    this.runs.set(runId, run)
    await this.persist(run)
    return run
  }

  assertAcyclic(tasks) {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const state = new Map()
    const visit = (id, trail) => {
      const mark = state.get(id)
      if (mark === 'done') return
      if (mark === 'open') throw new Error(`dependency cycle: ${[...trail, id].join(' → ')}`)
      state.set(id, 'open')
      for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id])
      state.set(id, 'done')
    }
    for (const task of tasks) visit(task.id, [])
  }

  async persist(run) {
    const key = run.cwd
    // Serialize writes per workspace so two runs cannot interleave.
    const previous = this.pendingWrites.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      const file = this.fileFor(run.cwd)
      await withFileLock(file, async () => {
        const stored = (await readJson(file)) ?? { version: STATE_VERSION, runs: [] }
        const runs = asArray(stored.runs).filter((entry) => entry?.id !== run.id)
        runs.push(this.snapshotRun(run))
        const kept = runs.slice(-MAX_KEPT_RUNS)
        await mkdir(this.rootFor(run.cwd), { recursive: true })
        await atomicWriteJson(file, { version: STATE_VERSION, updatedAt: nowIso(), runs: kept })
      })
    }).catch((error) => {
      this.ctx.logger?.warn?.(`agent-dispatch: state write failed: ${String(error)}`)
    })
    this.pendingWrites.set(key, next)
    await next
  }

  /**
   * A settled run must never be shown with live work in it: older records kept
   * a task "running" after the run was cancelled. Applied on both write and
   * read, because a record written before this rule still exists on disk.
   */
  normalizeRun(run) {
    if (run === null || typeof run !== 'object') return run
    const terminal = run.status !== 'running'
    return {
      ...run,
      tasks: asArray(run.tasks).map((task) => ({
        ...task,
        ...(terminal && task.status === 'running'
          ? { status: 'cancelled', error: task.error ?? 'cancelled while running' }
          : {}),
        output: task.output === undefined ? undefined : clampText(task.output, 8000),
      })),
    }
  }

  snapshotRun(run) {
    return this.normalizeRun(run)
  }

  async appendLog(run, task, line) {
    try {
      await mkdir(join(this.rootFor(run.cwd), 'logs', run.id), { recursive: true })
      const { appendFile } = await import('node:fs/promises')
      await appendFile(task.logPath, `${nowIso()} ${line}\n`, 'utf8')
    } catch {
      /* logging must never fail the work */
    }
  }

  /* ── execution ── */

  async startRun(run, { onUpdate } = {}) {
    const controller = new AbortController()
    this.controllers.set(run.id, controller)
    run.promise = this.executeRun(run, controller.signal, onUpdate).catch((error) => {
      this.ctx.logger?.warn?.(`agent-dispatch: run ${run.id} failed: ${String(error)}`)
      run.status = 'failed'
      run.updatedAt = nowIso()
    }).finally(() => {
      this.controllers.delete(run.id)
      run.updatedAt = nowIso()
      if (run.status === 'running') run.status = run.tasks.every((task) => task.status === 'done') ? 'done' : 'failed'
      void this.persist(run).then(() => onUpdate?.(run))
    })
    return run
  }

  async executeRun(run, signal, onUpdate) {
    const limit = this.maxParallel(run.maxParallel)
    let active = 0
    const done = new Set()

    const ready = () => run.tasks.filter((task) => {
      if (task.status !== 'pending') return false
      return task.dependsOn.every((dep) => done.has(dep))
    })

    // A dependency that failed or was cancelled must not leave later work armed.
    const blockedBy = (task) => run.tasks.some((other) => task.dependsOn.includes(other.id) && ['failed', 'cancelled', 'skipped'].includes(other.status))

    while (true) {
      if (signal.aborted) {
        run.aborted = true
        for (const task of run.tasks) {
          if (task.status === 'pending' || task.status === 'running') {
            task.status = 'cancelled'
            task.endedAt = task.endedAt ?? nowIso()
            task.error = task.error ?? 'cancelled while running'
          }
        }
        run.status = 'cancelled'
        break
      }
      let launched = false
      for (const task of ready()) {
        if (active >= limit) break
        if (blockedBy(task)) {
          task.status = 'skipped'
          task.error = 'a dependency did not succeed'
          task.endedAt = nowIso()
          onUpdate?.(run)
          continue
        }
        active += 1
        launched = true
        void this.runTask(run, task, signal, onUpdate).finally(() => {
          active -= 1
          done.add(task.id)
          onUpdate?.(run)
        })
      }
      const pending = run.tasks.filter((task) => task.status === 'pending')
      if (pending.length === 0 && active === 0) break
      if (!launched && active === 0 && pending.length > 0) {
        // Nothing ready and nothing running: the remainder is unreachable.
        for (const task of pending) {
          task.status = 'skipped'
          task.error = 'unreachable dependency graph'
          task.endedAt = nowIso()
        }
        break
      }
      await sleep(150)
    }

    // A cancelled run can still have an in-flight task whose promise settles
    // later; the report must not show a live task inside a settled run.
    for (const task of run.tasks) {
      if (task.status !== 'running') continue
      task.status = 'cancelled'
      task.error = task.error ?? 'cancelled while running'
      task.endedAt = task.endedAt ?? nowIso()
    }
    if (run.status === 'running') {
      run.status = run.tasks.some((task) => task.status === 'failed') ? 'failed'
        : run.tasks.every((task) => task.status === 'done') ? 'done'
          : 'cancelled'
    }
    run.updatedAt = nowIso()
    await this.persist(run)
    onUpdate?.(run)
    return run
  }

  async runTask(run, task, signal, onUpdate) {
    const worker = this.workers(run.cwd).find((entry) => entry.id === task.worker)
    task.status = 'running'
    task.startedAt = nowIso()
    run.updatedAt = nowIso()
    onUpdate?.(run)
    await this.appendLog(run, task, `start worker=${task.worker} kind=${worker?.kind ?? 'unknown'} type=${task.type}`)

    const started = Date.now()
    // Retrying the SAME route and failing over to a DIFFERENT supplier are two
    // different budgets: a job with five named candidates should get to try
    // more than a job with none. Capped so a long list cannot burn the quota.
    const named = asArray(task.routeCandidates).length
    // Failover gets a wider budget than same-route retrying, but an explicit
    // `maxRetries: 0` must mean "no further attempts at all" — otherwise the
    // owner cannot switch retrying off.
    const configured = Number(this.config.maxRetries)
    const explicitZero = Number.isFinite(configured) && configured === 0
    const maxRetries = explicitZero ? 0 : Math.max(this.maxRetries(), Math.min(named, 4) - 1)

    const produce = async () => {
      if (worker === undefined) throw permanent(`worker "${task.worker}" is not declared`)
      if (worker.kind === 'cli') return await this.runCliTask(run, task, worker, signal)
      if (worker.kind === 'http') return await this.runHttpTask(run, task, worker, signal)
      return await this.runDshTask(run, task, worker, signal)
    }

    /** One full attempt: produce, then run the acceptance gate over it. */
    const attemptOnce = async () => {
      let result = await produce()
      task.output = clampText(result.output)
      // An image deliverable is a file on disk; the path must survive into the
      // report so the caller can actually open it.
      if (typeof result.imagePath === 'string') task.imagePath = result.imagePath
      if (result.tokens !== undefined && typeof result.tokens === 'object') {
        task.tokens = {
          prompt: result.tokens.prompt,
          completion: result.tokens.completion,
          total: result.tokens.total,
        }
      }
      if (task.accept !== true) return result

      const basePrompt = task.prompt
      for (;;) {
        const verdict = await this.reviewOutput(run, task, signal)
        task.verdict = verdict.pass ? 'pass' : 'block'
        task.reviewBy = verdict.provider === undefined ? undefined : `${verdict.provider}/${verdict.model}`
        task.review = verdict.reason === '' ? undefined : clampText(verdict.reason, 6000)
        await this.appendLog(run, task, `accept ${task.verdict}${task.reviewBy === undefined ? ' (no second model available)' : ` by ${task.reviewBy}`}${verdict.pass ? '' : `: ${verdict.reason.slice(0, 200)}`}`)
        run.updatedAt = nowIso()
        onUpdate?.(run)
        if (verdict.pass) return result
        if ((task.rework ?? 0) >= this.maxRework()) {
          throw permanent(`验收未通过（已返工 ${task.rework ?? 0} 次）：${verdict.reason}`)
        }
        task.rework = (task.rework ?? 0) + 1
        await this.appendLog(run, task, `rework #${task.rework}`)
        task.prompt = [
          basePrompt,
          '',
          '上一次产出未通过验收，必须修正以下问题后重新给出完整结果：',
          verdict.reason,
        ].join('\n')
        try {
          result = await produce()
        } finally {
          task.prompt = basePrompt
        }
        task.output = clampText(result.output)
      }
    }

    try {
      for (let attempt = 0; ; attempt += 1) {
        task.attempts = attempt + 1
        if (attempt > 0) await this.backoff(attempt, signal)
        try {
          const result = await attemptOnce()
          task.error = undefined
          task.status = run.aborted === true ? 'cancelled' : 'done'
          if (run.aborted === true) break
          await this.appendLog(run, task, `done in ${Date.now() - started}ms, ${result.output.length} chars${attempt > 0 ? `, ${attempt} retr${attempt === 1 ? 'y' : 'ies'}` : ''}`)
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          task.error = message
          if (task.attemptLog === undefined) task.attemptLog = []
          task.attemptLog.push({
            attempt: attempt + 1,
            provider: task.provider,
            model: task.model,
            error: message.slice(0, 300),
          })
          // A user's stop is final: retrying it would ignore the instruction.
          if (signal.aborted) {
            task.status = 'cancelled'
            await this.appendLog(run, task, `cancelled: ${message}`)
            break
          }
          if (error instanceof PermanentError || attempt >= maxRetries) {
            task.status = 'failed'
            // The last route failed too: remember it, or the next job walks
            // straight back into it.
            await this.recordRouteFailure(run.cwd, task.provider, task.model, message)
            await this.appendLog(run, task, `failed after ${attempt + 1} attempt(s): ${message}`)
            break
          }
          task.status = 'running'
          run.updatedAt = nowIso()
          await this.recordRouteFailure(run.cwd, task.provider, task.model, message)
          await this.appendLog(run, task, `attempt ${attempt + 1} failed, retrying: ${message}`)
          // Failover: the capability table's next candidate may still work.
          const pool = asArray(task.routeCandidates)
          const nextIndex = (task.routeIndex ?? 0) + 1
          if (pool.length > nextIndex) {
            task.routeIndex = nextIndex
            await this.appendLog(run, task, `failover → ${pool[nextIndex].provider}/${pool[nextIndex].model}`)
          }
          onUpdate?.(run)
        }
      }
    } finally {
      task.endedAt = nowIso()
      task.durationMs = Date.now() - started
      run.updatedAt = nowIso()
      onUpdate?.(run)
    }
  }

  /** Wait between retries, but wake immediately if the run is cancelled. */
  async backoff(attempt, signal) {
    const base = this.retryDelayMs()
    const wait = Math.min(base * 2 ** (attempt - 1), 10_000)
    if (!(wait > 0)) return
    const deadline = Date.now() + wait
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return
      await sleep(Math.min(100, deadline - Date.now()))
    }
  }

  /** In-process worker: a fresh DSH child agent, read back from its session log. */
  async runDshTask(run, task, worker, signal) {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('the DSH agent registry is unavailable in this profile')
    const cwd = worker.cwd ?? run.cwd ?? process.cwd()
    // While a capability list is in play, the candidate at routeIndex is the
    // route of record: a failed supplier hands the work to the next one.
    const candidates = asArray(task.routeCandidates)
    const active = candidates.length > 0
      ? candidates[Math.min(task.routeIndex ?? 0, candidates.length - 1)]
      : undefined
    let route = active !== undefined
      ? { provider: active.provider, model: active.model }
      : task.provider !== undefined || task.model !== undefined
      ? {
        ...(task.provider !== undefined ? { provider: task.provider } : {}),
        ...(task.model !== undefined ? { model: task.model } : {}),
      }
      : worker.provider !== undefined || worker.model !== undefined
        ? { ...(worker.provider ? { provider: worker.provider } : {}), ...(worker.model ? { model: worker.model } : {}) }
        : undefined
    // A child created without an explicit route can sit on an unresolvable
    // default, so hand it the Host's own current selection.
    if (route === undefined || route.provider === undefined || route.model === undefined) {
      try {
        const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
        if (selection?.provider !== undefined && selection?.model !== undefined) {
          route = { provider: selection.provider, model: selection.model }
        }
      } catch {
        /* an unset default simply leaves the child on the Host default */
      }
    }
    await this.appendLog(run, task, `route ${route?.provider ?? 'default'}/${route?.model ?? 'default'}`)
    // Record what actually ran, so the board names the real model instead of
    // showing nothing for a task that was routed at execution time.
    if (route?.provider !== undefined) task.provider = route.provider
    if (route?.model !== undefined) task.model = route.model
    return { output: await this.callModel({ prompt: task.prompt, route, cwd, tag: 'worker', signal }) }
  }

  /**
   * Run one child agent on an explicit route and return the text it committed.
   *
   * The child is observed through the committed event feed: `session.events`
   * does not exist, and `whenIdle()` can settle against the turn that ended
   * before the followup, so the feed is the only reliable "did it answer"
   * signal.
   */
  async callModel({ prompt, route, cwd, tag, signal, timeoutMs }) {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('the DSH agent registry is unavailable in this profile')
    const handle = await agents.create({
      sessionId: randomUUID(),
      meta: { cwd },
      ...(route === undefined ? {} : { agentOptions: route }),
    })
    const childId = handle.agent.session?.id
    if (childId === undefined) throw new Error('the created child agent exposed no session id')
    const texts = []
    let turnError
    let settle
    const finished = new Promise((resolve) => { settle = resolve })
    const unsubscribe = this.ctx.on('session/event', (session, event) => {
      if (session?.id !== childId) return
      if (event?.type === 'assistant/message') {
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text)
        }
        return
      }
      if (event?.type === 'turn/end') {
        const reason = event.data?.reason
        if (reason?.kind === 'error') turnError = reason.error?.message ?? 'the turn ended with an error'
        settle(reason?.kind ?? 'unknown')
      }
    })
    try {
      signal?.throwIfAborted?.()
      // The inbox expects a complete Message: `followup` only splices it into
      // next-turn, and step assembly needs `role` plus a stable identity.
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs()
      const outcome = await withTimeout(finished, budget, () => {
        try { handle.agent.cancel({ kind: 'user' }) } catch { /* already settled */ }
      })
      if (texts.length === 0) {
        throw new Error(turnError ?? `the ${tag} turn ended (${outcome}) without assistant text`)
      }
      return texts.join('\n\n')
    } finally {
      unsubscribe?.()
      await handle.dispose().catch(() => {})
    }
  }

  /**
   * The reviewer must not be the model that did the work. A second opinion from
   * the implementer itself (or its twin on the same route) is worth little, so
   * the first worker on a *different* route wins.
   */
  pickReviewer(run, task, health) {
    const routed = this.workers(run.cwd)
      .filter((worker) => worker.kind === 'dsh' && worker.provider !== undefined && worker.model !== undefined)
    if (routed.length === 0) return undefined
    const judge = this.routeHealthJudge(health)
    // A second opinion from the same weights on a different endpoint is not a
    // second opinion. Score the candidates: a different MODEL is worth most, a
    // different provider next, and a route that just failed is worth nothing.
    const scored = routed.map((worker) => {
      const sameModel = modelKey(worker.model) === modelKey(task.model) ? 1 : 0
      const sameFamily = modelFamily(worker.model) === modelFamily(task.model) ? 1 : 0
      const sameProvider = worker.provider === task.provider ? 1 : 0
      const dead = judge.isDead(worker) ? 1 : 0
      return { worker, rank: dead * 16 + sameModel * 8 + sameFamily * 4 + sameProvider * 2 }
    })
    scored.sort((a, b) => a.rank - b.rank)
    const chosen = scored[0].worker
    return { provider: chosen.provider, model: chosen.model, worker: chosen.id }
  }

  /** Ask a different model whether the output actually satisfies the job. */
  async reviewOutput(run, task, signal) {
    const reviewer = this.pickReviewer(run, task, await this.loadRouteHealth(run.cwd))
    if (reviewer === undefined) {
      return { pass: true, reason: '', skipped: true }
    }
    const criteria = typeof task.acceptCriteria === 'string' && task.acceptCriteria.trim() !== ''
      ? task.acceptCriteria
      : '产出必须完整、可直接使用，且确实完成了任务要求；不得包含占位符、TODO、"待补充"或未完成的说明。'
    const prompt = [
      '你是验收方，不是执行方。只判断，不要重做任务，也不要调用工具。',
      '',
      `任务：${task.subject}`,
      `验收标准：${criteria}`,
      '',
      '产出：',
      task.output === undefined || task.output === '' ? '(空)' : clampText(task.output, 12_000),
      '',
      '只输出一个 JSON 对象，不要输出任何其他文字、解释或代码围栏：',
      '满足要求时：{"verdict":"pass","issues":[]}',
      '不满足时：{"verdict":"block","issues":["必须修正的具体问题","第二条…"]}',
      'issues 里只写产出本身的问题，不要复述这段说明。',
    ].join('\n')
    await this.appendLog(run, task, `accept by ${reviewer.provider}/${reviewer.model}`)
    let text
    try {
      text = await this.callModel({
        prompt,
        route: { provider: reviewer.provider, model: reviewer.model },
        cwd: run.cwd,
        tag: 'reviewer',
        signal,
        timeoutMs: this.reviewTimeoutMs(),
      })
    } catch (error) {
      // A broken reviewer (expired key, dead route) must not reject good work:
      // the gate is skipped and said so, instead of failing the deliverable.
      if (signal?.aborted === true) throw error
      const reason = error instanceof Error ? error.message : String(error)
      await this.appendLog(run, task, `accept skipped, reviewer failed: ${reason}`)
      return { pass: true, reason: '', skipped: true, reviewError: reason }
    }
    const parsed = parseVerdict(text)
    if (parsed.unparsed !== undefined) {
      await this.appendLog(run, task, `accept verdict unparseable, treated as pass: ${parsed.unparsed}`)
    }
    return {
      pass: parsed.pass,
      reason: parsed.pass ? '' : parsed.issues.join('\n'),
      reviewer,
      provider: reviewer.provider,
      model: reviewer.model,
    }
  }

  /**
   * Local or remote OpenAI-compatible worker: LM Studio (127.0.0.1:1234/v1),
   * Ollama (11434/v1), vLLM, llama.cpp's server, LocalAI — anything that speaks
   * /chat/completions. This is how a model that lives on THIS machine becomes a
   * dispatchable worker without a CLI wrapper.
   */
  /**
   * Image generation is a different endpoint and a different result shape: the
   * payload carries base64 or a URL that expires, so the bytes are saved next
   * to the run and the saved path is the deliverable.
   */
  async runImageTask(run, task, worker, model, signal) {
    const baseUrl = asString(worker.baseUrl)
    const url = `${String(baseUrl).replace(/[/]+$/, '')}/images/generations`
    const headers = { 'content-type': 'application/json' }
    const key = await resolveWorkerKey(this.ctx, worker)
    if (key !== undefined) headers.authorization = `Bearer ${key}`
    const body = {
      model,
      prompt: task.prompt,
      n: 1,
      ...(worker.size === undefined ? {} : { size: worker.size }),
      ...(worker.responseFormat === undefined ? {} : { response_format: worker.responseFormat }),
    }
    await this.appendLog(run, task, `POST ${url} model=${model}`)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort)
    // Image models routinely need far longer than a text call.
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs(), 180_000))
    try {
      const response = await fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw httpFailure(url, response.status, text)
      }
      const payload = await response.json()
      const first = Array.isArray(payload?.data) ? payload.data[0] : undefined
      if (first === undefined || typeof first !== 'object') {
        throw new Error(`the endpoint returned no image: ${clampText(JSON.stringify(payload ?? {}), 300)}`)
      }

      const dir = join(this.rootFor(run.cwd), 'images', run.id)
      await mkdir(dir, { recursive: true })
      const stamp = task.id
      let saved
      if (typeof first.b64_json === 'string' && first.b64_json !== '') {
        saved = join(dir, `${stamp}.png`)
        await writeFile(saved, Buffer.from(first.b64_json, 'base64'))
      } else if (typeof first.url === 'string' && first.url !== '') {
        // A hosted URL expires; keep the bytes so the deliverable survives.
        const download = await fetch(first.url, { signal: controller.signal })
        if (!download.ok) throw new Error(`the image URL answered HTTP ${download.status}`)
        const buffer = Buffer.from(await download.arrayBuffer())
        const extension = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(first.url)?.[1]?.toLowerCase() ?? 'png'
        saved = join(dir, `${stamp}.${extension}`)
        await writeFile(saved, buffer)
      } else {
        throw new Error('the endpoint returned neither b64_json nor url')
      }
      const { stat } = await import('node:fs/promises')
      const size = await stat(saved).catch(() => undefined)
      await this.appendLog(run, task, `saved ${saved}${size === undefined ? '' : ` (${size.size} bytes)`}`)
      const imageUsage = payload?.usage
      const imageTokens = imageUsage === null || typeof imageUsage !== 'object'
        ? undefined
        : { total: Number.isFinite(Number(imageUsage.total_tokens)) ? Number(imageUsage.total_tokens) : undefined }
      return {
        output: `已生成图片：${saved}${size === undefined ? '' : `（${size.size} 字节）`}`,
        imagePath: saved,
        ...(imageTokens?.total === undefined ? {} : { tokens: imageTokens }),
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  async runHttpTask(run, task, worker, signal) {
    const baseUrl = asString(worker.baseUrl)
    if (baseUrl === undefined) throw permanent(`http worker "${worker.id}" declares no baseUrl`)
    const model = asString(task.model) ?? asString(worker.model)
    if (model === undefined) throw permanent(`http worker "${worker.id}" declares no model`)
    if (worker.mode === 'image') return await this.runImageTask(run, task, worker, model, signal)
    const url = `${baseUrl.replace(/[/]+$/, '')}/chat/completions`
    const headers = { 'content-type': 'application/json' }
    const key = await resolveWorkerKey(this.ctx, worker)
    if (key !== undefined) headers.authorization = `Bearer ${key}`
    await this.appendLog(run, task, `POST ${url} model=${model}`)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs())
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: task.prompt }],
          stream: false,
          ...(worker.maxTokens === undefined ? {} : { max_tokens: worker.maxTokens }),
        }),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw httpFailure(url, response.status, body)
      }
      const payload = await response.json()
      const content = payload?.choices?.[0]?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
          : ''
      if (text.trim() === '') throw new Error('the endpoint returned an empty completion')
      // Usage is the only honest way to answer "who cost what".
      const usage = payload?.usage
      const tokens = usage === null || typeof usage !== 'object'
        ? undefined
        : {
          prompt: Number.isFinite(Number(usage.prompt_tokens)) ? Number(usage.prompt_tokens) : undefined,
          completion: Number.isFinite(Number(usage.completion_tokens)) ? Number(usage.completion_tokens) : undefined,
          total: Number.isFinite(Number(usage.total_tokens))
            ? Number(usage.total_tokens)
            : (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0),
        }
      return { output: text, ...(tokens === undefined ? {} : { tokens }) }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

  /** External worker: a headless CLI driven by a command template. */
  async runCliTask(run, task, worker, signal) {
    const declared = worker.command
    if (declared === undefined) throw new Error(`cli worker "${worker.id}" declares no command`)
    const target = await spawnTarget(declared)
    const command = target.file
    const outFile = join(this.rootFor(run.cwd), 'logs', run.id, `${task.id}.last.txt`)
    await mkdir(join(this.rootFor(run.cwd), 'logs', run.id), { recursive: true })
    const substitute = (value) => String(value)
      .replaceAll('{prompt}', task.prompt)
      .replaceAll('{cwd}', worker.cwd ?? run.cwd ?? process.cwd())
      .replaceAll('{outfile}', outFile)
      .replaceAll('{task}', task.id)
    const args = asArray(worker.args).map(substitute)
    await this.appendLog(run, task, `spawn ${[command, ...target.prefix, ...args].map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' ')}`)

    const collected = []
    const child = spawn(command, [...target.prefix, ...args], {
      cwd: worker.cwd ?? run.cwd ?? process.cwd(),
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...(worker.env ?? {}), NO_COLOR: '1' },
      signal,
    })
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      collected.push(text)
      void this.appendLog(run, task, `out ${text.trimEnd()}`)
    })
    child.stderr?.on('data', (chunk) => {
      void this.appendLog(run, task, `err ${String(chunk).trimEnd()}`)
    })
    const exit = await withTimeout(new Promise((done, fail) => {
      child.on('error', fail)
      child.on('close', (code) => done(code ?? -1))
    }), this.timeoutMs(), () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    })
    if (exit !== 0) {
      const stderrHint = collected.join('').trim().slice(-800)
      throw new Error(`worker exited with code ${exit}${stderrHint ? `: ${stderrHint}` : ''}`)
    }
    let output = ''
    try {
      output = (await readFile(outFile, 'utf8')).trim()
    } catch {
      output = collected.join('').trim()
    }
    if (output === '') throw new Error('the worker exited cleanly but produced no output')
    return { output }
  }

  cancel(runId) {
    const controller = this.controllers.get(runId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /* ── reporting ── */

  summary(run) {
    const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 }
    for (const task of run.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1
    return {
      id: run.id,
      goal: run.goal,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      total: run.tasks.length,
      counts,
    }
  }

  view(run) {
    return {
      ...this.summary(run),
      tasks: run.tasks.map((task) => ({
        ...task,
        // The board polls this: never ship a whole transcript per tick.
        output: task.output === undefined ? undefined : clampText(task.output, 8000),
      })),
    }
  }

  async logTail(run, taskId, lines = LOG_TAIL_LINES) {
    const task = run.tasks.find((entry) => entry.id === taskId)
    if (task === undefined) return ''
    try {
      const text = await readFile(task.logPath, 'utf8')
      return text.split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  async storedRuns(cwd) {
    const stored = await readJson(this.fileFor(cwd))
    return asArray(stored?.runs).map((run) => this.normalizeRun(run))
  }
}

/** codex's headless contract; `-o` writes the final message where we can read it. */
const CODEX_ARGS = ['exec', '--skip-git-repo-check', '--ephemeral', '-C', '{cwd}', '-s', 'workspace-write', '-o', '{outfile}', '{prompt}']

/* ────────────────────────────── tool schemas ────────────────────────────── */

const TASK_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'prompt'],
  properties: {
    id: { type: 'string', description: 'Local task id, unique inside this run.' },
    prompt: { type: 'string', description: 'The complete instruction for the worker. Workers see nothing else.' },
    subject: { type: 'string', description: 'Short human label shown on the board.' },
    type: { type: 'string', enum: ['implement', 'review', 'research', 'test', 'docs', 'image', 'any'], description: 'Drives which worker is routed to this task.' },
    worker: { type: 'string', description: 'Force one worker id instead of routing by type.' },
    needs: {
      type: 'array', items: { type: 'string' },
      description: 'Capabilities the task requires. A named class (coding/reasoning/fast/vision/long-context, as declared in the plugin config) picks the model known to be good at it; `vision`/`image` falls back to a model that accepts image input; `long-context` to the largest window.',
    },
    provider: { type: 'string', description: 'Force the model route provider for this task (overrides routing).' },
    model: { type: 'string', description: 'Force the model id for this task (overrides routing).' },
    accept: { type: 'boolean', description: 'Require cross-model acceptance: a different model reviews the deliverable and may send it back for rework.' },
    acceptCriteria: { type: 'string', description: 'What "done right" means for the acceptance reviewer.' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish successfully first.' },
  },
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

function registerTools(ctx, engine) {
  const tools = ctx.tools
  if (tools === undefined) return

  ctx.effect(() => tools.register({
    name: 'dispatch_workers',
    description: 'List the AI workers this plugin can dispatch to on this machine, with their kind and whether an external CLI binary was found. Call this before planning work so the plan only uses workers that exist.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' }, kind: { type: 'string' }, label: { type: 'string' },
                available: { type: 'boolean' }, detail: { type: 'string' },
                provider: { type: 'string' }, model: { type: 'string' },
                status: { type: 'string' }, latencyMs: { type: 'number' },
                capabilities: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock([
        'Workers:',
        ...value.workers.map((worker) => {
          const route = worker.model === undefined ? '' : ` → ${worker.provider ?? '?'}/${worker.model}`
          const mark = worker.status === 'alive' ? '✓ ' : worker.status === 'dead' ? '✗ ' : '· '
          const timing = worker.latencyMs === undefined ? '' : ` ${(worker.latencyMs / 1000).toFixed(1)}s`
          const state = worker.status === undefined ? '' : ` [${worker.status}${timing}]`
          return `${mark}${worker.id} (${worker.kind})${route}${state}${worker.available === false ? ' UNAVAILABLE' : ''}${worker.detail ? ` — ${worker.detail}` : ''}`
        }),
      ].join('\n')),
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const declared = engine.workers(cwd)
      const catalog = await resolveCatalog(ctx).catch(() => ({ available: false, routes: [] }))
      const workers = []
      for (const worker of declared) {
        const route = worker.provider === undefined && worker.model === undefined
          ? undefined
          : { provider: worker.provider, model: worker.model }
        const routeFields = route === undefined ? {} : {
          ...(route.provider === undefined ? {} : { provider: route.provider }),
          ...(route.model === undefined ? {} : { model: route.model }),
        }
        const judge = engine.routeHealthJudge(await engine.loadRouteHealth(cwd))
        const aliveMap = await engine.loadRouteAlive(cwd)
        const health = (target) => {
          if (target === undefined) return { status: 'unknown' }
          const key = `${target.provider}/${target.model}`
          if (judge.isDead(target)) return { status: 'dead', detail: String(engine.config.capabilities === undefined ? '' : '').slice(0, 0) || undefined }
          const record = aliveMap[key]
          return record === undefined ? { status: 'unknown' } : { status: 'alive', latencyMs: record.latencyMs }
        }
        if (worker.kind === 'dsh') {
          const registry = ctx.get('agents')
          let selection
          if (route === undefined) {
            try {
              const current = ctx.get('agentDefaultModel')?.currentSelection?.()
              if (current?.provider !== undefined && current?.model !== undefined) selection = current
            } catch {
              /* an unset default is reported below as unknown */
            }
          }
          const probed = route ?? (selection === undefined ? undefined : { provider: selection.provider, model: selection.model })
          const known = probed === undefined
            ? undefined
            : catalog.routes.find((entry) => entry.provider === probed.provider && entry.model === probed.model)
          const shape = known === undefined ? '' : `, modalities=${known.modalities.join('+')}${known.contextWindow ? ` ctx=${known.contextWindow}` : ''}`
          const dshHealth = health(probed)
          workers.push({
            id: worker.id, kind: 'dsh', label: worker.label ?? worker.id,
            ...dshHealth,
            available: registry !== undefined && (probed === undefined || known !== undefined),
            detail: registry === undefined
              ? 'no agent registry in this profile'
              : route !== undefined
                ? known === undefined
                  ? `route ${route.provider}/${route.model} is not in the live catalog`
                  : `in-process DSH child agent${shape}`
                : probed === undefined
                  ? 'in-process DSH child agent on the Host default route (no default selected)'
                  : `in-process DSH child agent on the Host default ${probed.provider}/${probed.model}${shape}`,
            ...routeFields,
            capabilities: worker.capabilities,
          })
          continue
        }
        if (worker.kind === 'http') {
          const baseUrl = worker.baseUrl
          let available = false
          let detail = 'no baseUrl declared'
          if (baseUrl !== undefined) {
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 4000)
              const probeKey = await resolveWorkerKey(ctx, worker)
              const response = await fetch(`${baseUrl.replace(/[/]+$/, '')}/models`, {
                ...(probeKey === undefined ? {} : { headers: { authorization: `Bearer ${probeKey}` } }),
                signal: controller.signal,
              })
              clearTimeout(timer)
              available = response.ok
              detail = available ? `reachable at ${baseUrl}` : `${baseUrl} answered HTTP ${response.status}`
            } catch (error) {
              detail = `${baseUrl} unreachable: ${error instanceof Error ? error.message : String(error)}`
            }
          }
          let keyState = ''
          if (worker.apiKeyEnv !== undefined) {
            const described = await describeWorkerKey(ctx, worker)
            keyState = ` · key=${worker.apiKeyEnv} ${described.configured ? `已设置${described.source === undefined ? '' : `(${described.source})`}` : '未设置'}`
          }
          workers.push({ id: worker.id, kind: 'http', label: worker.label ?? worker.id, available, status: available ? 'alive' : 'dead', detail: `${detail}${keyState}`, ...routeFields, capabilities: worker.capabilities })
          continue
        }
        let detail = `command: ${worker.command ?? '(none)'}`
        let available = false
        if (worker.command !== undefined) {
          try {
            const found = await findExecutable(worker.command)
            available = found !== undefined
            detail = available ? `found at ${found}` : `binary "${worker.command}" not found on PATH`
          } catch (error) {
            detail = `probe failed: ${String(error)}`
          }
        }
        workers.push({ id: worker.id, kind: 'cli', label: worker.label ?? worker.id, available, status: available ? 'alive' : 'dead', detail, ...routeFields, capabilities: worker.capabilities })
      }
      return { workers }
    },
  }), 'agent-dispatch.workers')

  ctx.effect(() => tools.register({
    name: 'dispatch_models',
    description: 'List every model route this Host can actually reach, with the capabilities routing uses: whether it accepts image input (`vision`), its context window. Call this before assigning specialised work so each task goes to the model best suited to it.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        visionOnly: { type: 'boolean', description: 'Only routes that accept image input.' },
        refresh: { type: 'boolean', description: 'Bypass the one-minute catalog cache.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          available: { type: 'boolean' }, error: { type: 'string' },
          providers: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' } } },
          },
          routes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                provider: { type: 'string' }, model: { type: 'string' }, name: { type: 'string' },
                vision: { type: 'boolean' }, contextWindow: { type: 'number' }, error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.available === false) return textBlock(`The model catalog is unavailable: ${value.error ?? 'unknown reason'}`)
        const lines = [`${value.providers.length} provider(s), ${value.routes.length} route(s):`]
        for (const provider of value.providers) {
          const routes = value.routes.filter((route) => route.provider === provider.id)
          lines.push(`\n${provider.id} (${provider.name})`)
          for (const route of routes) {
            lines.push(`- ${route.model}${route.vision ? ' [vision]' : ''}${route.contextWindow ? ` ctx=${route.contextWindow}` : ''}${route.error ? ` ERROR ${route.error}` : ''}`)
          }
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const catalog = await resolveCatalog(ctx, { force: args.refresh === true })
      const routes = args.visionOnly === true ? catalog.routes.filter((route) => route.vision) : catalog.routes
      return {
        available: catalog.available,
        ...(catalog.error === undefined ? {} : { error: catalog.error }),
        providers: catalog.providers,
        routes: routes.map((route) => ({
          provider: route.provider, model: route.model, name: route.name,
          vision: route.vision === true,
          ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
          ...(route.error === undefined ? {} : { error: route.error }),
        })),
      }
    },
  }), 'agent-dispatch.models')

  ctx.effect(() => tools.register({
    name: 'dispatch_capabilities',
    description: 'Show the declared capability table — which model this deployment treats as best at coding, reasoning, fast work, vision and so on — with every entry resolved against the live model catalog so a stale or invented route is visible instead of silently misrouting.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { refresh: { type: 'boolean', description: 'Bypass the one-minute catalog cache.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          declared: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                need: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
                effectiveProvider: { type: 'string' }, effectiveModel: { type: 'string' }, demoted: { type: 'boolean' }, demoteReason: { type: 'string' },
                known: { type: 'boolean' }, detail: { type: 'string' },
              },
            },
          },
          unconfigured: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.declared.length === 0) {
          return textBlock('No capability table is configured. Tasks fall back to modality facts (vision / context window) and the routing table only.')
        }
        const lines = ['Capability table:']
        for (const entry of value.declared) {
          const target = entry.effectiveModel === undefined ? `${entry.provider}/${entry.model}` : `${entry.effectiveProvider}/${entry.effectiveModel}`
          const note = entry.demoted === true ? `  (declared ${entry.provider}/${entry.model} — ${entry.demoteReason ?? 'reordered'})` : ''
          lines.push(`- ${entry.need} → ${target}${entry.known ? '' : `  ⚠ ${entry.detail}`}${note}`)
        }
        if (value.unconfigured.length > 0) lines.push(`\nUnconfigured: ${value.unconfigured.join(', ')}`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const catalog = await resolveCatalog(ctx, { force: args.refresh === true })
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const declaredTable = engine.config.capabilities ?? {}
      const capabilities = await engine.loadCapabilities(cwd)
      const health = await engine.loadRouteHealth(cwd)
      const judge = engine.routeHealthJudge(health)
      const declared = []
      for (const [need, list] of Object.entries(capabilities)) {
        // Rank EXACTLY the pool the router would rank: every declared route for
        // this class, merged with the catalog. Ranking only the declared head
        // reports "first catalog-order route that is not dead", which is why
        // three classes once pointed at the same model.
        const routes = asArray(list).map(parseRouteEntry).filter((route) => route !== undefined)
        if (routes.length === 0) continue
        const head = routes[0]
        const known = catalog.routes.find((candidate) => candidate.provider === head.provider && candidate.model === head.model)
        const ordered = orderCandidates(routes, catalog, engine.config.providerPreference, judge, await engine.loadRouteAlive(cwd))
        const effective = ordered[0] ?? head
        const moved = effective.provider !== head.provider || effective.model !== head.model
        declared.push({
          need,
          provider: head.provider,
          model: head.model,
          effectiveProvider: effective.provider,
          effectiveModel: effective.model,
          demoted: moved,
          // Say WHY it moved: a dead head and a merely slower head are very
          // different facts, and calling both "demoted by health" was a lie.
          ...(moved
            ? { demoteReason: judge.isDead(head) ? 'the declared head is known dead' : 'a faster live candidate outranks it' }
            : {}),
          known: known !== undefined,
          detail: known === undefined ? 'not in the live catalog' : `modalities=${known.modalities.join('+')}`,
        })
      }

      const standard = ['coding', 'reasoning', 'fast', 'vision', 'long-context']
      return { declared, unconfigured: standard.filter((need) => capabilities[need] === undefined) }
    },
  }), 'agent-dispatch.capabilities')

  ctx.effect(() => tools.register({
    name: 'dispatch_research',
    description: 'Research which model on this machine is actually good at what, once, and cache the answer. The scout model sees the live route roster and returns a capability table; every route it names is validated against the catalog so an invented or retired model is dropped instead of silently misrouting. Later runs route by this table through task needs.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        scout: { type: 'string', description: '"provider/model" of the model that does the research. Defaults to the first configured worker route.' },
        needs: { type: 'array', items: { type: 'string' }, description: 'Capability classes to research. Defaults to coding, reasoning, fast, vision, long-context.' },
        refresh: { type: 'boolean', description: 'Re-read the live catalog before researching.' },
        healthyOnly: { type: 'boolean', description: 'Offer the scout only routes not known to be broken, verified-alive first. Defaults to true.' },
        verify: { type: 'boolean', description: 'Probe every route the scout picks before saving it, and backfill dead picks from the offered pool. Defaults to true.' },
        probeTimeoutMs: { type: 'number', description: 'Per-route probe budget during verification (default 15000).' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          scout: { type: 'string' }, catalogSize: { type: 'number' }, offered: { type: 'number' }, file: { type: 'string' },
          capabilities: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          rejected: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`Capability table researched by ${value.scout} over ${value.catalogSize} routes (${value.offered ?? value.catalogSize} offered, each pick probe-verified), saved to ${value.file}:`]
        for (const entry of value.capabilities) lines.push(`- ${entry.need}: ${entry.routes.join(', ')}`)
        if (value.rejected.length > 0) lines.push(`\nDropped: ${value.rejected.join(', ')}`)
        return textBlock(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const catalog = await resolveCatalog(ctx, { force: args.refresh === true })
      if (catalog.available === false) throw new Error(`cannot research capabilities: ${catalog.error ?? 'the model catalog is unavailable'}`)
      if (catalog.routes.length === 0) throw new Error('cannot research capabilities: the catalog is empty')

      const wanted = asArray(args.needs).filter((need) => typeof need === 'string')
      const classes = wanted.length > 0 ? wanted : ['coding', 'reasoning', 'fast', 'vision', 'long-context']

      // Choose the scout: explicit, then the first configured route, then the host default.
      let scout = undefined
      const asked = asString(args.scout)
      if (asked !== undefined && asked.includes('/')) {
        scout = { provider: asked.slice(0, asked.indexOf('/')), model: asked.slice(asked.indexOf('/') + 1) }
      }
      if (scout === undefined) {
        const routed = engine.workers(cwd).find((worker) => worker.provider !== undefined && worker.model !== undefined)
        if (routed !== undefined) scout = { provider: routed.provider, model: routed.model }
      }
      if (scout === undefined) {
        try {
          const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
          if (selection?.provider !== undefined && selection?.model !== undefined) scout = selection
        } catch {
          /* handled below */
        }
      }
      if (scout === undefined) throw new Error('cannot research capabilities: no scout route is available; pass one explicitly as "provider/model"')

      // Never ask the scout to rank routes we already know are broken: a table
      // built from dead entries sends every later job into a wall.
      const health = await engine.loadRouteHealth(cwd)
      const alive = await engine.loadRouteAlive(cwd)
      const judge = engine.routeHealthJudge(health)
      // "not known dead" is not "verified alive": a never-probed route is only a
      // hope. Rank the offer verified-first, drop everything already proven
      // broken, and cap it so the scout gets a list it can reason over.
      const notDead = catalog.routes.filter((route) => !judge.isDead(route))
      const isVerified = (route) => alive[`${route.provider}/${route.model}`] !== undefined
      const ranked = [...notDead].sort((a, b) => (isVerified(b) ? 1 : 0) - (isVerified(a) ? 1 : 0))
      const offered = args.healthyOnly === false || ranked.length === 0 ? catalog.routes : ranked.slice(0, 60)
      const roster = offered
        .map((route) => `${route.provider}/${route.model}${route.vision ? ' [vision]' : ''}${route.contextWindow ? ` ctx=${route.contextWindow}` : ''}`)
        .join(String.fromCharCode(10))
      const prompt = [
        '你在为一家 AI 外包公司编制「用人能力表」：判断这台机器上每个模型最适合干什么活。',
        '',
        '下面是本机真实可用的模型名册（每行 provider/model，可能带 [vision] 和 ctx=上下文长度）：',
        roster,
        '',
        `请为这些类别各挑出最合适的模型：${classes.join(', ')}。`,
        '- coding：写代码、改代码、多文件重构',
        '- reasoning：复杂推理、方案设计、疑难定位',
        '- fast：简单改写、格式转换、快速应答',
        '- vision：需要看图片、截图、设计稿',
        '- long-context：通读大仓库或长文档',
        '',
        '规则：',
        '1. 只能从上面的名册里选，禁止编造名册外的模型名。',
        '2. 每类 1-3 个，按最合适排前面。同一模型可以出现在多个类别。',
        '3. [vision] 标记的才适合 vision 类；ctx 越大越适合 long-context。',
        '4. 判断依据用你的已有知识；拿不准的模型就不要放进该类别，宁缺毋滥。',
        '',
        '只输出一个 JSON 对象，不要任何解释或代码围栏，形如：',
        '{"coding":["provider/model"],"reasoning":["provider/model"],"fast":["provider/model"],"vision":["provider/model"],"long-context":["provider/model"]}',
      ].join('\n')

      await ctx.logger?.info?.(`agent-dispatch: researching capabilities with ${scout.provider}/${scout.model}`)
      const text = await engine.callModel({ prompt, route: scout, cwd, tag: 'scout', signal: exec?.signal })

      const parsed = parseCapabilityTable(text)
      const known = new Set(catalog.routes.map((route) => `${route.provider}/${route.model}`))
      const capabilities = {}
      const rejected = []
      const taken = new Set()

      // A scout ranks by reputation; only a probe knows whether a key still
      // works. Verify every pick before it is written into the table, and
      // backfill from the offered pool when a pick turns out to be dead.
      const verify = args.verify !== false
      const llm = ctx.get('llm')
      const canProbe = verify && llm !== undefined && typeof llm.stream === 'function'
      const probeBudget = Number.isFinite(Number(args.probeTimeoutMs)) && Number(args.probeTimeoutMs) > 0
        ? Math.min(Number(args.probeTimeoutMs), 60_000)
        : 15_000
      const probeResults = []
      const passes = async (entry) => {
        if (!canProbe) return true
        const route = parseRouteEntry(entry)
        if (route === undefined) return false
        const outcome = await engine.probeRoute(llm, route, probeBudget)
        probeResults.push({ provider: route.provider, model: route.model, ...outcome })
        return outcome.ok
      }

      for (const need of classes) {
        const list = asArray(parsed[need]).filter((entry) => typeof entry === 'string')
        const kept = []
        for (const entry of list) {
          if (!known.has(entry)) {
            if (!rejected.includes(entry)) rejected.push(entry)
            continue
          }
          const parsedRoute = parseRouteEntry(entry)
          if (parsedRoute !== undefined && judge.isDead(parsedRoute)) {
            const label = `${entry} (known dead)`
            if (!rejected.includes(label)) rejected.push(label)
            continue
          }
          if (taken.has(entry)) continue
          if (!(await passes(entry))) {
            const label = `${entry} (probe failed)`
            if (!rejected.includes(label)) rejected.push(label)
            continue
          }
          taken.add(entry)
          kept.push(entry)
        }
        // Backfill: walk the offered pool until this class has a live route.
        if (kept.length === 0) {
          for (const route of offered) {
            const entry = `${route.provider}/${route.model}`
            if (taken.has(entry)) continue
            if (!(await passes(entry))) {
              const label = `${entry} (probe failed)`
              if (!rejected.includes(label)) rejected.push(label)
              continue
            }
            taken.add(entry)
            kept.push(entry)
            break
          }
        }
        if (kept.length > 0) capabilities[need] = kept.slice(0, 5)
      }

      if (probeResults.length > 0) await engine.applyProbeResults(cwd, probeResults)

      if (Object.keys(capabilities).length === 0) {
        throw new Error(`the scout returned no usable route; raw answer: ${clampText(text, 600)}`)
      }

      const file = engine.capabilitiesFile(cwd)
      await mkdir(engine.rootFor(cwd), { recursive: true })
      await atomicWriteJson(file, {
        version: STATE_VERSION,
        at: nowIso(),
        scout: `${scout.provider}/${scout.model}`,
        catalogSize: catalog.routes.length,
        offered: offered.length,
        capabilities,
        rejected,
      })
      return {
        scout: `${scout.provider}/${scout.model}`,
        catalogSize: catalog.routes.length,
        offered: offered.length,
        file,
        capabilities: Object.entries(capabilities).map(([need, routes]) => ({ need, routes })),
        rejected,
      }
    },
  }), 'agent-dispatch.research')

  ctx.effect(() => tools.register({
    name: 'dispatch_probe',
    description: 'Probe which model routes actually answer right now, with a real one-token request instead of trusting the catalog. A cataloged route can still fail on an expired key or a disabled account; a probe writes that verdict into the route-health memory so later runs route around it. Default target is the capability table plus every configured worker route.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        routes: {
          type: 'array', items: { type: 'string' },
          description: 'Explicit "provider/model" strings to probe. Omit to probe the capability table and the configured worker routes.',
        },
        all: { type: 'boolean', description: 'Probe every route in the live catalog. Slow and quota-hungry; use deliberately.' },
        limit: { type: 'number', description: 'Cap the number of routes probed (default 12, max 40).' },
        timeoutMs: { type: 'number', description: 'Per-route budget in milliseconds (default 20000).' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          probed: { type: 'number' }, alive: { type: 'number' }, dead: { type: 'number' },
          routes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                provider: { type: 'string' }, model: { type: 'string' },
                ok: { type: 'boolean' }, latencyMs: { type: 'number' }, error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`Probed ${value.probed} route(s): ${value.alive} alive, ${value.dead} dead.`]
        for (const route of value.routes) {
          const mark = route.ok ? '✓' : '✗'
          const lat = route.latencyMs === undefined ? '' : ` ${route.latencyMs}ms`
          lines.push(`- ${mark} ${route.provider}/${route.model}${lat}${route.ok ? '' : ` — ${route.error}`}`)
        }
        return textBlock(lines.join(String.fromCharCode(10)))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.stream !== 'function') throw new Error('cannot probe: the llm service is unavailable')
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const catalog = await resolveCatalog(ctx, { force: true })
      const budget = Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0 ? Math.min(Number(args.timeoutMs), 120_000) : 20_000

      const wanted = []
      const add = (provider, model) => {
        if (typeof provider !== 'string' || typeof model !== 'string') return
        const key = `${provider}/${model}`
        if (wanted.some((entry) => `${entry.provider}/${entry.model}` === key)) return
        wanted.push({ provider, model })
      }
      for (const entry of asArray(args.routes)) {
        const parsed = parseRouteEntry(entry)
        if (parsed !== undefined) add(parsed.provider, parsed.model)
      }
      if (wanted.length === 0) {
        const capabilities = await engine.loadCapabilities(cwd)
        for (const list of Object.values(capabilities)) {
          for (const entry of asArray(list)) {
            const parsed = parseRouteEntry(entry)
            if (parsed !== undefined) add(parsed.provider, parsed.model)
          }
        }
        for (const worker of engine.workers(cwd)) add(worker.provider, worker.model)
      }
      if (args.all === true) {
        for (const route of catalog.routes) add(route.provider, route.model)
      }
      if (wanted.length === 0) throw new Error('cannot probe: no route was named and none is configured')

      // `all` widens the default target pool; it must not silently ignore an
      // explicit limit, or a "probe everything" request becomes a 152-call run.
      const explicitLimit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
      const cap = explicitLimit ? Math.min(Math.floor(Number(args.limit)), 40) : (args.all === true ? 40 : 12)
      const targets = wanted.slice(0, cap)
      const results = []
      // Bounded parallelism: providers rate-limit, and this is a health check.
      let cursor = 0
      const batches = Math.min(3, targets.length)
      await Promise.all(Array.from({ length: batches }, async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= targets.length) return
          const route = targets[index]
          const outcome = await engine.probeRoute(llm, route, budget)
          results.push({ provider: route.provider, model: route.model, ...outcome })
        }
      }))
      await engine.applyProbeResults(cwd, results)
      return plain({
        probed: results.length,
        alive: results.filter((result) => result.ok).length,
        dead: results.filter((result) => !result.ok).length,
        routes: results,
      })
    },
  }), 'agent-dispatch.probe')

  ctx.effect(() => tools.register({
    name: 'dispatch_cloud',
    description: 'Interrogate the configured cloud (http) workers: list the models each key can actually reach via /models, then send one minimal chat request per model to find out whether that account still has quota. Results are written into the health memory so the board and the router see them. Use this instead of guessing model ids from documentation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        worker: { type: 'string', description: 'Only interrogate this http worker id.' },
        sample: { type: 'number', description: 'How many models per worker to quota-test (default 4, max 12).' },
        models: { type: 'array', items: { type: 'string' }, description: 'Explicit model ids to test instead of sampling /models. Use this when the provider catalog is stale or the id comes from a console page.' },
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
          lines.push(`■ ${worker.label ?? worker.id}  ${worker.baseUrl ?? '(no baseUrl)'}`)
          if (worker.keyEnv !== undefined) lines.push(`   key ${worker.keyEnv}: ${worker.keyState}`)
          if (worker.reachable === false) {
            lines.push(`   不可用 — ${worker.detail ?? 'unknown'}`)
            continue
          }
          lines.push(`   可访问，${worker.models.length} 个模型`)
          if (worker.models.length > 0) lines.push(`   模型：${worker.models.slice(0, 12).join(', ')}${worker.models.length > 12 ? ' …' : ''}`)
          for (const probe of worker.quota) {
            lines.push(`   ${probe.ok ? '✓' : '✗'} ${probe.model}${probe.latencyMs === undefined ? '' : ` ${probe.latencyMs}ms`}${probe.ok ? ' 有额度' : ` — ${probe.error}`}`)
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
          : `no http worker named "${requested}"`)
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
        const key = await resolveWorkerKey(ctx, worker)
        if (worker.apiKeyEnv !== undefined) {
          if (key === undefined) {
            entry.keyState = '未设置（可在插件设置页填写）'
            entry.detail = `缺少 ${worker.apiKeyEnv}：既没有存到凭据库，环境变量里也没有`
            results.push(entry)
            continue
          }
          entry.keyState = '已设置'
          headers.authorization = `Bearer ${key}`
        }

        const root = baseUrl.replace(/[/]+$/, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), budget)
        try {
          const response = await fetch(`${root}/models`, { headers, signal: controller.signal })
          const body = await response.text().catch(() => '')
          if (!response.ok) {
            entry.detail = `/models 返回 HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`
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
          entry.detail = `/models 请求失败: ${error instanceof Error ? error.message : String(error)}`
          results.push(entry)
          continue
        } finally {
          clearTimeout(timer)
        }

        // Quota can only be answered by spending one token. An explicit id list
        // wins, because a provider's /models can lag behind what a console has
        // actually activated.
        const asked = asArray(args.models).filter((id) => typeof id === 'string' && id !== '')
        const preferred = asked.length > 0 ? asked : [worker.model, ...entry.models].filter((id) => typeof id === 'string')
        const picks = [...new Set(preferred)].slice(0, asked.length > 0 ? asked.length : sample)
        for (const model of picks) {
          const started = Date.now()
          const inner = new AbortController()
          const innerTimer = setTimeout(() => inner.abort(), budget)
          try {
            const response = await fetch(`${root}/chat/completions`, {
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
              const reason = `HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 180)}`}`
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
      return plain({ workers: results })
    },
  }), 'agent-dispatch.cloud')

  ctx.effect(() => tools.register({
    name: 'dispatch_run',
    description: 'Dispatch a goal to a set of workers. Each task runs on the worker routed to its type (or an explicit worker). Tasks honour dependsOn, run in parallel up to a limit, and the first task to finish unlocks its dependents. Returns immediately unless wait is true; use dispatch_status to follow progress.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'tasks'],
      properties: {
        goal: { type: 'string', description: 'What the whole run is for. Shown on the board.' },
        tasks: { type: 'array', items: TASK_INPUT_SCHEMA, description: 'The tasks, in any order; dependencies decide execution order.' },
        wait: { type: 'boolean', description: 'Block until every task settles. Defaults to false.' },
        maxParallel: { type: 'number', description: 'How many tasks may run at once (capped at 8).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          run_id: { type: 'string' }, status: { type: 'string' }, state_dir: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, status: { type: 'string' }, worker: { type: 'string' },
                provider: { type: 'string' }, model: { type: 'string' }, attempts: { type: 'number' }, error: { type: 'string' }, output: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Run ${value.run_id} — ${value.status}`,
          ...value.tasks.map((task) => `- ${task.id} [${task.status}] ${task.model === undefined ? `worker=${task.worker ?? 'none'}` : `route=${task.provider ?? task.worker ?? '?'}/${task.model}`}${task.error ? ` error=${task.error}` : ''}`),
        ]
        // A waited run should hand back the answers, not just the bookkeeping.
        for (const task of value.tasks) {
          if (task.output === undefined || task.output === '') continue
          lines.push(`\n── ${task.id} ──\n${task.output}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const run = await engine.createRun({
        goal: args.goal,
        tasks: args.tasks,
        cwd,
        maxParallel: args.maxParallel,
      })
      await engine.startRun(run)
      if (args.wait === true) await run.promise
      const tasks = run.tasks.map((task) => ({
        id: task.id, status: task.status, worker: task.worker,
        ...(task.provider === undefined ? {} : { provider: task.provider }),
        ...(task.model === undefined ? {} : { model: task.model }),
        ...(task.attempts === undefined ? {} : { attempts: task.attempts }),
        ...(task.error === undefined ? {} : { error: task.error }),
        ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        ...(task.imagePath === undefined ? {} : { imagePath: task.imagePath }),
        ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        ...(task.output === undefined ? {} : { output: clampText(task.output, 4000) }),
      }))
      return plain({ run_id: run.id, status: run.status, state_dir: engine.rootFor(cwd), tasks })
    },
  }), 'agent-dispatch.run')

  ctx.effect(() => tools.register({
    name: 'outsource_run',
    description: 'Outsource a whole job end to end, the way a firm takes a contract: intake a goal and its tasks, dispatch each one to the model best suited to it, have a DIFFERENT model accept the deliverable (and send it back for rework when it does not hold up), then deliver a consolidated report with the ledger. Use this instead of dispatch_run when the work must be checked, not merely run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'tasks'],
      properties: {
        goal: { type: 'string', description: 'The contract: what the client asked for. Shown on the board.' },
        tasks: { type: 'array', items: TASK_INPUT_SCHEMA, description: 'The work order. Dependencies decide execution order.' },
        maxParallel: { type: 'number', description: 'How many tasks may run at once (capped at 8).' },
        wait: { type: 'boolean', description: 'Block until delivery. Defaults to true — an outsourced job normally returns its report.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          run_id: { type: 'string' }, status: { type: 'string' },
          delivered: { type: 'number' }, blocked: { type: 'number' }, failed: { type: 'number' },
          reworks: { type: 'number' }, retries: { type: 'number' }, elapsedMs: { type: 'number' },
          tasks: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, subject: { type: 'string' }, status: { type: 'string' },
                worker: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
                attempts: { type: 'number' }, verdict: { type: 'string' }, reviewBy: { type: 'string' }, rework: { type: 'number' },
                attemptLog: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
                durationMs: { type: 'number' }, error: { type: 'string' }, output: { type: 'string' }, imagePath: { type: 'string' },
                tokens: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'number' }, completion: { type: 'number' }, total: { type: 'number' } } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `交付报告 · ${value.status === 'done' ? '全部通过' : value.status === 'failed' ? '有未通过项' : value.status}`,
          `run ${value.run_id} · ${value.delivered} 交付 / ${value.blocked} 验收未过 / ${value.failed} 失败 · 返工 ${value.reworks} 次 · 重试 ${value.retries ?? 0} 次 · ${Math.round((value.elapsedMs ?? 0) / 1000)}s`,
          '',
        ]
        for (const task of value.tasks) {
          const verifier = task.verdict === undefined
            ? ''
            : task.verdict === 'pass'
              ? ` ✓验收(${task.reviewBy ?? '—'})`
              : ` ✗验收未过(${task.reviewBy ?? '—'})`
          const rework = task.rework ? ` 返工${task.rework}次` : ''
          const retried = (task.attempts ?? 1) > 1 ? ` 重试${task.attempts - 1}次` : ''
          // Provider is what actually routed; the worker id is only the harness.
          const route = task.model === undefined
            ? (task.worker ?? '—')
            : `${task.provider ?? task.worker ?? '—'}/${task.model}`
          lines.push(`- ${task.subject} [${task.status}] ${route}${verifier}${rework}${retried}${task.durationMs ? ` ${Math.round(task.durationMs / 1000)}s` : ''}`)
          const chain = asArray(task.attemptLog)
          if (chain.length > 1) {
            lines.push('  尝试过：')
            for (const entry of chain) {
              const where = entry.provider === undefined ? '?' : `${entry.provider}/${entry.model ?? '?'}`
              lines.push(`    ${entry.attempt}. ${where} — ${entry.error}`)
            }
          } else if (task.error) {
            lines.push(`  错误：${task.error}`)
          }
        }
        for (const task of value.tasks) {
          if (task.output === undefined || task.output === '') continue
          lines.push(`\n── ${task.subject} ──\n${task.output}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const startedAt = Date.now()
      const run = await engine.createRun({
        goal: args.goal,
        tasks: args.tasks.map((task) => ({ ...task, accept: task.accept === false ? false : true })),
        cwd,
        maxParallel: args.maxParallel,
      })
      await engine.startRun(run)
      if (args.wait !== false) await run.promise
      const tasks = run.tasks.map((task) => ({
        id: task.id, subject: task.subject, status: task.status, worker: task.worker,
        ...(task.provider === undefined ? {} : { provider: task.provider }),
        ...(task.model === undefined ? {} : { model: task.model }),
        ...((task.attempts ?? 1) > 1 ? { attempts: task.attempts } : {}),
        ...(task.attemptLog === undefined ? {} : { attemptLog: task.attemptLog }),
        ...(task.verdict === undefined ? {} : { verdict: task.verdict }),
        ...(task.reviewBy === undefined ? {} : { reviewBy: task.reviewBy }),
        ...(task.rework ? { rework: task.rework } : {}),
        ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
        ...(task.error === undefined ? {} : { error: task.error }),
        ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        ...(task.output === undefined ? {} : { output: clampText(task.output, 4000) }),
      }))
      return plain({
        run_id: run.id,
        status: run.status,
        delivered: run.tasks.filter((task) => task.status === 'done' && task.verdict !== 'block').length,
        blocked: run.tasks.filter((task) => task.verdict === 'block').length,
        failed: run.tasks.filter((task) => task.status === 'failed').length,
        reworks: run.tasks.reduce((total, task) => total + (task.rework ?? 0), 0),
        retries: run.tasks.reduce((total, task) => total + Math.max(0, (task.attempts ?? 1) - 1), 0),
        elapsedMs: Date.now() - startedAt,
        tasks,
      })
    },
  }), 'agent-dispatch.outsource')

  ctx.effect(() => tools.register({
    name: 'outsource_team',
    description: 'Hand a whole goal to a LEADER model and let it run the shop: the leader reads the capability table and the staff roster, splits the goal into a dependency-aware work order, picks which speciality takes each piece, the plugin dispatches and coordinates the group in parallel with cross-model acceptance, and the leader then consolidates one deliverable. Use this when the caller should delegate the planning itself, not just the execution.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'The whole job, in the client\'s words. The leader turns it into a work order.' },
        leader: { type: 'string', description: '"provider/model" of the leading model. Defaults to the configured leader, else the fastest live reasoning route.' },
        maxTasks: { type: 'number', description: 'Cap on how many pieces the leader may split the goal into (default 4, max 8).' },
        maxParallel: { type: 'number', description: 'How many pieces may run at once (capped at 8).' },
        planOnly: { type: 'boolean', description: 'Return the leader\'s work order without dispatching it. Defaults to false.' },
        wait: { type: 'boolean', description: 'Block until the leader has consolidated. Defaults to true.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          run_id: { type: 'string' }, status: { type: 'string' }, leader: { type: 'string' },
          delivered: { type: 'number' }, blocked: { type: 'number' }, failed: { type: 'number' },
          retries: { type: 'number' }, reworks: { type: 'number' }, elapsedMs: { type: 'number' },
          final: { type: 'string' }, note: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, subject: { type: 'string' }, type: { type: 'string' },
                needs: { type: 'array', items: { type: 'string' } },
                dependsOn: { type: 'array', items: { type: 'string' } },
                status: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
                verdict: { type: 'string' }, reviewBy: { type: 'string' }, rework: { type: 'number' },
                attempts: { type: 'number' }, durationMs: { type: 'number' }, error: { type: 'string' }, imagePath: { type: 'string' },
                tokens: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'number' }, completion: { type: 'number' }, total: { type: 'number' } } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `领导 ${value.leader} 组队 · ${value.status}`,
          value.run_id === undefined
            ? '（只出工单，未派发）'
            : `run ${value.run_id} · ${value.delivered} 交付 / ${value.blocked} 验收未过 / ${value.failed} 失败 · 返工 ${value.reworks} 次 · 重试 ${value.retries} 次 · ${Math.round((value.elapsedMs ?? 0) / 1000)}s`,
          '',
          '工单：',
        ]
        for (const task of value.plan) {
          const route = task.model === undefined ? '未派' : `${task.provider ?? '?'}/${task.model}`
          const dep = asArray(task.dependsOn).length > 0 ? ` 依赖 ${task.dependsOn.join(',')}` : ''
          const need = asArray(task.needs).length > 0 ? ` [${task.needs.join(',')}]` : ''
          const verdict = task.verdict === undefined ? '' : task.verdict === 'pass' ? ' ✓验收' : ' ✗驳回'
          lines.push(`- ${task.subject} (${task.type})${need}${dep} → ${route}${verdict}${task.error ? ` — ${task.error}` : ''}`)
        }
        if (value.note) lines.push(`\n领导说明：${value.note}`)
        if (value.final) lines.push(`\n── 最终交付 ──\n${value.final}`)
        return textBlock(lines.join(String.fromCharCode(10)))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const startedAt = Date.now()
      const catalog = await resolveCatalog(ctx)
      const capabilities = await engine.loadCapabilities(cwd)
      const alive = await engine.loadRouteAlive(cwd)
      const health = await engine.loadRouteHealth(cwd)
      const judge = engine.routeHealthJudge(health)

      // The leader is a route like any other, so it obeys the same health and
      // speed rules as the people it manages.
      let leader = parseRouteEntry(asString(args.leader)) ?? parseRouteEntry(engine.config.leader)
      if (leader === undefined) {
        const reasoning = asArray(capabilities.reasoning).map(parseRouteEntry).filter((route) => route !== undefined)
        leader = orderCandidates(reasoning, catalog, engine.config.providerPreference, judge, alive)[0]
      }
      if (leader === undefined) throw new Error('no leader route is available; pass leader as "provider/model"')
      const leaderLabel = `${leader.provider}/${leader.model}`

      const table = Object.entries(capabilities)
        .map(([need, list]) => `${need}: ${asArray(list).map((entry) => (typeof entry === 'string' ? entry : `${entry.provider}/${entry.model}`)).join(', ')}`)
        .join(String.fromCharCode(10)) || '(空)'
      const roster = engine.workers(cwd)
        .map((worker) => `${worker.id}${worker.provider === undefined ? '' : ` → ${worker.provider}/${worker.model}`}${asArray(worker.capabilities).length === 0 ? '' : ` [${worker.capabilities.join(',')}]`}`)
        .join(String.fromCharCode(10)) || '(空)'
      const cap = Number.isFinite(Number(args.maxTasks)) && Number(args.maxTasks) > 0
        ? Math.min(Math.floor(Number(args.maxTasks)), 8)
        : 4

      const planPrompt = [
        '你是一家 AI 外包公司的负责人。把客户的目标拆成一份可执行的工单，交给手下的专长模型去做。',
        '',
        `客户目标：${args.goal}`,
        '',
        '本机的能力表（每一类代表"这类活谁最合适"）：',
        table,
        '',
        '正式工名单（可指定工人 id，也可只写能力类别由系统选人）：',
        roster,
        '',
        `要求：${cap} 件以内，每件必须是能独立完成、能验收的最小工作单元。`,
        '- 有先后依赖的必须写 dependsOn（用本工单内的 id 引用），能并行的不要串起来。',
        '- needs 从能力表里选（如 coding / reasoning / fast / vision / long-context）。',
        '- type 从 implement / review / research / test / docs / image / any 里选。',
        '- acceptCriteria 写清"什么算做完"，验收方会按它判定，不通过会退回重做。',
        '- prompt 必须是自包含的完整指令，执行者看不到你和客户的对话。',
        '',
        '只输出一个 JSON 对象，不要任何解释或代码围栏：',
        '{"tasks":[{"id":"t1","subject":"短标题","type":"implement","needs":["coding"],"dependsOn":[],"prompt":"完整指令","acceptCriteria":"验收标准"}],"note":"一句话说明分工思路"}',
      ].join(String.fromCharCode(10))

      await ctx.logger?.info?.(`agent-dispatch: leader ${leaderLabel} planning "${String(args.goal).slice(0, 60)}"`)
      const planText = await engine.callModel({ prompt: planPrompt, route: leader, cwd, tag: 'leader', signal: exec?.signal })
      const order = parseWorkOrder(planText)
      if (order === undefined || order.tasks.length === 0) {
        throw new Error(`the leader returned no usable work order: ${clampText(planText, 600)}`)
      }

      const ids = new Set()
      const work = []
      for (const raw of order.tasks.slice(0, cap)) {
        if (raw === null || typeof raw !== 'object') continue
        const prompt = asString(raw.prompt)
        if (prompt === undefined) continue
        let id = asString(raw.id, `t${work.length + 1}`)
        while (ids.has(id)) id = `${id}_`
        ids.add(id)
        work.push({
          id,
          subject: asString(raw.subject, id),
          prompt,
          type: asString(raw.type, 'any'),
          needs: asArray(raw.needs).filter((need) => typeof need === 'string'),
          dependsOn: asArray(raw.dependsOn).filter((dep) => typeof dep === 'string' && ids.has(dep)),
          acceptCriteria: asString(raw.acceptCriteria),
        })
      }
      if (work.length === 0) throw new Error('the leader\'s work order had no task with a usable prompt')

      if (args.planOnly === true) {
        return {
          run_id: undefined, status: 'planned', leader: leaderLabel,
          delivered: 0, blocked: 0, failed: 0, retries: 0, reworks: 0,
          elapsedMs: Date.now() - startedAt,
          ...(order.note === undefined ? {} : { note: order.note }),
          plan: work.map((task) => ({
            id: task.id, subject: task.subject, type: task.type,
            needs: task.needs, dependsOn: task.dependsOn, status: 'planned',
          })),
        }
      }

      const run = await engine.createRun({
        goal: String(args.goal),
        tasks: work.map((task) => ({ ...task, accept: true })),
        cwd,
        maxParallel: args.maxParallel,
      })
      await engine.startRun(run)
      if (args.wait !== false) await run.promise

      const delivered = run.tasks.filter((task) => task.status === 'done')
      let final
      if (delivered.length > 0) {
        const digest = delivered
          .map((task) => `## ${task.subject}\n${clampText(task.output ?? '', 6000)}`)
          .join(String.fromCharCode(10) + String.fromCharCode(10))
        const finalPrompt = [
          '你是这家 AI 外包公司的负责人。手下已经交活了，现在由你向客户交付。',
          '',
          `客户目标：${args.goal}`,
          '',
          '各件产出：',
          digest,
          '',
          '把上面整合成一份直接可用的最终交付：不要罗列过程，不要复述工单编号，不要写"以下是"之类的开场。',
          '如果各件之间有冲突或缺口，明确指出。',
        ].join(String.fromCharCode(10))
        try {
          final = await engine.callModel({ prompt: finalPrompt, route: leader, cwd, tag: 'leader-final', signal: exec?.signal })
        } catch (error) {
          final = `（汇总失败：${error instanceof Error ? error.message : String(error)}）`
        }
      }

      return {
        run_id: run.id,
        status: run.status,
        leader: leaderLabel,
        delivered: delivered.length,
        blocked: run.tasks.filter((task) => task.verdict === 'block').length,
        failed: run.tasks.filter((task) => task.status === 'failed').length,
        retries: run.tasks.reduce((total, task) => total + Math.max(0, (task.attempts ?? 1) - 1), 0),
        reworks: run.tasks.reduce((total, task) => total + (task.rework ?? 0), 0),
        elapsedMs: Date.now() - startedAt,
        ...(order.note === undefined ? {} : { note: order.note }),
        ...(final === undefined ? {} : { final }),
        plan: run.tasks.map((task) => ({
          id: task.id, subject: task.subject, type: task.type,
          needs: asArray(task.needs), dependsOn: asArray(task.dependsOn),
          status: task.status,
          ...(task.provider === undefined ? {} : { provider: task.provider }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.verdict === undefined ? {} : { verdict: task.verdict }),
          ...(task.reviewBy === undefined ? {} : { reviewBy: task.reviewBy }),
          ...(task.rework ? { rework: task.rework } : {}),
          ...((task.attempts ?? 1) > 1 ? { attempts: task.attempts } : {}),
          ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
          ...(task.error === undefined ? {} : { error: task.error }),
          ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        })),
      }
    },
  }), 'agent-dispatch.team')

  ctx.effect(() => tools.register({
    name: 'dispatch_status',
    description: 'Read the live state of dispatch runs: per-task status, which worker is on it, how long it took, and any error. Omit run_id for the most recent run.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { run_id: { type: 'string', description: 'Omit to read the most recent run.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          run_id: { type: 'string' }, status: { type: 'string' }, goal: { type: 'string' },
          counts: { type: 'object', additionalProperties: true, properties: {} },
          tasks: {
            type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, subject: { type: 'string' }, status: { type: 'string' },
                worker: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, durationMs: { type: 'number' }, error: { type: 'string' }, imagePath: { type: 'string' },
                tokens: { type: 'object', additionalProperties: false, properties: { prompt: { type: 'number' }, completion: { type: 'number' }, total: { type: 'number' } } },
              },
            },
          },
        },
      },
      render: (_args, value) => textBlock([
        `Run ${value.run_id} — ${value.status} (${value.goal})`,
        ...value.tasks.map((task) => `- ${task.id} [${task.status}] ${task.model === undefined ? (task.worker ?? 'none') : `${task.provider ?? task.worker ?? '?'}/${task.model}`}${task.durationMs ? ` ${Math.round(task.durationMs / 1000)}s` : ''}${task.error ? ` — ${task.error}` : ''}`),
      ].join('\n')),
    },
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const run = engine.pick(args.run_id)
      if (run === undefined) {
        const stored = await engine.storedRuns(cwd)
        const last = stored[stored.length - 1]
        if (last === undefined) throw new Error('no dispatch run has been started in this workspace yet')
        return {
          run_id: last.id, status: last.status, goal: last.goal,
          counts: (last.tasks ?? []).reduce((acc, task) => { acc[task.status] = (acc[task.status] ?? 0) + 1; return acc }, {}),
          tasks: asArray(last.tasks).map((task) => ({
            id: task.id, subject: task.subject, status: task.status, worker: task.worker,
            ...(task.provider === undefined ? {} : { provider: task.provider }),
            ...(task.model === undefined ? {} : { model: task.model }),
            ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
            ...(task.error === undefined ? {} : { error: task.error }),
            ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
          })),
        }
      }
      return {
        run_id: run.id, status: run.status, goal: run.goal,
        counts: engine.summary(run).counts,
        tasks: run.tasks.map((task) => ({
          id: task.id, subject: task.subject, status: task.status, worker: task.worker,
          ...(task.provider === undefined ? {} : { provider: task.provider }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
          ...(task.error === undefined ? {} : { error: task.error }),
          ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        })),
      }
    },
  }), 'agent-dispatch.status')

  ctx.effect(() => tools.register({
    name: 'dispatch_result',
    description: 'Read one task\'s full output and the tail of its log.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        run_id: { type: 'string', description: 'Omit to read the most recent run.' },
        tail: { type: 'number', description: 'Log lines to include, defaults to 80.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          task_id: { type: 'string' }, status: { type: 'string' }, worker: { type: 'string' },
          output: { type: 'string' }, error: { type: 'string' }, log: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock([
        `${value.task_id} [${value.status}] worker=${value.worker ?? 'none'}`,
        value.error ? `error: ${value.error}` : '',
        value.output ? `\n── output ──\n${value.output}` : '',
        value.log ? `\n── log tail ──\n${value.log}` : '',
      ].filter(Boolean).join('\n')),
    },
    async execute(args) {
      const run = engine.pick(args.run_id) ?? engine.pick()
      if (run === undefined) throw new Error('no dispatch run is available in this process')
      const task = run.tasks.find((entry) => entry.id === args.task_id)
      if (task === undefined) throw new Error(`run ${run.id} has no task "${args.task_id}"`)
      const lines = Number.isFinite(Number(args.tail)) && Number(args.tail) > 0 ? Math.floor(Number(args.tail)) : 80
      return {
        task_id: task.id, status: task.status, worker: task.worker,
        ...(task.output === undefined ? {} : { output: clampText(task.output) }),
        ...(task.error === undefined ? {} : { error: task.error }),
        ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
        log: await engine.logTail(run, task.id, lines),
      }
    },
  }), 'agent-dispatch.result')

  ctx.effect(() => tools.register({
    name: 'dispatch_cancel',
    description: 'Cancel a running dispatch: queued tasks stop, running workers are aborted, and settled tasks keep their results.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { run_id: { type: 'string', description: 'Omit to cancel every running dispatch.' } },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { cancelled: { type: 'array', items: { type: 'string' } } },
      },
      render: (_args, value) => textBlock(value.cancelled.length === 0 ? 'Nothing was running.' : `Cancelled: ${value.cancelled.join(', ')}`),
    },
    async execute(args) {
      const targets = args.run_id === undefined ? [...engine.controllers.keys()] : [args.run_id]
      const cancelled = targets.filter((id) => engine.cancel(id))
      return { cancelled }
    },
  }), 'agent-dispatch.cancel')
}

/**
 * Read a scout's capability table without trusting its formatting: models wrap
 * JSON in prose and code fences, so take the outermost object.
 */
function parseCapabilityTable(text) {
  const withoutFences = String(text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    const value = JSON.parse(withoutFences.slice(start, end + 1))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Read an acceptance verdict without trusting the reviewer's formatting.
 *
 * Models routinely wrap a JSON answer in prose or code fences and, worse,
 * sometimes echo the instruction they were given. A brittle "the first line
 * must be PASS" rule therefore rejects good work and feeds the instruction
 * itself back as rework feedback — which is exactly what happened in the first
 * real outsourcing run. JSON first, keyword scan second, fail-open last: a
 * garbled reviewer must never turn a good deliverable into a failed job.
 */
function parseVerdict(text) {
  const raw = String(text ?? '')
  const withoutFences = raw.replace(/```(?:json)?/gi, '').trim()
  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const value = JSON.parse(withoutFences.slice(start, end + 1))
      const verdict = String(value?.verdict ?? '').trim().toLowerCase()
      const issues = Array.isArray(value?.issues)
        ? value.issues.filter((issue) => typeof issue === 'string' && issue.trim() !== '').map((issue) => issue.trim())
        : []
      if (verdict === 'pass') return { pass: true, issues: [] }
      if (verdict === 'block') {
        return { pass: false, issues: issues.length > 0 ? issues : ['验收方判定不通过但没有给出具体问题'] }
      }
    } catch {
      /* fall through to the keyword scan */
    }
  }
  if (/(^|\n)\s*(BLOCK|阻断|不通过|未通过|不满足|未满足)\b|不通过|未通过|阻断|不满足|未满足/i.test(withoutFences)) {
    return { pass: false, issues: [withoutFences.split('\n').slice(0, 8).join('\n')] }
  }
  if (/\bPASS\b|通过|满足/i.test(withoutFences)) return { pass: true, issues: [] }
  return { pass: true, issues: [], unparsed: withoutFences.slice(0, 240) }
}

/** The effective working directory of the agent that called the tool. */function agentCwd(exec, ctx) {
  const session = exec?.agent?.session
  const direct = session?.header?.cwd
  if (typeof direct === 'string' && direct !== '') return direct
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && session !== undefined) return workingDirectory.get(session)
  } catch {
    /* fall through to the process directory */
  }
  return undefined
}

/**
 * The key for one http worker. The credentials service is the authority: a
 * value the user stored through the settings page takes precedence over the
 * process environment, and re-resolving per call means a saved key reaches the
 * next request without a restart.
 */
async function resolveWorkerKey(ctx, worker) {
  const name = worker.apiKeyEnv
  if (name === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(name)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
    } catch {
      /* an unreadable store falls back to the environment below */
    }
  }
  const fromEnv = process.env[name]
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : undefined
}

/** Describe a worker's key for a configuration surface, never exposing it. */
async function describeWorkerKey(ctx, worker) {
  const name = worker.apiKeyEnv
  if (name === undefined) return { envName: undefined, configured: false, writable: false }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const info = await credentials.describe(name)
      return {
        envName: name,
        configured: info?.configured === true,
        ...(typeof info?.source === 'string' ? { source: info.source } : {}),
        writable: info?.writable === true,
      }
    } catch {
      /* fall through to the environment */
    }
  }
  const fromEnv = process.env[name]
  return {
    envName: name,
    configured: typeof fromEnv === 'string' && fromEnv !== '',
    source: 'env',
    writable: false,
  }
}

async function findExecutable(command) {
  const { execFile } = await import('node:child_process')
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return await new Promise((done) => {
    execFile(probe, [command], { timeout: 5000 }, (error, stdout) => {
      if (error) return done(undefined)
      const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (process.platform !== 'win32') return done(lines[0])
      // npm installs an extensionless POSIX shim beside the real Windows
      // launchers, and spawn() without a shell cannot start that shim.
      for (const pattern of ['\\.cmd$', '\\.exe$', '\\.bat$', '\\.ps1$']) {
        const hit = lines.find((line) => new RegExp(pattern, "i").test(line))
        if (hit !== undefined) return done(hit)
      }
      done(lines[0])
    })
  })
}

/** The path to actually spawn: on Windows that must be a launcher, not a shim. */
/**
 * How to start a CLI worker. On Windows an npm global install is a .cmd shim,
 * and spawn() cannot execute a batch file with shell:false. Two shapes work:
 * run the shim through cmd.exe, or — better — skip the shim and start node on
 * the package entry the shim points at.
 */
async function spawnTarget(command) {
  if (process.platform !== 'win32') return { file: command, prefix: [] }
  const resolved = /[\\/]/.test(command) || /\.[a-z0-9]{2,4}$/i.test(command)
    ? command
    : (await findExecutable(command)) ?? command
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, prefix: [] }
  try {
    const { readFile, access } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const script = await readFile(resolved, 'utf8')
    const match = script.match(/(node_modules[\\/][^"'\s]+)/)
    if (match !== null) {
      const entry = join(dirname(resolved), match[1].replace(/^["']|["']$/g, ''))
      await access(entry)
      return { file: process.execPath, prefix: [entry] }
    }
  } catch {
    /* fall through to cmd.exe */
  }
  return { file: process.env.ComSpec ?? 'cmd.exe', prefix: ['/d', '/s', '/c', resolved] }
}

/**
 * A tool result must survive the host's strict JSON boundary. Errors, NaN,
 * undefined and class instances all fail there, so the payload is flattened to
 * plainly serialisable data before it leaves a tool.
 */
function plain(value, depth = 0) {
  if (depth > 6) return undefined
  if (value === null || value === undefined) return value === null ? null : undefined
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Error) return value.message
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1)).filter((item) => item !== undefined)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const converted = plain(item, depth + 1)
      if (converted !== undefined) out[key] = converted
    }
    return out
  }
  return String(value)
}

/* ────────────────────────────── capability catalog ────────────────────────────── */

/**
 * Every model route this Host can actually reach, read from the live LLM
 * adapter registry. This is what makes routing capability-based instead of
 * name-based: a task that needs to read an image goes to a model whose
 * `inputModalities` include `image`, wherever that model happens to live.
 *
 * The catalog is cached briefly because listing models hits provider APIs.
 */
const CATALOG_TTL_MS = 60_000
const catalogCache = new WeakMap()

async function resolveCatalog(ctx, { force = false } = {}) {
  const cached = catalogCache.get(ctx)
  if (!force && cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
  const llm = ctx.get('llm')
  if (llm === undefined) {
    const value = { available: false, error: 'the llm service is not mounted in this profile', providers: [], routes: [] }
    catalogCache.set(ctx, { at: Date.now(), value })
    return value
  }
  let providers = []
  try {
    providers = llm.listProviders?.() ?? []
  } catch (error) {
    const value = { available: false, error: `listProviders failed: ${String(error?.message ?? error)}`, providers: [], routes: [] }
    catalogCache.set(ctx, { at: Date.now(), value })
    return value
  }
  const routes = []
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of asArray(models)) {
        const modalities = Array.isArray(model.inputModalities) && model.inputModalities.length > 0 ? [...model.inputModalities] : ['text']
        routes.push({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          name: model.name ?? model.id,
          modalities,
          vision: modalities.includes('image'),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        })
      }
    } catch (error) {
      routes.push({
        provider: provider.id,
        providerName: provider.name,
        model: '(catalog unavailable)',
        name: '(catalog unavailable)',
        modalities: [],
        vision: false,
        error: String(error?.message ?? error),
      })
    }
  }
  const value = { available: true, providers: providers.map((p) => ({ id: p.id, name: p.name })), routes }
  catalogCache.set(ctx, { at: Date.now(), value })
  return value
}

/**
 * Reduce a model id to the identity of its weights.
 *
 * Providers decorate the same model differently — `z-ai/glm-5.3` on an
 * aggregator, `GLM-5.3` on the vendor endpoint, `glm-5.3-flash-free` on a trial
 * route. Comparing raw strings calls those "different models", which quietly
 * turns a self-review into an apparent second opinion.
 */
function modelKey(model) {
  if (typeof model !== 'string') return ''
  let key = model.toLowerCase().trim()
  const slash = key.lastIndexOf('/')
  if (slash !== -1) key = key.slice(slash + 1)
  key = key.replace(/[-_.](free|trial|preview|latest|beta|alpha)$/g, '')
  key = key.replace(/[_:\s]+/g, '-')
  return key
}

/** The family a model belongs to: `glm-5.3` and `glm-5.3-flash` are the same shop. */
function modelFamily(model) {
  const key = modelKey(model)
  const head = key.split('-')[0]
  return head === '' ? key : head
}

/** Normalise one capability-table entry into a concrete route. */
function parseRouteEntry(entry) {
  if (typeof entry === 'string' && entry.includes('/')) {
    const slash = entry.indexOf('/')
    return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) }
  }
  if (entry !== null && typeof entry === 'object' && typeof entry.provider === 'string' && typeof entry.model === 'string') {
    return { provider: entry.provider, model: entry.model }
  }
  return undefined
}

/**
 * Order the routes a task may try, mixing the capability table's picks with the
 * rest of the live catalog into ONE ranking.
 *
 * Ranking, in order: not-recently-failed, then not-de-prioritised, then the
 * oldest failure first (a route that failed an hour ago is likelier to have
 * recovered than one that failed a second ago). Merging the catalog in is what
 * keeps a dead shortlist from stranding a job: a never-tried spare outranks a
 * candidate that just failed.
 */
/**
 * How long a failure should be remembered depends on what went wrong.
 * An expired key or a disabled account stays broken until a human fixes it;
 * a concurrency cap or a timeout passes on its own. Forgetting both after ten
 * minutes means re-walking into dead providers on every job.
 */
/**
 * An HTTP failure carries its own verdict: a refused key or a missing quota will
 * not change on the next attempt, so it must not be retried as if it were a
 * hiccup.
 */
function httpFailure(url, status, body) {
  const message = `HTTP ${status} from ${url}${body === '' ? '' : `: ${body.slice(0, 300)}`}`
  return classifyFailure(message) === 'permanent' ? permanent(message) : new Error(message)
}

function classifyFailure(message) {
  const text = String(message ?? '')
  // A refusal that will not change by waiting: bad key, no permission, no
  // quota, wrong model. Retrying these only burns time and the caller's quota.
  if (/api key[^a-z]*invalid|authentication fails|账号已被禁用|未配置凭据|no usable credential|unauthori[sz]ed|forbidden|permission_error|no free trial quota|billing is not enabled|insufficient_quota|no adapter registered|unknown model|not ?found|does not exist|无效|已禁用|无权限|未开通|欠费/i.test(text)) {
    return 'permanent'
  }
  if (/HTTP (401|402|403|404)/.test(text)) return 'permanent'
  return 'transient'
}

/** TTL applied to one health entry, by the kind of failure it records. */
function healthTtlFor(entry, transientTtlMs, permanentTtlMs) {
  return entry?.kind === 'permanent' ? permanentTtlMs : transientTtlMs
}

function orderCandidates(candidates, catalog, preference, isDead, alive) {
  const lastProviders = new Set(asArray(preference?.last).filter((id) => typeof id === 'string'))
  const HISTORY = 3600_000
  const describe = (route) => {
    const entry = isDead?.entryFor?.(route)
    const at = entry === undefined ? 0 : Number(entry.at) || 0
    const dead = isDead?.isDead?.(route) === true
    const record = alive?.[`${route.provider}/${route.model}`]
    // Speed only counts while the measurement is fresh, and a dead route is
    // never preferred for being quick.
    const fresh = record !== undefined && Number(record.at) > Date.now() - HISTORY
    const latency = fresh && dead === false ? Math.max(1, Number(record.latencyMs) || 999_999) : 999_999
    return {
      route,
      dead: dead ? 1 : 0,
      hot: isDead?.isProviderHot?.(route.provider) === true ? 1 : 0,
      last: lastProviders.has(route.provider) ? 1 : 0,
      latency,
      at: dead ? at : 0,
    }
  }
  const rank = (a, b) => (a.dead - b.dead) || (a.hot - b.hot) || (a.last - b.last) || (a.latency - b.latency) || (a.at - b.at)

  const seen = new Set()
  const declared = []
  for (const candidate of asArray(candidates)) {
    if (candidate === undefined || candidate === null) continue
    const provider = candidate.provider
    const model = candidate.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    declared.push(describe({ provider, model }))
  }

  const spare = []
  for (const candidate of asArray(catalog?.routes)) {
    if (candidate === undefined || candidate === null) continue
    if (candidate.error !== undefined || candidate.model === '(catalog unavailable)') continue
    const provider = candidate.provider
    const model = candidate.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    spare.push(describe({ provider, model }))
  }

  // The capability list is a judgement about WHICH MODEL SUITS THIS CLASS; the
  // catalog is only a safety net. Ranking them in one pool let a single route
  // that merely probed fast win every class, which erased the judgement. So the
  // declared candidates stay ahead of the spares, and the spares are reached
  // only when the declared ones are all dead.
  declared.sort(rank)
  spare.sort(rank)
  const liveDeclared = declared.filter((entry) => entry.dead === 0)
  const ordered = liveDeclared.length > 0
    ? [...liveDeclared, ...declared.filter((entry) => entry.dead === 1), ...spare]
    : [...spare, ...declared]
  return ordered.slice(0, MAX_ROUTE_CANDIDATES).map((entry) => entry.route)
}

/**
 * Read a leader's work order. Models wrap JSON in prose and fences, and a plan
 * that cannot be read is worse than no plan, so the outermost object wins.
 */
function parseWorkOrder(text) {
  const withoutFences = String(text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const value = JSON.parse(withoutFences.slice(start, end + 1))
    return {
      tasks: Array.isArray(value?.tasks) ? value.tasks : [],
      note: typeof value?.note === 'string' ? value.note : undefined,
    }
  } catch {
    return undefined
  }
}

function routeForNeeds(catalog, needs, capabilities) {
  if (!Array.isArray(needs) || needs.length === 0) return undefined
  // A named capability class is the strongest signal: it encodes "who is good at
  // this", which the model catalog cannot know. The WHOLE ordered list travels
  // with the decision, because a table says "these are the good ones", not
  // "this one's key is still valid today".
  if (capabilities !== undefined && typeof capabilities === 'object') {
    for (const need of needs) {
      const candidates = asArray(capabilities[need]).map(parseRouteEntry).filter((route) => route !== undefined)
      if (candidates.length > 0) {
        return { ...candidates[0], reason: `capability ${need}`, candidates }
      }
    }
  }
  if (needs.includes('vision') || needs.includes('image')) {
    const route = catalog.routes.find((entry) => entry.vision === true)
    if (route !== undefined) {
      return { provider: route.provider, model: route.model, reason: 'vision modality', candidates: [{ provider: route.provider, model: route.model }] }
    }
  }
  if (needs.includes('long-context')) {
    const route = [...catalog.routes]
      .filter((entry) => typeof entry.contextWindow === 'number')
      .sort((a, b) => b.contextWindow - a.contextWindow)[0]
    if (route !== undefined) {
      return { provider: route.provider, model: route.model, reason: 'largest context window', candidates: [{ provider: route.provider, model: route.model }] }
    }
  }
  return undefined
}

/* ────────────────────────────── HTTP surface ────────────────────────────── */

/**
 * The board's worker roster: who is on staff right now, what each is bound to,
 * and whether that route is answering. `status` comes from real probe evidence,
 * never from the catalog alone, so a dead key shows up as dead.
 */
async function rosterFor(engine, ctx, cwds) {
  const cwd = cwds[0] ?? process.cwd()
  let health = {}
  let alive = {}
  try { health = await engine.loadRouteHealth(cwd) } catch { /* unknown */ }
  try { alive = await engine.loadRouteAlive(cwd) } catch { /* unknown */ }
  const judge = engine.routeHealthJudge(health)
  let hostDefault
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider !== undefined && selection?.model !== undefined) {
      hostDefault = { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* a profile without a default model simply has no Host route to report */
  }
  const roster = engine.workers(cwd).map((worker) => {
    const pinned = worker.provider !== undefined && worker.model !== undefined
    const route = pinned
      ? { provider: worker.provider, model: worker.model }
      : worker.kind === 'dsh' ? hostDefault : undefined
    if (route === undefined) {
      return {
        id: worker.id,
        label: worker.label ?? worker.id,
        kind: worker.kind,
        status: 'unknown',
        pinned: false,
        capabilities: worker.capabilities ?? [],
      }
    }
    const key = `${route.provider}/${route.model}`
    const record = alive[key]
    const status = judge.isDead(route) ? 'dead' : record !== undefined ? 'alive' : 'unknown'
    const failure = health[key]
    return {
      id: worker.id,
      label: worker.label ?? worker.id,
      kind: worker.kind,
      provider: route.provider,
      model: route.model,
      status,
      // Red means "cannot work": say whether that is a quota/account problem or
      // a transient throttle, because the fix is different.
      ...(status === 'dead' ? { failKind: failure?.kind ?? 'transient' } : {}),
      pinned,
      ...(record?.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
      ...(status === 'dead' && health[key]?.reason !== undefined ? { detail: String(health[key].reason).slice(0, 140) } : {}),
      capabilities: worker.capabilities ?? [],
    }
  })
  return roster
}

/**
 * The contract bench: models that actually took work but are not one of the
 * declared staff. They persist while idle — a firm keeps its subcontractor list
 * between jobs — and show as working while a task is live.
 */
async function contractorsFor(engine, ctx, cwds, staffRoutes) {
  const bench = new Map()
  const note = (run, live) => {
    for (const task of asArray(run?.tasks)) {
      if (typeof task.provider !== 'string' || typeof task.model !== 'string') continue
      const key = `${task.provider}/${task.model}`
      if (staffRoutes.has(key)) continue
      const entry = bench.get(key) ?? {
        id: key,
        provider: task.provider,
        model: task.model,
        tasks: 0,
        working: false,
        failed: false,
        lastUsedAt: 0,
      }
      if (task.status === 'failed') entry.failed = true
      if (task.status === 'done') entry.failed = false
      entry.tasks += 1
      const at = Date.parse(task.endedAt ?? task.startedAt ?? run.updatedAt ?? '') || 0
      if (at > entry.lastUsedAt) {
        entry.lastUsedAt = at
        entry.failed = task.status === 'failed'
      }
      if (live && task.status === 'running') entry.working = true
      bench.set(key, entry)
    }
  }
  for (const cwd of cwds) {
    for (const run of await engine.storedRuns(cwd)) note(run, false)
  }
  for (const run of engine.runs.values()) note(run, true)
  return [...bench.values()].sort((a, b) =>
    (b.working ? 1 : 0) - (a.working ? 1 : 0) || (b.lastUsedAt - a.lastUsedAt))
}

/** A stable signature of the roster, so the board can tell when it changed. */
function rosterRevision(roster) {
  return roster.map((worker) => `${worker.id}:${worker.provider ?? ''}/${worker.model ?? ''}:${worker.status}`).join('|')
}

function registerWebRoutes(ctx, engine) {
  const server = ctx.get('webServer')
  if (server === undefined) return
  const connection = () => {
    try { return ctx.get('connection') } catch { return undefined }
  }

  const guard = (handler) => async (req, res) => {
    const gate = connection()
    const rejection = gate === undefined ? undefined : gate.requestRejection?.(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  /** Read a small JSON body; a configuration form never sends more than a key. */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += part.length
      if (size > 64_000) throw new Error('request body too large')
      chunks.push(part)
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw === '') return {}
    try {
      const value = JSON.parse(raw)
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  // Adopt local agents at startup and keep the list warm; a closed desktop app
  // never appears here, but a gateway or CLI does as soon as it is installed.
  ctx.effect(() => {
    void engine.refreshLocalWorkers().catch(() => [])
    const timer = setInterval(() => { void engine.refreshLocalWorkers().catch(() => []) }, 5 * 60_000)
    return () => clearInterval(timer)
  })

  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/agent-dispatch/state',
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const explicit = url.searchParams.get('cwd')
      // The board does not know a session's directory, and a run is stored per
      // workspace, so gather every directory this process can legitimately name.
      const cwds = new Set()
      if (explicit !== null) cwds.add(explicit)
      for (const run of engine.runs.values()) if (run.cwd) cwds.add(run.cwd)
      try {
        const registry = ctx.get('agents')
        for (const agent of registry?.list?.() ?? []) {
          const cwd = agent?.session?.header?.cwd
          if (typeof cwd === 'string' && cwd !== '') cwds.add(cwd)
        }
      } catch {
        /* a profile without the agent registry still reports live runs */
      }
      const merged = new Map()
      for (const cwd of cwds) {
        for (const run of await engine.storedRuns(cwd)) if (run?.id) merged.set(run.id, run)
      }
      for (const run of engine.runs.values()) merged.set(run.id, engine.view(run))
      const roster = await rosterFor(engine, ctx, [...cwds])
      const staffRoutes = new Set(roster
        .filter((worker) => worker.provider !== undefined && worker.model !== undefined)
        .map((worker) => `${worker.provider}/${worker.model}`))
      const contractors = await contractorsFor(engine, ctx, [...cwds], staffRoutes)
      json(res, {
        version: STATE_VERSION,
        runs: [...merged.values()].slice(-MAX_KEPT_RUNS).reverse(),
        defaultTimeoutMs: engine.timeoutMs(),
        workers: roster,
        contractors,
        rosterRevision: `${rosterRevision(roster)}::${contractors.map((c) => `${c.id}${c.working ? '!' : ''}`).join(',')}`,
      })
    }),
  }), 'agent-dispatch.route.state')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: '/api/agent-dispatch/log',
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const run = engine.pick(url.searchParams.get('run') ?? undefined)
      const taskId = url.searchParams.get('task') ?? ''
      const lines = Number(url.searchParams.get('tail') ?? '120')
      const text = run === undefined ? '' : await engine.logTail(run, taskId, Number.isFinite(lines) ? lines : 120)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }),
  }), 'agent-dispatch.route.log')

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
        await engine.refreshWorkerOverrides(process.cwd())
        const worker = httpWorkersFor().find((entry) => entry.id === workerId)
        if (worker === undefined) return json(res, { ok: false, error: `unknown worker "${workerId}"` }, 400)

        // A model id can be changed without touching cordis.patch.yml, which is
        // how an Ark endpoint id (`ep-...`) gets wired in.
        if (typeof body.model === 'string' && body.model.trim() !== '') {
          await engine.saveWorkerOverride(process.cwd(), workerId, { model: body.model.trim() })
          const updated = httpWorkersFor().find((entry) => entry.id === workerId)
          return json(res, { ok: true, workerId, model: updated?.model })
        }

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
      await engine.refreshWorkerOverrides(process.cwd())
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
      await engine.refreshWorkerOverrides(process.cwd())
      const worker = httpWorkersFor().find((entry) => entry.id === workerId)
      if (worker === undefined) return json(res, { ok: false, error: `unknown worker "${workerId}"` }, 400)
      const key = await resolveWorkerKey(ctx, worker)
      if (key === undefined) return json(res, { ok: false, error: 'no key configured' })
      const baseUrl = worker.baseUrl
      if (baseUrl === undefined) return json(res, { ok: false, error: 'no baseUrl' })
      const root = baseUrl.replace(/[/]+$/, '')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`${root}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: controller.signal,
        })
        const text = await response.text().catch(() => '')
        if (!response.ok) {
          return json(res, { ok: false, status: response.status, error: `HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}` })
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
  }), 'agent-dispatch.route.keys-test')
}

/* ────────────────────────────── plugin entry ────────────────────────────── */

export function apply(ctx, config) {
  const engine = new DispatchEngine(ctx, config)
  engine.pick = (runId) => {
    if (runId !== undefined) return engine.runs.get(runId)
    const all = [...engine.runs.values()]
    return all[all.length - 1]
  }
  engine.cwdHint = () => process.cwd()

  registerTools(ctx, engine)
  registerWebRoutes(ctx, engine)

  // A cancelled dispatch must not leave a child agent spinning after unload.
  ctx.effect(() => () => {
    for (const [id] of engine.controllers) engine.cancel(id)
  }, 'agent-dispatch.teardown')

  // Exposed for tests and for a host that wants to drive discovery directly.
  return { engine, refreshLocalWorkers: () => engine.refreshLocalWorkers() }
}
