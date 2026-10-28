import io

p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

i = next(k for k, l in enumerate(lines) if l.startswith('async function spawnableCommand('))
end = i
while lines[end] != '}':
    end += 1

new_fn = """/**
 * How to start a CLI worker. On Windows an npm global install is a .cmd shim,
 * and spawn() cannot execute a batch file with shell:false. Two shapes work:
 * run the shim through cmd.exe, or — better — skip the shim and start node on
 * the package entry the shim points at.
 */
async function spawnTarget(command) {
  if (process.platform !== 'win32') return { file: command, prefix: [] }
  const resolved = /[\\\\/]/.test(command) || /\\.[a-z0-9]{2,4}$/i.test(command)
    ? command
    : (await findExecutable(command)) ?? command
  if (!/\\.(cmd|bat)$/i.test(resolved)) return { file: resolved, prefix: [] }
  try {
    const { readFile, access } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const script = await readFile(resolved, 'utf8')
    const match = script.match(/(node_modules[\\\\/][^"'\\s]+)/)
    if (match !== null) {
      const entry = join(dirname(resolved), match[1].replace(/^["']|["']$/g, ''))
      await access(entry)
      return { file: process.execPath, prefix: [entry] }
    }
  } catch {
    /* fall through to cmd.exe */
  }
  return { file: process.env.ComSpec ?? 'cmd.exe', prefix: ['/d', '/s', '/c', resolved] }
}""".split('\n')

lines[i:end + 1] = new_fn

k = next(idx for idx, l in enumerate(lines) if l.strip() == 'const command = await spawnableCommand(declared)')
lines[k] = '    const target = await spawnTarget(declared)'
lines.insert(k + 1, '    const command = target.file')

m = next(idx for idx, l in enumerate(lines) if l.strip() == 'const child = spawn(command, args, {')
lines[m] = '    const child = spawn(command, [...target.prefix, ...args], {'

n = next(idx for idx, l in enumerate(lines) if 'await this.appendLog(run, task, `spawn ${command}' in l)
lines[n] = "    await this.appendLog(run, task, `spawn ${[command, ...target.prefix, ...args].map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' ')}`)"

io.open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print('spawnTarget installed')
