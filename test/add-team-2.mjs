import fs from 'node:fs'

const p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
let s = fs.readFileSync(p, 'utf8')

const anchor = "  }), 'agent-dispatch.outsource')"
if (!s.includes(anchor)) throw new Error('anchor missing')

const tool = anchor + `

  ctx.effect(() => tools.register({
    name: 'outsource_team',
    description: 'Hand a whole goal to a LEADER model and let it run the shop: the leader reads the capability table and the staff roster, splits the goal into a dependency-aware work order, picks which speciality takes each piece, the plugin dispatches and coordinates the group in parallel with cross-model acceptance, and the leader then consolidates one deliverable. Use this when the caller should delegate the planning itself, not just the execution.',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'The whole job, in the client\\'s words. The leader turns it into a work order.' },
        leader: { type: 'string', description: '"provider/model" of the leading model. Defaults to the configured leader, else the fastest live reasoning route.' },
        maxTasks: { type: 'number', description: 'Cap on how many pieces the leader may split the goal into (default 4, max 8).' },
        maxParallel: { type: 'number', description: 'How many pieces may run at once (capped at 8).' },
        planOnly: { type: 'boolean', description: 'Return the leader\\'s work order without dispatching it. Defaults to false.' },
        wait: { type: 'boolean', description: 'Block until the leader has consolidated. Defaults to true.' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          run_id: { type: 'string' }, status: { type: 'string' }, leader: { type: 'string' },
          delivered: { type: 'number' }, blocked: { type: 'number' }, failed: { type: 'number' },
          retries: { type: 'number' }, reworks: { type: 'number' }, elapsedMs: { type: 'number' },
          final: { type: 'string' }, note: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, subject: { type: 'string' }, type: { type: 'string' },
                needs: { type: 'array', items: { type: 'string' } },
                dependsOn: { type: 'array', items: { type: 'string' } },
                status: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
                verdict: { type: 'string' }, reviewBy: { type: 'string' }, rework: { type: 'number' },
                attempts: { type: 'number' }, durationMs: { type: 'number' }, error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          \`领导 \${value.leader} 组队 · \${value.status}\`,
          value.run_id === undefined
            ? '（只出工单，未派发）'
            : \`run \${value.run_id} · \${value.delivered} 交付 / \${value.blocked} 验收未过 / \${value.failed} 失败 · 返工 \${value.reworks} 次 · 重试 \${value.retries} 次 · \${Math.round((value.elapsedMs ?? 0) / 1000)}s\`,
          '',
          '工单：',
        ]
        for (const task of value.plan) {
          const route = task.model === undefined ? '未派' : \`\${task.provider ?? '?'}/\${task.model}\`
          const dep = asArray(task.dependsOn).length > 0 ? \` 依赖 \${task.dependsOn.join(',')}\` : ''
          const need = asArray(task.needs).length > 0 ? \` [\${task.needs.join(',')}]\` : ''
          const verdict = task.verdict === undefined ? '' : task.verdict === 'pass' ? ' ✓验收' : ' ✗驳回'
          lines.push(\`- \${task.subject} (\${task.type})\${need}\${dep} → \${route}\${verdict}\${task.error ? \` — \${task.error}\` : ''}\`)
        }
        if (value.note) lines.push(\`\\n领导说明：\${value.note}\`)
        if (value.final) lines.push(\`\\n── 最终交付 ──\\n\${value.final}\`)
        return textBlock(lines.join(String.fromCharCode(10)))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = agentCwd(exec, ctx) ?? process.cwd()
      const startedAt = Date.now()
      const catalog = await resolveCatalog(ctx)
      const capabilities = await engine.loadCapabilities(cwd)
      const alive = await engine.loadRouteAlive(cwd)
      const health = await engine.loadRouteHealth(cwd)
      const judge = engine.routeHealthJudge(health)

      // The leader is a route like any other, so it obeys the same health and
      // speed rules as the people it manages.
      let leader = parseRouteEntry(asString(args.leader)) ?? parseRouteEntry(engine.config.leader)
      if (leader === undefined) {
        const reasoning = asArray(capabilities.reasoning).map(parseRouteEntry).filter((route) => route !== undefined)
        leader = orderCandidates(reasoning, catalog, engine.config.providerPreference, judge, alive)[0]
      }
      if (leader === undefined) throw new Error('no leader route is available; pass leader as "provider/model"')
      const leaderLabel = \`\${leader.provider}/\${leader.model}\`

      const table = Object.entries(capabilities)
        .map(([need, list]) => \`\${need}: \${asArray(list).map((entry) => (typeof entry === 'string' ? entry : \`\${entry.provider}/\${entry.model}\`)).join(', ')}\`)
        .join(String.fromCharCode(10)) || '(空)'
      const roster = engine.workers(cwd)
        .map((worker) => \`\${worker.id}\${worker.provider === undefined ? '' : \` → \${worker.provider}/\${worker.model}\`}\${asArray(worker.capabilities).length === 0 ? '' : \` [\${worker.capabilities.join(',')}]\`}\`)
        .join(String.fromCharCode(10)) || '(空)'
      const cap = Number.isFinite(Number(args.maxTasks)) && Number(args.maxTasks) > 0
        ? Math.min(Math.floor(Number(args.maxTasks)), 8)
        : 4

      const planPrompt = [
        '你是一家 AI 外包公司的负责人。把客户的目标拆成一份可执行的工单，交给手下的专长模型去做。',
        '',
        \`客户目标：\${args.goal}\`,
        '',
        '本机的能力表（每一类代表"这类活谁最合适"）：',
        table,
        '',
        '正式工名单（可指定工人 id，也可只写能力类别由系统选人）：',
        roster,
        '',
        \`要求：\${cap} 件以内，每件必须是能独立完成、能验收的最小工作单元。\`,
        '- 有先后依赖的必须写 dependsOn（用本工单内的 id 引用），能并行的不要串起来。',
        '- needs 从能力表里选（如 coding / reasoning / fast / vision / long-context）。',
        '- type 从 implement / review / research / test / docs / image / any 里选。',
        '- acceptCriteria 写清"什么算做完"，验收方会按它判定，不通过会退回重做。',
        '- prompt 必须是自包含的完整指令，执行者看不到你和客户的对话。',
        '',
        '只输出一个 JSON 对象，不要任何解释或代码围栏：',
        '{"tasks":[{"id":"t1","subject":"短标题","type":"implement","needs":["coding"],"dependsOn":[],"prompt":"完整指令","acceptCriteria":"验收标准"}],"note":"一句话说明分工思路"}',
      ].join(String.fromCharCode(10))

      await ctx.logger?.info?.(\`agent-dispatch: leader \${leaderLabel} planning "\${String(args.goal).slice(0, 60)}"\`)
      const planText = await engine.callModel({ prompt: planPrompt, route: leader, cwd, tag: 'leader', signal: exec?.signal })
      const order = parseWorkOrder(planText)
      if (order === undefined || order.tasks.length === 0) {
        throw new Error(\`the leader returned no usable work order: \${clampText(planText, 600)}\`)
      }

      const ids = new Set()
      const work = []
      for (const raw of order.tasks.slice(0, cap)) {
        if (raw === null || typeof raw !== 'object') continue
        const prompt = asString(raw.prompt)
        if (prompt === undefined) continue
        let id = asString(raw.id, \`t\${work.length + 1}\`)
        while (ids.has(id)) id = \`\${id}_\`
        ids.add(id)
        work.push({
          id,
          subject: asString(raw.subject, id),
          prompt,
          type: asString(raw.type, 'any'),
          needs: asArray(raw.needs).filter((need) => typeof need === 'string'),
          dependsOn: asArray(raw.dependsOn).filter((dep) => typeof dep === 'string' && ids.has(dep)),
          acceptCriteria: asString(raw.acceptCriteria),
        })
      }
      if (work.length === 0) throw new Error('the leader\\'s work order had no task with a usable prompt')

      if (args.planOnly === true) {
        return {
          run_id: undefined, status: 'planned', leader: leaderLabel,
          delivered: 0, blocked: 0, failed: 0, retries: 0, reworks: 0,
          elapsedMs: Date.now() - startedAt,
          ...(order.note === undefined ? {} : { note: order.note }),
          plan: work.map((task) => ({
            id: task.id, subject: task.subject, type: task.type,
            needs: task.needs, dependsOn: task.dependsOn, status: 'planned',
          })),
        }
      }

      const run = await engine.createRun({
        goal: arg_safe(args.goal),
        tasks: work.map((task) => ({ ...task, accept: true })),
        cwd,
        maxParallel: args.maxParallel,
      })
      await engine.startRun(run)
      if (args.wait !== false) await run.promise

      const delivered = run.tasks.filter((task) => task.status === 'done')
      let final
      if (delivered.length > 0) {
        const digest = delivered
          .map((task) => \`## \${task.subject}\\n\${clampText(task.output ?? '', 6000)}\`)
          .join(String.fromCharCode(10) + String.fromCharCode(10))
        const finalPrompt = [
          '你是这家 AI 外包公司的负责人。手下已经交活了，现在由你向客户交付。',
          '',
          \`客户目标：\${args.goal}\`,
          '',
          '各件产出：',
          digest,
          '',
          '把上面整合成一份直接可用的最终交付：不要罗列过程，不要复述工单编号，不要写"以下是"之类的开场。',
          '如果各件之间有冲突或缺口，明确指出。',
        ].join(String.fromCharCode(10))
        try {
          final = await engine.callModel({ prompt: finalPrompt, route: leader, cwd, tag: 'leader-final', signal: exec?.signal })
        } catch (error) {
          final = \`（汇总失败：\${error instanceof Error ? error.message : String(error)}）\`
        }
      }

      return {
        run_id: run.id,
        status: run.status,
        leader: leaderLabel,
        delivered: delivered.length,
        blocked: run.tasks.filter((task) => task.verdict === 'block').length,
        failed: run.tasks.filter((task) => task.status === 'failed').length,
        retries: run.tasks.reduce((total, task) => total + Math.max(0, (task.attempts ?? 1) - 1), 0),
        reworks: run.tasks.reduce((total, task) => total + (task.rework ?? 0), 0),
        elapsedMs: Date.now() - startedAt,
        ...(order.note === undefined ? {} : { note: order.note }),
        ...(final === undefined ? {} : { final }),
        plan: run.tasks.map((task) => ({
          id: task.id, subject: task.subject, type: task.type,
          needs: asArray(task.needs), dependsOn: asArray(task.dependsOn),
          status: task.status,
          ...(task.provider === undefined ? {} : { provider: task.provider }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.verdict === undefined ? {} : { verdict: task.verdict }),
          ...(task.reviewBy === undefined ? {} : { reviewBy: task.reviewBy }),
          ...(task.rework ? { rework: task.rework } : {}),
          ...((task.attempts ?? 1) > 1 ? { attempts: task.attempts } : {}),
          ...(task.durationMs === undefined ? {} : { durationMs: task.durationMs }),
          ...(task.error === undefined ? {} : { error: task.error }),
        })),
      }
    },
  }), 'agent-dispatch.team')`

function arg_safe(value) {
  return typeof value === 'string' ? value : String(value)
}

s = s.replace(anchor, tool)
fs.writeFileSync(p, s)
console.log('outsource_team registered')
