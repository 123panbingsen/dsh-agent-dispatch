import io

p = 'C:/Users/Administrator/build/ai-dispatch/plugin/index.js'
src = io.open(p, encoding='utf-8').read()

# 1) image workers branch out before the chat call
old = """  async runHttpTask(run, task, worker, signal) {
    const baseUrl = asString(worker.baseUrl)
    if (baseUrl === undefined) throw permanent(`http worker "${worker.id}" declares no baseUrl`)
    const model = asString(task.model) ?? asString(worker.model)
    if (model === undefined) throw permanent(`http worker "${worker.id}" declares no model`)
    const url = `${baseUrl.replace(/[/]+$/, '')}/chat/completions`"""
new = """  async runHttpTask(run, task, worker, signal) {
    const baseUrl = asString(worker.baseUrl)
    if (baseUrl === undefined) throw permanent(`http worker "${worker.id}" declares no baseUrl`)
    const model = asString(task.model) ?? asString(worker.model)
    if (model === undefined) throw permanent(`http worker "${worker.id}" declares no model`)
    if (worker.mode === 'image') return await this.runImageTask(run, task, worker, model, signal)
    const url = `${baseUrl.replace(/[/]+$/, '')}/chat/completions`"""
assert src.count(old) == 1, 'chat head'
src = src.replace(old, new)

# 2) the image runner
anchor = '  async runHttpTask(run, task, worker, signal) {'
helper = '''  /**
   * Image generation is a different endpoint and a different result shape: the
   * payload carries base64 or a URL that expires, so the bytes are saved next
   * to the run and the saved path is the deliverable.
   */
  async runImageTask(run, task, worker, model, signal) {
    const baseUrl = asString(worker.baseUrl)
    const url = `${String(baseUrl).replace(/[/]+$/, '')}/images/generations`
    const headers = { 'content-type': 'application/json' }
    const key = await resolveWorkerKey(this.ctx, worker)
    if (key !== undefined) headers.authorization = `Bearer ${key}`
    const body = {
      model,
      prompt: task.prompt,
      n: 1,
      ...(worker.size === undefined ? {} : { size: worker.size }),
      ...(worker.responseFormat === undefined ? {} : { response_format: worker.responseFormat }),
    }
    await this.appendLog(run, task, `POST ${url} model=${model}`)
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort)
    // Image models routinely need far longer than a text call.
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs(), 180_000))
    try {
      const response = await fetch(url, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify(body) })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} from ${url}${text === '' ? '' : `: ${text.slice(0, 300)}`}`)
      }
      const payload = await response.json()
      const first = Array.isArray(payload?.data) ? payload.data[0] : undefined
      if (first === undefined || typeof first !== 'object') {
        throw new Error(`the endpoint returned no image: ${clampText(JSON.stringify(payload ?? {}), 300)}`)
      }

      const dir = join(this.rootFor(run.cwd), 'images', run.id)
      await mkdir(dir, { recursive: true })
      const stamp = task.id
      let saved
      if (typeof first.b64_json === 'string' && first.b64_json !== '') {
        saved = join(dir, `${stamp}.png`)
        await writeFile(saved, Buffer.from(first.b64_json, 'base64'))
      } else if (typeof first.url === 'string' && first.url !== '') {
        // A hosted URL expires; keep the bytes so the deliverable survives.
        const download = await fetch(first.url, { signal: controller.signal })
        if (!download.ok) throw new Error(`the image URL answered HTTP ${download.status}`)
        const buffer = Buffer.from(await download.arrayBuffer())
        const extension = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(first.url)?.[1]?.toLowerCase() ?? 'png'
        saved = join(dir, `${stamp}.${extension}`)
        await writeFile(saved, buffer)
      } else {
        throw new Error('the endpoint returned neither b64_json nor url')
      }
      const size = (await import('node:fs/promises')).stat ? await (await import('node:fs/promises')).stat(saved).catch(() => undefined) : undefined
      await this.appendLog(run, task, `saved ${saved}${size === undefined ? '' : ` (${size.size} bytes)`}`)
      return {
        output: `已生成图片：${saved}${size === undefined ? '' : `（${size.size} 字节）`}`,
        imagePath: saved,
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
  }

'''
i = src.index(anchor)
src = src[:i] + helper + src[i:]

io.open(p, 'w', encoding='utf-8').write(src)
print('image runner added')
