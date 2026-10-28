import io, re

p = r'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

# 1) replace the two probe lines with Windows-launcher-aware selection
i = next(k for k, l in enumerate(lines) if l.strip().startswith('const first = String(stdout)'))
assert lines[i + 1].strip() == 'done(first)', lines[i + 1]
new_block = [
    '      const lines = String(stdout).split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean)',
    "      if (process.platform !== 'win32') return done(lines[0])",
    '      // npm installs an extensionless POSIX shim beside the real Windows',
    '      // launchers, and spawn() without a shell cannot start that shim.',
    "      for (const pattern of ['\\\\.cmd$', '\\\\.exe$', '\\\\.bat$', '\\\\.ps1$']) {",
    '        const hit = lines.find((line) => new RegExp(pattern, "i").test(line))',
    '        if (hit !== undefined) return done(hit)',
    '      }',
    '      done(lines[0])',
]
lines[i:i + 2] = new_block

# 2) add spawnableCommand after findExecutable's closing brace
j = next(k for k, l in enumerate(lines) if l.startswith('async function findExecutable('))
end = j
while lines[end] != '}':
    end += 1
helper = [
    '',
    '/** The path to actually spawn: on Windows that must be a launcher, not a shim. */',
    'async function spawnableCommand(command) {',
    "  if (process.platform !== 'win32') return command",
    '  if (/[\\\\/]/.test(command) || /\\.[a-z0-9]{2,4}$/i.test(command)) return command',
    '  return (await findExecutable(command)) ?? command',
    '}',
]
lines[end + 1:end + 1] = helper

# 3) cli runner spawns the resolved launcher
k = next(idx for idx, l in enumerate(lines) if l.strip() == 'const command = worker.command')
assert 'declares no command' in lines[k + 1], lines[k + 1]
lines[k] = '    const declared = worker.command'
lines[k + 1] = '    if (declared === undefined) throw new Error(`cli worker "${worker.id}" declares no command`)'
lines.insert(k + 2, '    const command = await spawnableCommand(declared)')

io.open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print('windows launcher resolution installed')
