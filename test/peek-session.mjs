import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const root = 'C:/Users/Administrator/.dsh/sessions/--C-Users-Administrator--'
const dir = readdirSync(root).find((d) => d.startsWith('fea179ef'))
const file = join(root, dir, 'session.v4.jsonl.zstd')
const text = zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log('lines:', lines.length)
for (const line of lines.slice(0, 3)) {
  console.log('---')
  console.log(line.slice(0, 400))
}
