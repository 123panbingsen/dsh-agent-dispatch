import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/client.js'
let s = fs.readFileSync(p, 'utf8')

// the settings page lives beside the board component
const anchor = "    /* ── guide icon ── */"
if (!s.includes(anchor)) throw new Error('anchor missing')

const page = `    /* ── settings page: configure the cloud keys ── */

    const KEYS_URL = '/api/agent-dispatch/keys'
    const KEYS_TEST_URL = '/api/agent-dispatch/keys/test'

    async function sendJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(\`\${response.status} \${response.statusText}\`)
      return await response.json()
    }

    function KeySettings() {
      const [workers, setWorkers] = useState([])
      const [drafts, setDrafts] = useState({})
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
              : \`失败：\${result.error ?? 'unknown'}\`,
          }))
          setDrafts((current) => ({ ...current, [worker.id]: '' }))
          await load()
        } catch (problem) {
          setNotes((current) => ({ ...current, [worker.id]: \`失败：\${String(problem?.message ?? problem)}\` }))
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
              ? \`连接成功，\${result.count ?? 0} 个模型\${Array.isArray(result.models) && result.models.length > 0 ? \`：\${result.models.slice(0, 6).join(', ')}\${result.count > 6 ? ' …' : ''}\` : ''}\`
              : \`连接失败：\${result.error ?? 'unknown'}\`,
          }))
        } catch (problem) {
          setNotes((current) => ({ ...current, [worker.id]: \`失败：\${String(problem?.message ?? problem)}\` }))
        } finally {
          setBusy((current) => ({ ...current, [worker.id]: false }))
        }
      }, [])

      if (error !== null) {
        return h('div', { className: 'ad-keys' }, h('style', null, CSS),
          h('div', { className: 'ad-empty' }, \`无法读取配置：\${error}\`))
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
            h('span', { className: \`ad-chip \${worker.configured ? 'ad-chip-pass' : 'ad-chip-block'}\` },
              worker.configured ? \`已配置\${worker.source ? \`(\${worker.source})\` : ''}\` : '未配置'),
          ),
          h('div', { className: 'ad-worker-route' }, \`\${worker.baseUrl ?? '(no baseUrl)'} · \${worker.model ?? '(no model)'}\`),
          worker.envName === undefined ? null : h('div', { className: 'ad-meta' }, \`凭据名：\${worker.envName}\`),
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

` + anchor

s = s.replace(anchor, page)

// register the page in Settings
s = s.replace(
  "      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({",
  `      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'agent-dispatch',
        order: 40,
        label: 'AI 派工',
      }, KeySettings)), 'agent-dispatch.settings')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({`)

// the module must declare the slot it uses
s = s.replace("      inject: ['slots', 'sidebarRightTabs'],", "      inject: ['slots', 'sidebarRightTabs'],")

// styles for the page
s = s.replace(".ad-roster { display:flex;", `.ad-keys { display:flex; flex-direction:column; gap:10px; padding:14px; font-size:13px; color:var(--dsw-alias-label-primary); }
.ad-key-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); padding:10px; display:flex; flex-direction:column; gap:6px; }
.ad-key-head { display:flex; align-items:center; gap:8px; }
.ad-key-row { display:flex; align-items:center; gap:6px; }
.ad-key-input { flex:1 1 auto; min-width:0; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:6px; padding:5px 8px; font-size:12px; }
.ad-key-input:disabled { opacity:.55; }
.ad-roster { display:flex;`)

fs.writeFileSync(p, s)
console.log('settings page added')
