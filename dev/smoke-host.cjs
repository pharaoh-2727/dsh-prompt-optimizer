/**
 * smoke-host.cjs —— 用一个最小假 ctx 跑一遍 host 半区，验证：
 *   1. 模块能被 import（语法与顶层代码无误）
 *   2. apply(ctx) 注册的三个路由路径正确
 *   3. agent/pre-step waterfall 会把本次 step 的 modelSelection 记进 routeBySession
 *   4. 读取 settings 路由能返回合理的 JSON
 */
const { pathToFileURL } = require('node:url')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || path.join(__dirname, '..', 'index.js')

// 这个用例把 routeBySession 当唯一的路由来源（断言 resolved.source === 'session'）。
// 别的机器上如果存在 profile 里的默认模型，兜底链会先命中它，断言就会飘，
// 所以这里把 DSH_HOME / DSH_PROFILE_DIR 都指向空的临时目录 ——
// 让「这台机器上有什么」完全不影响结果。模型桩在拿到会话路由之前不会被用到。
const TMP = mkdtempSync(path.join(os.tmpdir(), 'dsho-smoke-'))
process.env.DSH_HOME = TMP
stubModel(path.join(TMP, 'profile'))

// 设置也自己写一份：用例里要断言「工具回报的是当前启用的档位」，
// 读真机设置的话，别人把默认档位改成精简这条就红了。
mkdirSync(path.join(TMP, 'prompt-optimizer'), { recursive: true })
writeFileSync(
  path.join(TMP, 'prompt-optimizer', 'settings.json'),
  JSON.stringify({
    modelMode: 'auto',
    provider: '',
    model: '',
    style: 'detailed',
    customPrompt: '',
    freeChannelAsked: true,
  }, null, 2),
  'utf8',
)

