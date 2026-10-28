/**
 * Classify every session in one workspace store by how it was created.
 * The first line of each store file is the session record itself.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const root = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator--'
const LEAD = 'session-c4053284-cd9f-41b9-abc0-7b691ab7a196'
const rows = []

for (const dir of readdirSync(root)) {
  const file = join(root, dir, 'session.v4.jsonl.zstd')
  let stat
  try { stat = statSync(file) } catch { continue }
  let record
  try {
    const text = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
    record = JSON.parse(text.split('\n').find((line) => line.trim() !== '') ?? '{}')
  } catch (error) {
    rows.push({ id: dir.slice(0, 8), kind: 'unreadable', mtime: stat.mtimeMs })
    continue
  }
  const origin = record.origin ?? ''
  const parent = record.parentSession ?? ''
  const kind = origin === 'subagent'
    ? (parent === LEAD ? '本会话的子代理' : '其他子代理')
    : parent === ''
      ? '无父会话（顶层或派工子代理）'
      : '有父会话'
  rows.push({
    id: dir.slice(0, 8),
    kind,
    created: record.createdAt ?? 0,
    cwd: record.cwd ?? '',
    preset: record.agentPreset ?? '',
    mtime: stat.mtimeMs,
  })
}

rows.sort((a, b) => b.mtime - a.mtime)
const todayStart = new Date('2026-10-27T00:00:00+08:00').getTime()
const todays = rows.filter((r) => r.mtime >= todayStart)

console.log(`本工作区会话总数: ${rows.length} | 今天新增/改动: ${todays.length}\n`)

const buckets = new Map()
for (const r of todays) buckets.set(r.kind, (buckets.get(r.kind) ?? 0) + 1)
console.log('=== 按来源分类（今天）===')
for (const [kind, count] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${kind}`)
}

const presets = new Map()
for (const r of rows) presets.set(r.preset || '(none)', (presets.get(r.preset || '(none)') ?? 0) + 1)
console.log('\n=== 全部会话按 agent preset ===')
for (const [preset, count] of [...presets].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${preset}`)
}

console.log('\n=== 今天最早/最晚 ===')
const times = todays.map((r) => r.created).filter((t) => t > 0).sort((a, b) => a - b)
if (times.length > 0) {
  console.log('  first:', new Date(times[0]).toISOString())
  console.log('  last :', new Date(times[times.length - 1]).toISOString())
}
