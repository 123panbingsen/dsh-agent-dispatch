import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/test/engine.test.mjs'
let s = fs.readFileSync(p, 'utf8')

const start = s.indexOf("await test('the roster revision changes when a worker changes'")
const end = s.indexOf("await test('unload cancels every live run'")
if (start === -1 || end === -1 || start >= end) throw new Error(`markers not found: ${start} ${end}`)

const block = `await test('the roster revision tracks worker changes', async () => {
  const read = async (routes) => {
    const captured = { body: '' }
    await routes.get('/api/agent-dispatch/state').handler(
      { url: '/api/agent-dispatch/state', headers: {} },
      { writeHead() { return this }, end(body) { captured.body = body ?? ''; return this } },
    )
    return JSON.parse(captured.body)
  }
  const a = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(a.ctx, { workers: [{ id: 'only', kind: 'dsh' }] })
  const first = await read(a.routes)
  const second = await read(a.routes)
  assert.equal(first.workers.length, 1, 'the roster must list the declared worker')
  assert.equal(first.workers[0].id, 'only')
  assert.equal(second.rosterRevision, first.rosterRevision, 'an unchanged roster keeps its revision')

  const b = makeCtx({ services: { agents: makeAgents() } })
  plugin.apply(b.ctx, { workers: [{ id: 'only', kind: 'dsh', provider: 'p1', model: 'text-1' }] })
  const third = await read(b.routes)
  assert.equal(third.workers[0].model, 'text-1', 'the roster must report the bound route')
  assert.notEqual(third.rosterRevision, first.rosterRevision, 'a binding change must change the revision')
})

`

s = s.slice(0, start) + block + s.slice(end)
s = s.replace(`
function rosterSig(holder) {
  return holder.ctx.__roster ?? ''
}`, '')
fs.writeFileSync(p, s)
console.log('roster revision test rewritten for real')