async function main() {
  const mod = await import(pathToFileURL(PLUGIN).href)
  console.log('name        :', mod.name)
  console.log('inject      :', JSON.stringify(mod.inject))
  console.log('exports     :', Object.keys(mod).sort().join(', '))
  if (mod.name !== 'dsh-prompt-optimizer') throw new Error('bad plugin name')
  if (!Array.isArray(mod.inject) || !mod.inject.includes('llm') || !mod.inject.includes('webServer')) {
    throw new Error('bad inject list')
  }
  if (!Array.isArray(mod.STYLE_ITEMS) || mod.STYLE_ITEMS.length !== 3) {
    throw new Error('STYLE_ITEMS missing or wrong size')
  }
  const ids = mod.STYLE_ITEMS.map((s) => s.id)
  console.log('styles      :', ids.join(', '))
  for (const s of mod.STYLE_ITEMS) {
    if (!s.prompt.includes('DSH 场景约定')) throw new Error('style ' + s.id + ' lacks DSH scene block')
    if (!s.prompt.includes('公共规则')) throw new Error('style ' + s.id + ' lacks COMMON block')
  }
  console.log('DSH scene   : present in all 3 styles ✓')

  const routes = []
  const handlers = {}
  const listeners = {}
  const disposers = []
  const commands = []
  const tools = []
  const provided = {}
  const injected = []
  const ctx = {
    on(event, fn) {
      ;(listeners[event] ||= []).push(fn)
      return () => {}
    },
    // 插件把 webServer.register 的撤销函数交给 ctx.effect 收集；
    // 这里同步执行并记录，便于验证「插件停止时路由被撤销」。
    effect(fn) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result)
      return result
    },
    webServer: {
      register(route) {
        routes.push(route.path)
        handlers[route.path] = route.handler
        return () => {
          const index = routes.indexOf(route.path)
          if (index >= 0) routes.splice(index, 1)
          delete handlers[route.path]
        }
      },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: async () => { throw new Error('not used in smoke test') },
    },
    get: () => undefined,
    sessions: undefined,
    agents: undefined,
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    // 可选服务用 ctx.inject 挂：真实 cordis 会等依赖就绪后再调 callback。
    // 测试里同步调用即可，但要把服务桩先挂到 ctx 上（和 cordis 语义一致）。
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    inject(list, callback) {
      const target = Array.isArray(list) ? list : Object.keys(list)
      injected.push(target.join(','))
      for (const name of target) {
        if (ctx[name] === undefined) throw new Error('inject asked for missing service: ' + name)
      }
      const result = callback(ctx)
      return { dispose() {}, then: (fn) => Promise.resolve(result).then(fn) }
    },
    provide(name, value) {
      if (provided[name] !== undefined) throw new Error('duplicate service ' + name)
      provided[name] = value
      return async () => { delete provided[name] }
    },
  }

  mod.apply(ctx)
  console.log('routes      :', routes.join(', '))
  for (const p of ['/dsh-prompt-optimizer/settings', '/dsh-prompt-optimizer/free-channel/test', '/dsh-prompt-optimizer/optimize', '/dsh-prompt-optimizer/abort', '/dsh-prompt-optimizer/stream']) {
    if (!routes.includes(p)) throw new Error('missing route ' + p)
  }

  // 宿主侧三个入口：斜杠命令、工具、服务。
  console.log('injected    :', injected.join(' | '))
  console.log('commands    :', commands.map((c) => '/' + c.name).join(', ') || '(none)')
  console.log('tools       :', tools.map((t) => t.name).join(', ') || '(none)')
  console.log('services    :', Object.keys(provided).join(', ') || '(none)')
  if (!commands.some((c) => c.name === 'optimize')) throw new Error('missing /optimize command')
  if (!tools.some((t) => t.name === 'optimize_prompt')) throw new Error('missing optimize_prompt tool')
  if (provided.promptOptimizer === undefined) throw new Error('missing promptOptimizer service')
  if (typeof provided.promptOptimizer.optimize !== 'function') throw new Error('service lacks optimize()')
  if (!Array.isArray(provided.promptOptimizer.styles()) || provided.promptOptimizer.styles().length !== 3) {
    throw new Error('service styles() broken')
  }
  // 工具的 parameters 必须是原始 JSON Schema（required 用数组）：
  // dsh-tools 的 schemaOf 直接快照，不编译 defineTool 的 DSL。
  const tool = tools.find((t) => t.name === 'optimize_prompt')
  if (!Array.isArray(tool.parameters.required) || tool.parameters.required[0] !== 'text') {
    throw new Error('tool parameters.required must be an array')
  }
  if (typeof tool.output.render !== 'function') throw new Error('tool output.render must be a function')
  if (tool.output.schema.type !== 'object') throw new Error('tool output.schema must be an object schema')

  // agent/pre-step waterfall（宿主只在 payload 里给 modelSelection，不给 config）
  const req = listeners['agent/pre-step'][0]
  let nextCalled = false
  const decision = await req(
    {
      agent: { id: 'smoke-session-1', session: { id: 'smoke-session-1' } },
      modelSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    },
    async () => { nextCalled = true; return { kind: 'enter', messages: [] } },
  )
  console.log('waterfall   : next called =', nextCalled, '| returned decision =', decision.kind)
  if (!nextCalled) throw new Error('agent/pre-step did not call next()')
  if (decision?.kind !== 'enter') throw new Error('agent/pre-step must return the next() decision')

  // settings GET
  const res = {
    writeHead() {},
    end(body) { this.body = body },
  }
  await handlers['/dsh-prompt-optimizer/settings']({ method: 'GET', url: '/dsh-prompt-optimizer/settings?sessionId=smoke-session-1' }, res)
  const parsed = JSON.parse(res.body)
  console.log('settings ok :', parsed.ok, '| styles:', parsed.styles.length, '| resolved:', JSON.stringify(parsed.resolved))
  if (!parsed.ok) throw new Error('settings route failed')
  if (!parsed.resolved || parsed.resolved.source !== 'session') {
    throw new Error('routeBySession not populated: ' + JSON.stringify(parsed.resolved))
  }

  // optimize: 空文本 → 400（req 必须是 async iterable，模拟 Node http.IncomingMessage）
  const makeReq = (method, url, bodyText) => ({
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(bodyText ?? '', 'utf8')
    },
  })
  const res2 = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: '   ' })), res2)
  console.log('empty input : http', res2.code, JSON.parse(res2.body).error)
  if (res2.code !== 400) throw new Error('empty input should be 400')

  // optimize: 超过长度上限 → 400
  const res3 = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: 'x'.repeat(20001) })), res3)
  console.log('too long    : http', res3.code, JSON.parse(res3.body).error)
  if (res3.code !== 400) throw new Error('overlong input should be 400')

  // optimize: 走假 llm 流，确认成功路径返回结构
  // 真实的 ctx.llm.stream() 返回的是 async generator（不是 Promise）：
  //   LlmRuntime.stream → waterfall('llm/stream', options, () => adapterStream(...))
  //   adapterStream 是 async * 生成器 → 直接返回 async iterable。
  ctx.llm.stream = () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '改写后的提示词正文' }
  })()
  const res4 = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: '帮我跑一下测试脚本', sessionId: 'smoke-session-1' })), res4)
  const ok4 = JSON.parse(res4.body)
  console.log('optimize ok : http', res4.code, '| text =', JSON.stringify(ok4.text), '| provider/model =', ok4.provider, '/', ok4.model, '| style =', ok4.style)
  if (!ok4.ok) throw new Error('optimize failed: ' + ok4.error)
  if (ok4.text !== '改写后的提示词正文') throw new Error('unexpected text')
  if (ok4.provider !== 'workbuddy') throw new Error('route not resolved from session')

  // 取消链路：中止后 optimize 应以 499/aborted 收场，而不是 502「没有返回内容」。
  // 这是真实踩过的坑 —— 流被中止时 collectText 收上来是空文本，
  // 早期版本会先回 502，永远走不到 abort 分支。
  // 这里换成一个「挂着等 signal」的假流：只有 signal 中止才会结束。
  ctx.llm.stream = (options) => (async function* () {
    await new Promise((resolve, reject) => {
      const signal = options?.signal
      if (!signal) return
      if (signal.aborted) {
        const err = new Error('已取消')
        err.aborted = true
        reject(err)
        return
      }
      signal.addEventListener('abort', () => {
        const err = new Error('已取消')
        err.aborted = true
        reject(err)
      }, { once: true })
    })
    yield { type: 'text-delta', index: 0, text: '不该走到这里' }
  })()
  const res5 = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  const abortReq = makeReq('POST', '/dsh-prompt-optimizer/abort', JSON.stringify({ requestId: 'smoke-abort-1' }))
  const res6 = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  const optimizePromise = handlers['/dsh-prompt-optimizer/optimize'](
    makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: '帮我跑一下测试脚本', sessionId: 'smoke-session-1', requestId: 'smoke-abort-1' })),
    res6,
  )
  // 等优化任务登记进 activeJobs，再发取消
  await new Promise((r) => setTimeout(r, 20))
  await handlers['/dsh-prompt-optimizer/abort'](abortReq, res5)
  const abortBody = JSON.parse(res5.body)
  console.log('abort route : http', res5.code, JSON.stringify(abortBody))
  if (!abortBody.ok || abortBody.aborted !== true) throw new Error('abort route did not abort: ' + res5.body)
  await optimizePromise
  const aborted = JSON.parse(res6.body)
  console.log('aborted opt : http', res6.code, JSON.stringify(aborted))
  if (res6.code !== 499 || aborted.aborted !== true) {
    throw new Error('aborted optimize should be 499/aborted, got ' + res6.code + ' ' + res6.body)
  }

  // 斜杠命令 /optimize：handler 直接调，验回执形状与两条失败分支。
  const command = commands.find((c) => c.name === 'optimize')
  const emptyReply = await command.handler({ rawInput: '   ', signal: undefined, agent: undefined })
  console.log('cmd empty   :', JSON.stringify(emptyReply).slice(0, 80))
  if (emptyReply.kind !== 'error') throw new Error('/optimize with empty input should be an error')
  if (!emptyReply.text.includes('用法')) throw new Error('/optimize error text should explain usage')

  ctx.llm.stream = () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '改写后的提示词正文' }
  })()
  const cmdReply = await command.handler({ rawInput: '帮我跑一下测试脚本', signal: undefined, agent: undefined })
  console.log('cmd ok      :', cmdReply.kind, '|', JSON.stringify(cmdReply.text).slice(0, 90))
  if (cmdReply.kind !== 'success') throw new Error('/optimize should succeed: ' + cmdReply.text)
  if (!cmdReply.text.startsWith('改写后的提示词正文')) throw new Error('/optimize text should start with the result')
  if (!cmdReply.text.includes('档位：')) throw new Error('/optimize text should carry the meta line')

  // 工具 optimize_prompt：execute 直接调，验返回值与 render 投影。
  const promptTool = tools.find((t) => t.name === 'optimize_prompt')
  const toolValue = await promptTool.execute({ text: '帮我跑一下测试脚本' }, { agent: undefined, signal: undefined, arguments: {} })
  console.log('tool exec   :', JSON.stringify(toolValue).slice(0, 90))
  if (typeof toolValue.text !== 'string' || toolValue.text.length === 0) throw new Error('tool returned no text')
  if (toolValue.style !== 'detailed') throw new Error('tool should report the active style')
  const rendered = promptTool.output.render({ text: '帮我跑一下测试脚本' }, toolValue)
  if (!Array.isArray(rendered) || rendered[0].type !== 'text' || rendered[0].text !== toolValue.text) {
    throw new Error('tool render projection broken: ' + JSON.stringify(rendered))
  }

  // 服务 promptOptimizer.optimize()：和上面两条走同一份实现。
  const serviceValue = await provided.promptOptimizer.optimize('帮我跑一下测试脚本', {})
  console.log('service     :', JSON.stringify(serviceValue.text).slice(0, 60))
  if (serviceValue.text !== toolValue.text) throw new Error('service and tool should return the same text')

  // SSE 流式端点：假流吐 text-delta / reasoning-delta / usage / finish，
  // 检查推给界面的帧里有没有正文、思考过程、用量与用时。
  ctx.llm.stream = () => (async function* () {
    yield { type: 'reasoning-delta', index: 0, text: '先看看输入框里写了什么' }
    yield { type: 'text-delta', index: 0, text: '改写后的' }
    yield { type: 'text-delta', index: 0, text: '提示词正文' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const frames = []
  const res7 = {
    writeHead(code, headers) { this.code = code; this.headers = headers },
    write(chunk) { frames.push(String(chunk)) },
    end(body) { this.body = body },
  }
  await handlers['/dsh-prompt-optimizer/stream'](
    makeReq('POST', '/dsh-prompt-optimizer/stream', JSON.stringify({ text: '帮我跑一下测试脚本', sessionId: 'smoke-session-1' })),
    res7,
  )
  const sse = frames.join('')
  const events = sse.split('\n\n').filter((part) => part.trim().length > 0)
  const names = events.map((part) => {
    const match = /^event: ([a-z]+)/.exec(part)
    return match === null ? '?' : match[1]
  })
  const payloadOf = (name) => {
    // delta 是「累计正文」，会推好几帧；取最后一帧才是最终结果。
    let found = null
    for (const part of events) {
      if (part.startsWith('event: ' + name)) {
        const dataLine = part.split('\n').find((line) => line.startsWith('data:'))
        found = dataLine === undefined ? null : JSON.parse(dataLine.slice(5))
      }
    }
    return found
  }
  console.log('sse headers :', res7.code, String(res7.headers && res7.headers['Content-Type']))
  console.log('sse events  :', names.join(', '))
  console.log('sse delta   :', JSON.stringify(payloadOf('delta')))
  console.log('sse reason  :', JSON.stringify(payloadOf('reasoning')))
  console.log('sse done    :', JSON.stringify(payloadOf('done')))
  if (res7.code !== 200) throw new Error('stream route should answer 200, got ' + res7.code)
  if (!names.includes('start')) throw new Error('no start event: ' + sse)
  if (!names.includes('delta')) throw new Error('no delta event: ' + sse)
  if (!names.includes('reasoning')) throw new Error('no reasoning event: ' + sse)
  if (!names.includes('done')) throw new Error('no done event: ' + sse)
  const deltaPayload = payloadOf('delta')
  if (deltaPayload === null || deltaPayload.text !== '改写后的提示词正文') {
    throw new Error('unexpected delta payload: ' + JSON.stringify(deltaPayload))
  }
  const reasonPayload = payloadOf('reasoning')
  if (reasonPayload === null || reasonPayload.text !== '先看看输入框里写了什么') {
    throw new Error('unexpected reasoning payload: ' + JSON.stringify(reasonPayload))
  }
  const donePayload = payloadOf('done')
  if (donePayload === null || donePayload.ok !== true) throw new Error('done payload broken: ' + JSON.stringify(donePayload))
  if (donePayload.text !== '改写后的提示词正文') throw new Error('done text mismatch')
  if (donePayload.usage === null || donePayload.usage.totalTokens !== 20) {
    throw new Error('done payload lacks usage: ' + JSON.stringify(donePayload.usage))
  }
  if (typeof donePayload.elapsedMs !== 'number') throw new Error('done payload lacks elapsedMs')
  // 路由清理：插件停止时（effect 的 disposer 被调用）三条路由必须从表里消失，
  // 否则插件被热替换时新实例会撞上 "duplicate exact route"。
  for (const dispose of disposers) dispose()
  console.log('after dispose: routes left =', routes.length)
  if (routes.length !== 0) throw new Error('routes were not released on dispose')

  console.log('\nHOST HALF SMOKE TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
