import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

// 1) make the probe prefer a Windows launcher over the extensionless npm shim
const before = [
  '      const first = String(stdout).split(/\\r?\\n/).map((line) => line.trim()).find(Boolean)',
  '      done(first)',
].join('\n')
const after = [
  '      const lines = String(stdout).split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean)',
  "      if (process.platform !== 'win32') return done(lines[0])",
  '      // npm installs an extensionless POSIX shim beside the real Windows',
  '      // launchers, and spawn() without a shell cannot start that shim.',
  "      for (const pattern of ['\\\\.cmd$', '\\\\.exe$', '\\\\.bat$', '\\\\.ps1$']) {",
  '        const hit = lines.find((line) => new RegExp(pattern, "i").test(line))',
  '        if (hit !== undefined) return done(hit)',
  '      }',
  '      done(lines[0])',
].join('\n')
if (!s.includes(before)) throw new Error('probe body not found')
s = s.replace(before, after)

// 2) add the spawn helper right after findExecutable
const anchor = '/* ────────────────────────────── capability catalog ────────────────────────────── */'
if (!s.includes(anchor)) throw new Error('catalog anchor missing')
const helper = [
  '/** The path to actually spawn: on Windows that must be a launcher, not a shim. */',
  'async function spawnableCommand(command) {',
  "  if (process.platform !== 'win32') return command",
  '  if (/[\\\\/]/.test(command) || /\\.[a-z0-9]{2,4}$/i.test(command)) return command',
  '  return (await findExecutable(command)) ?? command',
  '}',
  '',
  anchor,
].join('\n')
s = s.replace(anchor, helper)

// 3) use it in the cli runner
const before3 = [
  '    const command = worker.command',
  '    if (command === undefined) throw new Error(`cli worker "${worker.id}" declares no command`)',
].join('\n')
const after3 = [
  '    const declared = worker.command',
  '    if (declared === undefined) throw new Error(`cli worker "${worker.id}" declares no command`)',
  '    const command = await spawnableCommand(declared)',
].join('\n')
if (!s.includes(before3)) throw new Error('cli command lines not found')
s = s.replace(before3, after3)

fs.writeFileSync(p, s)
console.log('windows launcher resolution installed')
