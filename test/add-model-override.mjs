import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

// 1) the override store, inserted before workers()
const anchor = '  /** Worker declarations: config workers win, built-ins fill the gaps. */'
if (!s.includes(anchor)) throw new Error('anchor missing')
const helper = [
  '  /** Where per-worker overrides edited from the settings page live. */',
  '  workerOverrideFile(cwd) {',
  '    return join(this.rootFor(cwd), \'workers.json\')',
  '  }',
  '',
  '  async loadWorkerOverrides(cwd) {',
  '    try {',
  '      const stored = await readJson(this.workerOverrideFile(cwd))',
  '      const overrides = stored !== null && typeof stored?.overrides === \'object\' && stored.overrides !== null ? stored.overrides : {}',
  '      this.cachedOverrides = overrides',
  '      return overrides',
  '    } catch {',
  '      return {}',
  '    }',
  '  }',
  '',
  '  async saveWorkerOverride(cwd, workerId, patch) {',
  '    const file = this.workerOverrideFile(cwd)',
  '    await mkdir(this.rootFor(cwd), { recursive: true })',
  '    await withFileLock(file, async () => {',
  '      const stored = (await readJson(file)) ?? { version: STATE_VERSION, overrides: {} }',
  '      const overrides = stored.overrides !== null && typeof stored.overrides === \'object\' ? stored.overrides : {}',
  '      const current = overrides[workerId] !== null && typeof overrides[workerId] === \'object\' ? overrides[workerId] : {}',
  '      overrides[workerId] = { ...current, ...patch }',
  '      await atomicWriteJson(file, { version: STATE_VERSION, overrides })',
  '      this.cachedOverrides = overrides',
  '    })',
  '  }',
  '',
  anchor,
].join('\n')
s = s.replace(anchor, helper)

// 2) workers() consults the override
const anchorA = "        const kind = worker.kind === 'cli' ? 'cli' : worker.kind === 'http' ? 'http' : 'dsh'"
if (!s.includes(anchorA)) throw new Error('anchorA missing')
s = s.replace(anchorA, anchorA + '\n' + [
  '        const workerId = asString(worker.id, kind === \'cli\' ? `cli-${index}` : kind === \'http\' ? `http-${index}` : \'dsh\')',
  '        // A model id edited from the settings page wins, so switching to a new',
  '        // endpoint id does not require touching cordis.patch.yml.',
  '        const override = this.cachedOverrides?.[workerId]',
].join('\n'))

const anchorB = '          id: asString(worker.id, kind === \'cli\' ? `cli-${index}` : kind === \'http\' ? `http-${index}` : \'dsh\'),'
if (!s.includes(anchorB)) throw new Error('anchorB missing')
s = s.replace(anchorB, '          id: workerId,')

const anchorC = '          model: asString(worker.model),'
if (!s.includes(anchorC)) throw new Error('anchorC missing')
s = s.replace(anchorC, '          model: asString(override?.model) ?? asString(worker.model),')

fs.writeFileSync(p, s)
console.log('override store installed')
