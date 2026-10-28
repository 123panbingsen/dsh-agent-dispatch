import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
const s = fs.readFileSync(p, 'utf8')

const start = s.indexOf('function orderCandidates(')
const end = s.indexOf('function routeForNeeds(')
if (start === -1 || end === -1 || start >= end) throw new Error(`bounds: ${start} ${end}`)

const block = `function orderCandidates(candidates, catalog, preference, isDead, alive) {
  const lastProviders = new Set(asArray(preference?.last).filter((id) => typeof id === 'string'))
  const HISTORY = 3600_000
  const describe = (route) => {
    const entry = isDead?.entryFor?.(route)
    const at = entry === undefined ? 0 : Number(entry.at) || 0
    const dead = isDead?.isDead?.(route) === true
    const record = alive?.[\`\${route.provider}/\${route.model}\`]
    // Speed only counts while the measurement is fresh, and a dead route is
    // never preferred for being quick.
    const fresh = record !== undefined && Number(record.at) > Date.now() - HISTORY
    const latency = fresh && dead === false ? Math.max(1, Number(record.latencyMs) || 999_999) : 999_999
    return {
      route,
      dead: dead ? 1 : 0,
      last: lastProviders.has(route.provider) ? 1 : 0,
      latency,
      at: dead ? at : 0,
    }
  }
  const rank = (a, b) => (a.dead - b.dead) || (a.last - b.last) || (a.latency - b.latency) || (a.at - b.at)

  const seen = new Set()
  const declared = []
  for (const candidate of asArray(candidates)) {
    if (candidate === undefined || candidate === null) continue
    const provider = candidate.provider
    const model = candidate.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    const key = \`\${provider}/\${model}\`
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
    const key = \`\${provider}/\${model}\`
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

`

fs.writeFileSync(p, s.slice(0, start) + block + s.slice(end))
console.log('orderCandidates rewritten: declared first, catalog as fallback')
