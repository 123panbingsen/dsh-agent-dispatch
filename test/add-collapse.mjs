import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/client.js'
let s = fs.readFileSync(p, 'utf8')

// collapse state, kept in the component
const stateAnchor = "      const [changed, setChanged] = useState(() => new Set())"
if (!s.includes(stateAnchor)) throw new Error('state anchor missing')
s = s.replace(stateAnchor, stateAnchor + `
      // The roster is reference information; the work is what the user watches.
      // Both sections start collapsed and expand on click.
      const [openSections, setOpenSections] = useState({ staff: false, bench: false })
      const toggleSection = useCallback((key) => {
        setOpenSections((current) => ({ ...current, [key]: !current[key] }))
      }, [])`)

// replace the whole staff block with two collapsible sections
const start = s.indexOf('      const staff = (() => {')
const endMarker = '      const header = h(\'div\', { className: \'ad-head\' },'
const end = s.indexOf(endMarker)
if (start === -1 || end === -1 || start >= end) throw new Error(`bounds ${start} ${end}`)

const block = `      const section = (key, title, tally, rows, extra) => h('div', { className: 'ad-section', key },
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
        return \`\${workers.length} 名 · \${live} 活\${down > 0 ? \` / \${down} 故障\` : ''}\${idle > 0 ? \` / \${idle} 待机\` : ''}\`
      })()

      const staffRows = workers.map((worker) => h('div', {
        className: \`ad-worker\${changed.has(\`staff:\${worker.id}\`) ? ' ad-worker-changed' : ''}\`,
        key: worker.id,
        title: worker.detail ?? '',
      },
        h('span', {
          className: \`ad-dot\${worker.status === 'alive' ? ' ad-dot-run' : ''}\`,
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
            ? (worker.latencyMs ? \`\${(worker.latencyMs / 1000).toFixed(1)}s\` : TONE.alive.label)
            : staffTone(worker).label),
        changed.has(\`staff:\${worker.id}\`) ? h('span', { className: 'ad-chip ad-chip-block' }, '变更') : null,
      ))

      const benchTally = contractors.length === 0
        ? '暂无'
        : \`\${contractors.length} 名 · \${contractors.some((c) => c.working) ? '有人在干活' : '闲置待命'}\`

      const benchRows = contractors.map((contractor) => h('div', {
        className: \`ad-worker\${changed.has(\`bench:\${contractor.id}\`) ? ' ad-worker-changed' : ''}\`,
        key: contractor.id,
        title: \`\${contractor.provider}/\${contractor.model} · 接过 \${contractor.tasks} 件\`,
      },
        h('span', {
          className: \`ad-dot\${contractor.working ? ' ad-dot-run' : ''}\`,
          style: { background: benchTone(contractor).color },
        }),
        h('span', { className: 'ad-worker-route' }, \`\${contractor.provider}/\${shortModel(contractor.model)}\`),
        h('span', { className: 'ad-meta' }, contractor.working ? TONE.working.label : \`\${contractor.tasks} 件 · \${benchTone(contractor).label}\`),
        changed.has(\`bench:\${contractor.id}\`) ? h('span', { className: 'ad-chip ad-chip-block' }, '变更') : null,
      ))

      const staff = workers.length === 0 && contractors.length === 0 ? null : h('div', { className: 'ad-roster' },
        staff.length === 0 ? null : section('staff', '正式工', staffTally, staffRows, Legend()),
        contractors.length === 0 ? null : section('bench', '外包', benchTally, benchRows, null),
      )

`
s = s.slice(0, start) + block + s.slice(end)

// the work area comes first: drop the roster from the top of every branch
s = s.replace("h('style', null, CSS), header, staff,", "h('style', null, CSS), header,")
// and mount it once, at the very end of the main branch
s = s.replace("        h('div', { className: 'ad-tasks' }, rows),\n      )",
              "        h('div', { className: 'ad-tasks' }, rows),\n        staff,\n      )")

fs.writeFileSync(p, s)
console.log('collapsible roster built, mounted under the work area')
