/**
 * dsh-agent-dispatch — Client half.
 *
 * Registers one right-sidebar tab type and renders the live dispatch board:
 * which worker holds which task, how long it has been running, and the output.
 *
 * The module is a lazy factory in the browser module table; React comes from
 * that table, and no Host package is imported as a module.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-dispatch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const TAB_KIND = 'agent-dispatch'
    const TAB_ID = 'dsh-agent-dispatch/board'
    const STATE_URL = '/api/agent-dispatch/state'
    const LOG_URL = '/api/agent-dispatch/log'
    const POLL_MS = 2000
    const POLL_HIDDEN_MS = 8000

    /* ── data ── */

    async function getJson(url, signal) {
      const response = await fetch(url, { cache: 'no-store', signal })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    }

    async function getText(url, signal) {
      const response = await fetch(url, { cache: 'no-store', signal })
      if (!response.ok) return ''
      return await response.text()
    }

    /* ── formatting ── */

    const STATUS_TEXT = {
      running: '执行中',
      done: '完成',
      failed: '失败',
      cancelled: '已取消',
      skipped: '已跳过',
      pending: '等待',
      blocked: '受阻',
    }

    /**
     * The board's colour vocabulary, in one table so it stays consistent:
     *   green  = working normally      grey = idle / standby / not yet probed
     *   blue   = on a job right now    red  = cannot work (quota, account, outage)
     */
    const TONE = {
      alive: { color: 'var(--dsw-alias-state-success-primary)', label: '正常' },
      working: { color: 'var(--dsw-alias-brand-primary)', label: '干活中' },
      idle: { color: 'var(--dsw-alias-state-idle-primary)', label: '待机' },
      unknown: { color: 'var(--dsw-alias-state-idle-primary)', label: '未探' },
      quota: { color: 'var(--dsw-alias-state-error-primary)', label: '无额度' },
      outage: { color: 'var(--dsw-alias-state-error-primary)', label: '故障' },
    }

    function statusColor(status) {
      if (status === 'done') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'failed') return 'var(--dsw-alias-state-error-primary)'
      if (status === 'running') return 'var(--dsw-alias-brand-primary)'
      if (status === 'skipped' || status === 'cancelled') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    function staffTone(worker) {
      if (worker.status === 'alive') return TONE.alive
      if (worker.status === 'dead') return worker.failKind === 'permanent' ? TONE.quota : TONE.outage
      return TONE.unknown
    }

    function benchTone(contractor) {
      if (contractor.working) return TONE.working
      if (contractor.failed) return TONE.outage
      return TONE.idle
    }

    function Legend() {
      const items = [TONE.alive, TONE.working, TONE.idle, TONE.outage]
      return h('div', { className: 'ad-legend' }, items.map((tone, index) => h('span', { className: 'ad-legend-item', key: index },
        h('span', { className: 'ad-dot', style: { background: tone.color } }),
        tone.label,
      )))
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 1000) return `${ms}ms`
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
      const minutes = Math.floor(ms / 60_000)
      const seconds = Math.round((ms % 60_000) / 1000)
      return `${minutes}m${seconds.toString().padStart(2, '0')}s`
    }

    /** Providers namespace their model ids; the chip only needs the tail. */
    function shortModel(model) {
      if (typeof model !== 'string') return ''
      const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
      return tail.length > 18 ? `${tail.slice(0, 17)}…` : tail
    }

    function elapsedOf(task) {      if (task.status === 'running' && task.startedAt) {
        return Date.now() - Date.parse(task.startedAt)
      }
      return task.durationMs
    }

    /* ── styles ── */

    const CSS = `
.ad-root { display:flex; flex-direction:column; gap:10px; padding:12px; box-sizing:border-box; height:100%; overflow:auto; color:var(--dsw-alias-label-primary); font-size:13px; }
.ad-head { display:flex; align-items:center; gap:8px; }
.ad-title { font-weight:600; font-size:13px; letter-spacing:.01em; }
.ad-count { color:var(--dsw-alias-label-secondary); font-size:11px; margin-left:auto; }
.ad-refresh { appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); border-radius:6px; padding:2px 8px; font-size:11px; cursor:pointer; line-height:18px; }
.ad-refresh:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }
.ad-select { width:100%; box-sizing:border-box; appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 8px; font-size:12px; }
.ad-progress { height:4px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; display:flex; }
.ad-progress > i { display:block; height:100%; }
.ad-goal { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; word-break:break-word; }
.ad-tasks { display:flex; flex-direction:column; gap:4px; }
.ad-task { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.ad-task-row { display:flex; align-items:center; gap:8px; padding:7px 9px; cursor:pointer; }
.ad-task-row:hover { background:var(--dsw-alias-bg-layer-2); }
.ad-dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
.ad-dot-run { animation:ad-pulse 1.1s ease-in-out infinite; }
@keyframes ad-pulse { 0%,100% { opacity:1 } 50% { opacity:.25 } }
.ad-subject { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
.ad-chip { flex:0 0 auto; font-size:10.5px; padding:1px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); }
.ad-meta { flex:0 0 auto; font-size:10.5px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.ad-chip-model { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); background:transparent; opacity:.85; }
.ad-staff { display:flex; flex-direction:column; gap:3px; padding:8px 9px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
.ad-keys { display:flex; flex-direction:column; gap:10px; padding:14px; font-size:13px; color:var(--dsw-alias-label-primary); }
.ad-key-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); padding:10px; display:flex; flex-direction:column; gap:6px; }
.ad-key-head { display:flex; align-items:center; gap:8px; }
.ad-key-row { display:flex; align-items:center; gap:6px; }
.ad-key-input { flex:1 1 auto; min-width:0; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 8px; font-size:12px; }
.ad-key-input:disabled { opacity:.55; }
.ad-roster { display:flex; flex-direction:column; gap:6px; margin-top:4px; }
.ad-section { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.ad-section-head { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box; background:transparent; border:0; padding:6px 9px; cursor:pointer; text-align:left; color:var(--dsw-alias-label-primary); font-size:11.5px; }
.ad-section-head:hover { background:var(--dsw-alias-bg-layer-2); }
.ad-caret { flex:0 0 auto; width:10px; color:var(--dsw-alias-label-secondary); font-size:10px; }
.ad-section-title { flex:1 1 auto; font-weight:600; }
.ad-section-body { padding:2px 9px 8px; border-top:1px solid var(--dsw-alias-border-l1); }
.ad-legend { display:flex; flex-wrap:wrap; gap:10px; padding:2px 4px 4px; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.ad-legend-item { display:inline-flex; align-items:center; gap:4px; }
.ad-worker { display:flex; align-items:center; gap:8px; padding:3px 4px; border-radius:5px; font-size:11.5px; }
.ad-worker-id { flex:0 0 auto; min-width:56px; color:var(--dsw-alias-label-primary); }
.ad-worker-route { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; }
.ad-worker-out { margin-left:10px; padding-left:7px; border-left:2px solid var(--dsw-alias-border-l1); }
.ad-worker-changed { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.ad-chip-pass { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); background:transparent; }
.ad-chip-block { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); background:transparent; }
.ad-body { padding:0 9px 9px; border-top:1px solid var(--dsw-alias-border-l1); }
.ad-label { font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--dsw-alias-label-secondary); margin:8px 0 4px; }
.ad-pre { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); font-size:11.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.ad-error { color:var(--dsw-alias-state-error-primary); font-size:11.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.ad-empty { border:1px dashed var(--dsw-alias-border-l1); border-radius:8px; padding:14px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; }
.ad-empty b { color:var(--dsw-alias-label-primary); font-weight:600; }
.ad-warn { color:var(--dsw-alias-state-warn-primary); font-size:11.5px; }
`

    /* ── board ── */

    function Board() {
      const [data, setData] = useState({ runs: [], workers: [], contractors: [], loading: true, error: null })
      const prevRoster = useRef(new Map())
      const [changed, setChanged] = useState(() => new Set())
      // The roster is reference information; the work is what the user watches.
      // Both sections start collapsed and expand on click.
      const [openSections, setOpenSections] = useState({ staff: false, bench: false })
      const toggleSection = useCallback((key) => {
        setOpenSections((current) => ({ ...current, [key]: !current[key] }))
      }, [])
      const [selectedId, setSelectedId] = useState(null)
      const [expanded, setExpanded] = useState(null)
      const [logs, setLogs] = useState({})
      const [nonce, setNonce] = useState(0)

      const load = useCallback(async (signal) => {
        const next = await getJson(STATE_URL, signal)
        setData({
          runs: Array.isArray(next.runs) ? next.runs : [],
          workers: Array.isArray(next.workers) ? next.workers : [],
          contractors: Array.isArray(next.contractors) ? next.contractors : [],
          rosterRevision: next.rosterRevision,
          loading: false,
          error: null,
        })
      }, [])

      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        let timer
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            timer = setTimeout(tick, POLL_HIDDEN_MS)
            return
          }
          try {
            await load(controller.signal)
          } catch (error) {
            if (alive && error?.name !== 'AbortError') {
              setData((current) => ({ ...current, loading: false, error: String(error?.message ?? error) }))
            }
          }
          if (alive) timer = setTimeout(tick, POLL_MS)
        }
        tick()
        return () => {
          alive = false
          clearTimeout(timer)
          controller.abort()
        }
      }, [load, nonce])

      const workers = data.workers
      const contractors = data.contractors

      // A worker that appears, disappears, changes route, or flips alive/dead
      // must be visible here: that is the whole point of showing the roster.
      useEffect(() => {
        const next = new Map()
        for (const worker of workers) {
          next.set(`staff:${worker.id}`, `${worker.provider ?? ''}/${worker.model ?? ''}|${worker.status}`)
        }
        for (const contractor of contractors) {
          next.set(`bench:${contractor.id}`, contractor.working ? 'working' : 'idle')
        }
        const touched = new Set()
        for (const [id, signature] of next) {
          if (!prevRoster.current.has(id) || prevRoster.current.get(id) !== signature) touched.add(id)
        }
        for (const id of prevRoster.current.keys()) if (!next.has(id)) touched.add(id)
        prevRoster.current = next
        if (touched.size === 0) return undefined
        setChanged(touched)
        const timer = setTimeout(() => setChanged(new Set()), 8000)
        return () => clearTimeout(timer)
      }, [data.rosterRevision])

      const runs = data.runs
      const selected = useMemo(() => {
        if (runs.length === 0) return undefined
        return runs.find((run) => run.id === selectedId) ?? runs[0]
      }, [runs, selectedId])

      const activeTaskId = expanded

      // Keep the open task's log tail fresh while its run is live.
      useEffect(() => {
        if (selected === undefined || activeTaskId === null) return
        let alive = true
        const timer = setInterval(async () => {
          try {
            const text = await getText(`${LOG_URL}?run=${encodeURIComponent(selected.id)}&task=${encodeURIComponent(activeTaskId)}&tail=120`)
            if (alive) setLogs((current) => ({ ...current, [activeTaskId]: text }))
          } catch {
            /* a missing log is simply empty */
          }
        }, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [selected, activeTaskId])

      const toggle = useCallback(async (taskId) => {
        setExpanded((current) => (current === taskId ? null : taskId))
        if (selected === undefined) return
        try {
          const text = await getText(`${LOG_URL}?run=${encodeURIComponent(selected.id)}&task=${encodeURIComponent(taskId)}&tail=120`)
          setLogs((current) => ({ ...current, [taskId]: text }))
        } catch {
          /* ignore */
        }
      }, [selected])

      const section = (key, title, tally, rows, extra) => h('div', { className: 'ad-section', key },
        h('button', {
          className: 'ad-section-head',
          type: 'button',
          'aria-expanded': openSections[key] ? 'true' : 'false',
          onClick: () => toggleSection(key),
        },
          h('span', { className: 'ad-caret' }, openSections[key] ? '▾' : '▸'),
          h('span', { className: 'ad-section-title' }, title),
          h('span', { className: 'ad-meta' }, tally),
        ),
        openSections[key] ? h('div', { className: 'ad-section-body' }, extra, rows) : null,
      )

      const staffTally = (() => {
        const live = workers.filter((worker) => worker.status === 'alive').length
        const down = workers.filter((worker) => worker.status === 'dead').length
        const idle = workers.length - live - down
        return `${workers.length} 名 · ${live} 活${down > 0 ? ` / ${down} 故障` : ''}${idle > 0 ? ` / ${idle} 待机` : ''}`
      })()

      const staffRows = workers.map((worker) => h('div', {
        className: `ad-worker${changed.has(`staff:${worker.id}`) ? ' ad-worker-changed' : ''}`,
        key: worker.id,
        title: worker.detail ?? '',
      },
        h('span', {
          className: `ad-dot${worker.status === 'alive' ? ' ad-dot-run' : ''}`,
          style: { background: staffTone(worker).color },
        }),
        h('span', { className: 'ad-worker-id' }, worker.label || worker.id),
        h('span', { className: 'ad-worker-route' }, worker.model ? shortModel(worker.model) : '—'),
        h('span', {
          className: 'ad-meta',
          style: worker.status === 'dead' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined,
          title: worker.detail ?? '',
        },
          worker.status === 'alive'
            ? (worker.latencyMs ? `${(worker.latencyMs / 1000).toFixed(1)}s` : TONE.alive.label)
            : staffTone(worker).label),
        changed.has(`staff:${worker.id}`) ? h('span', { className: 'ad-chip ad-chip-block' }, '变更') : null,
      ))

      const benchTally = contractors.length === 0
        ? '暂无'
        : `${contractors.length} 名 · ${contractors.some((c) => c.working) ? '有人在干活' : '闲置待命'}`

      const benchRows = contractors.map((contractor) => h('div', {
        className: `ad-worker${changed.has(`bench:${contractor.id}`) ? ' ad-worker-changed' : ''}`,
        key: contractor.id,
        title: `${contractor.provider}/${contractor.model} · 接过 ${contractor.tasks} 件`,
      },
        h('span', {
          className: `ad-dot${contractor.working ? ' ad-dot-run' : ''}`,
          style: { background: benchTone(contractor).color },
        }),
        h('span', { className: 'ad-worker-route' }, `${contractor.provider}/${shortModel(contractor.model)}`),
        h('span', { className: 'ad-meta' }, contractor.working ? TONE.working.label : `${contractor.tasks} 件 · ${benchTone(contractor).label}`),
        changed.has(`bench:${contractor.id}`) ? h('span', { className: 'ad-chip ad-chip-block' }, '变更') : null,
      ))

      const staff = workers.length === 0 && contractors.length === 0 ? null : h('div', { className: 'ad-roster' },
        workers.length === 0 ? null : section('staff', '正式工', staffTally, staffRows, Legend()),
        contractors.length === 0 ? null : section('bench', '外包', benchTally, benchRows, null),
      )

      const header = h('div', { className: 'ad-head' },
        h('span', { className: 'ad-title' }, 'AI 派工'),
        h('span', { className: 'ad-count' }, runs.length > 0 ? `${runs.length} 轮` : ''),
        h('button', {
          className: 'ad-refresh', type: 'button', title: '立即刷新',
          onClick: () => { setNonce((n) => n + 1) },
        }, '刷新'),
      )

      if (data.loading && runs.length === 0) {
        return h('div', { className: 'ad-root' }, h('style', null, CSS), header,
          h('div', { className: 'ad-empty' }, '正在读取派工状态…'))
      }

      if (data.error !== null) {
        return h('div', { className: 'ad-root' }, h('style', null, CSS), header,
          h('div', { className: 'ad-empty' }, `读取失败：${data.error}`), staff)
      }

      if (selected === undefined) {
        return h('div', { className: 'ad-root' }, h('style', null, CSS), header,
          h('div', { className: 'ad-empty' },
            h('div', null, h('b', null, '还没有派工记录。')),
            h('div', { style: { marginTop: 6 } }, '在对话里让助手把目标拆成任务并分派，例如：'),
            h('div', { style: { marginTop: 6, fontStyle: 'italic' } },
              '“用 dispatch_run 把这个仓库的测试补全拆成 3 个任务，分给不同工人并行做。”'),
            h('div', { style: { marginTop: 6 } }, '任务会在这里实时显示谁在做什么。'),
          ), staff)
      }

      const counts = selected.counts ?? selected.tasks?.reduce((acc, task) => {
        acc[task.status] = (acc[task.status] ?? 0) + 1
        return acc
      }, {}) ?? {}
      const total = selected.total ?? selected.tasks?.length ?? 0
      const finished = (counts.done ?? 0) + (counts.failed ?? 0) + (counts.skipped ?? 0) + (counts.cancelled ?? 0)

      const bar = h('div', { className: 'ad-progress' },
        ['done', 'failed', 'skipped', 'cancelled', 'running'].map((key) => {
          const n = counts[key] ?? 0
          if (n === 0 || total === 0) return null
          return h('i', { key, style: { width: `${(n / total) * 100}%`, background: statusColor(key) } })
        }),
      )

      const rows = (selected.tasks ?? []).map((task) => {
        const isOpen = expanded === task.id
        const running = task.status === 'running'
        const duration = elapsedOf(task)
        const row = h('div', {
          className: 'ad-task-row', key: `${task.id}-row`,
          onClick: () => { void toggle(task.id) },
          role: 'button', tabIndex: 0,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void toggle(task.id) }
          },
        },
          h('span', { className: `ad-dot${running ? ' ad-dot-run' : ''}`, style: { background: statusColor(task.status) } }),
          h('span', { className: 'ad-subject', title: task.subject }, task.subject || task.id),
          task.verdict ? h('span', {
            className: `ad-chip ${task.verdict === 'pass' ? 'ad-chip-pass' : 'ad-chip-block'}`,
            title: task.reviewBy ? `验收方 ${task.reviewBy}` : '验收',
          }, task.verdict === 'pass' ? '✓ 验收' : '✗ 驳回') : null,
          task.rework ? h('span', { className: 'ad-chip ad-chip-block' }, `返工${task.rework}`) : null,
          task.model ? h('span', { className: 'ad-chip ad-chip-model', title: `${task.provider ?? ''}/${task.model}` },
            shortModel(task.model)) : null,
          task.worker ? h('span', { className: 'ad-chip' }, task.worker) : null,
          h('span', { className: 'ad-meta' },
            running ? '执行中…' : duration ? formatDuration(duration) : STATUS_TEXT[task.status] ?? task.status),
        )

        if (!isOpen) return h('div', { className: 'ad-task', key: task.id }, row)

        const body = h('div', { className: 'ad-body', key: `${task.id}-body` },
          task.error ? h('div', { className: 'ad-error', style: { marginTop: 8 } }, task.error) : null,
          task.output ? h('div', null,
            h('div', { className: 'ad-label' }, '输出'),
            h('pre', { className: 'ad-pre' }, task.output),
          ) : null,
          logs[task.id] ? h('div', null,
            h('div', { className: 'ad-label' }, '日志'),
            h('pre', { className: 'ad-pre' }, logs[task.id]),
          ) : null,
          !task.error && !task.output && !logs[task.id]
            ? h('div', { className: 'ad-label' }, STATUS_TEXT[task.status] ?? task.status)
            : null,
        )

        return h('div', { className: 'ad-task', key: task.id }, row, body)
      })

      return h('div', { className: 'ad-root' },
        h('style', null, CSS),
        header,
        h('select', {
          className: 'ad-select',
          value: selected.id,
          onChange: (event) => { setSelectedId(event.target.value); setExpanded(null) },
        }, runs.map((run) => h('option', { key: run.id, value: run.id },
          `${run.id} · ${STATUS_TEXT[run.status] ?? run.status} · ${run.total ?? run.tasks?.length ?? 0} 项`))),
        h('div', { className: 'ad-goal' }, selected.goal),
        bar,
        h('div', { className: 'ad-meta' }, `${finished}/${total} 已结束${selected.status === 'running' ? ' · 运行中' : ''}`),
        h('div', { className: 'ad-tasks' }, rows),
        staff,
      )
    }

    /* ── settings page: configure the cloud keys ── */

    const KEYS_URL = '/api/agent-dispatch/keys'
    const KEYS_TEST_URL = '/api/agent-dispatch/keys/test'

    async function sendJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return await response.json()
    }

    function KeySettings() {
      const [workers, setWorkers] = useState([])
      const [drafts, setDrafts] = useState({})
      const [modelDrafts, setModelDrafts] = useState({})
      const [busy, setBusy] = useState({})
      const [notes, setNotes] = useState({})
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        try {
          const next = await getJson(KEYS_URL)
          setWorkers(Array.isArray(next.workers) ? next.workers : [])
          setError(null)
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(async (worker, value) => {
        setBusy((current) => ({ ...current, [worker.id]: true }))
        try {
          const result = await sendJson(KEYS_URL, { workerId: worker.id, value })
          setNotes((current) => ({
            ...current,
            [worker.id]: result.ok
              ? (value === '' ? '已清除' : '已保存')
              : `失败：${result.error ?? 'unknown'}`,
          }))
          setDrafts((current) => ({ ...current, [worker.id]: '' }))
          await load()
        } catch (problem) {
          setNotes((current) => ({ ...current, [worker.id]: `失败：${String(problem?.message ?? problem)}` }))
        } finally {
          setBusy((current) => ({ ...current, [worker.id]: false }))
        }
      }, [load])

      const saveModel = useCallback(async (worker, model) => {
        setBusy((current) => ({ ...current, [worker.id]: true }))
        try {
          const result = await sendJson(KEYS_URL, { workerId: worker.id, model })
          setNotes((current) => ({
            ...current,
            [worker.id]: result.ok ? `model 已改为 ${result.model}` : `失败：${result.error ?? 'unknown'}`,
          }))
          await load()
        } catch (problem) {
          setNotes((current) => ({ ...current, [worker.id]: `失败：${String(problem?.message ?? problem)}` }))
        } finally {
          setBusy((current) => ({ ...current, [worker.id]: false }))
        }
      }, [load])

      const test = useCallback(async (worker) => {
        setBusy((current) => ({ ...current, [worker.id]: true }))
        try {
          const result = await sendJson(KEYS_TEST_URL, { workerId: worker.id })
          setNotes((current) => ({
            ...current,
            [worker.id]: result.ok
              ? `连接成功，${result.count ?? 0} 个模型${Array.isArray(result.models) && result.models.length > 0 ? `：${result.models.slice(0, 6).join(', ')}${result.count > 6 ? ' …' : ''}` : ''}`
              : `连接失败：${result.error ?? 'unknown'}`,
          }))
        } catch (problem) {
          setNotes((current) => ({ ...current, [worker.id]: `失败：${String(problem?.message ?? problem)}` }))
        } finally {
          setBusy((current) => ({ ...current, [worker.id]: false }))
        }
      }, [])

      if (error !== null) {
        return h('div', { className: 'ad-keys' }, h('style', null, CSS),
          h('div', { className: 'ad-empty' }, `无法读取配置：${error}`))
      }
      if (workers.length === 0) {
        return h('div', { className: 'ad-keys' }, h('style', null, CSS),
          h('div', { className: 'ad-empty' }, '没有配置任何 http 工人（阿里云 / 字节 / 腾讯混元 等）。在插件的 workers 里加 kind: http 就能在这里填 key。'))
      }

      return h('div', { className: 'ad-keys' },
        h('style', null, CSS),
        h('div', { className: 'ad-goal' }, '这里填的 key 存进 DSH 凭据库，不写配置文件，保存后立即生效，不用重启。'),
        workers.map((worker) => h('div', { className: 'ad-key-card', key: worker.id },
          h('div', { className: 'ad-key-head' },
            h('span', { className: 'ad-section-title' }, worker.label || worker.id),
            h('span', { className: `ad-chip ${worker.configured ? 'ad-chip-pass' : 'ad-chip-block'}` },
              worker.configured ? `已配置${worker.source ? `(${worker.source})` : ''}` : '未配置'),
          ),
          h('div', { className: 'ad-worker-route' }, `${worker.baseUrl ?? '(no baseUrl)'} · ${worker.model ?? '(no model)'}`),
          worker.envName === undefined ? null : h('div', { className: 'ad-meta' }, `凭据名：${worker.envName}`),
          h('div', { className: 'ad-key-row' },
            h('input', {
              className: 'ad-key-input',
              type: 'text',
              placeholder: 'model / 接入点 ID（如 ep-2025xxxx）',
              value: modelDrafts[worker.id] ?? worker.model ?? '',
              disabled: busy[worker.id] === true,
              onChange: (event) => {
                const value = event.target.value
                setModelDrafts((current) => ({ ...current, [worker.id]: value }))
              },
            }),
            h('button', {
              className: 'ad-refresh', type: 'button',
              disabled: busy[worker.id] === true || (modelDrafts[worker.id] ?? worker.model ?? '') === '',
              onClick: () => { void saveModel(worker, modelDrafts[worker.id] ?? worker.model ?? '') },
            }, '保存 model'),
          ),
          h('div', { className: 'ad-key-row' },
            h('input', {
              className: 'ad-key-input',
              type: 'password',
              placeholder: worker.configured ? '已配置，输入新值可覆盖' : '粘贴 API key',
              value: drafts[worker.id] ?? '',
              disabled: worker.canEdit !== true || busy[worker.id] === true,
              onChange: (event) => {
                const value = event.target.value
                setDrafts((current) => ({ ...current, [worker.id]: value }))
              },
            }),
            h('button', {
              className: 'ad-refresh', type: 'button',
              disabled: worker.canEdit !== true || busy[worker.id] === true || (drafts[worker.id] ?? '') === '',
              onClick: () => { void save(worker, drafts[worker.id] ?? '') },
            }, '保存'),
            h('button', {
              className: 'ad-refresh', type: 'button',
              disabled: busy[worker.id] === true,
              onClick: () => { void test(worker) },
            }, '测试连接'),
            worker.configured && worker.canEdit
              ? h('button', {
                className: 'ad-refresh', type: 'button',
                disabled: busy[worker.id] === true,
                onClick: () => { void save(worker, '') },
              }, '清除')
              : null,
          ),
          notes[worker.id] === undefined ? null : h('div', { className: 'ad-meta', style: { marginTop: 4 } }, notes[worker.id]),
        )),
      )
    }

    /* ── guide icon ── */

    function DispatchIcon() {
      return h('svg', {
        width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, stroke: 'var(--dsw-alias-label-primary)', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', { d: 'M12 3v6' }),
        h('path', { d: 'M12 15v6' }),
        h('path', { d: 'M3 12h6' }),
        h('path', { d: 'M15 12h6' }),
        h('path', { d: 'M6.5 6.5 9.5 9.5' }),
        h('path', { d: 'M14.5 14.5 17.5 17.5' }),
      )
    }

    /* ── plugin ── */

    function apply(ctx) {
      const slots = ctx.slots
      const tabs = ctx.sidebarRightTabs
      if (slots === undefined || tabs === undefined) return

      ctx.effect(() => tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => 'AI 派工',
        guide: [{
          id: 'dispatch',
          order: 60,
          title: () => 'AI 派工看板',
          description: () => '看谁在做什么任务，进度与输出实时刷新',
          icon: DispatchIcon,
        }],
      }), 'agent-dispatch.tab-type')

      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'agent-dispatch',
        order: 40,
        label: 'AI 派工',
      }, KeySettings)), 'agent-dispatch.settings')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, Board)), 'agent-dispatch.tab-body')
    }

    return {
      name: 'agent-dispatch-client',
      inject: ['slots', 'sidebarRightTabs'],
      apply,
    }
  },
})
