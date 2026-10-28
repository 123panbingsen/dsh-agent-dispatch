import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

const anchor = 'function routeForNeeds(catalog, needs, capabilities) {'
const at = s.indexOf(anchor)
if (at === -1) throw new Error('anchor missing')

const helper = `/**
 * Read a leader's work order. Models wrap JSON in prose and fences, and a plan
 * that cannot be read is worse than no plan, so the outermost object wins.
 */
function parseWorkOrder(text) {
  const withoutFences = String(text ?? '').replace(/\`\`\`(?:json)?/gi, '').trim()
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

`
s = s.slice(0, at) + helper + s.slice(at)
fs.writeFileSync(p, s)
console.log('work-order parser added before routeForNeeds')
