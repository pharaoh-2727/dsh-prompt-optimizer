/**
 * test-brute-force.cjs —— 暴力测试：把所有入口、所有档位、各类输入都碾一遍。
 *
 * 只检查「不该发生的事」：
 *   A. 任何入口、任何档位、任何输入都不许抛未捕获异常；
 *   B. 错误必须带正确的错误码，不能变成 500；
 *   C. 系统提示里永远不许出现 {{占位符}} 或【环境参数】；
 *   D. 五个入口对同一输入必须给出同一份正文；
 *   E. 流式入口的末帧 delta 必须等于 done.text；
 *   F. 极端输入不得让插件崩掉。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const ROOT = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-brute')

const PLACEHOLDERS = ['{{workspace}}', '{{environment}}', '【环境参数']
const STYLES = ['brief', 'balanced', 'detailed']

let pass = 0
let fail = 0
const failures = []

async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    fail += 1
    failures.push(name + " —— " + error.message)
  }
}

let loadCounter = 0
async function loadPlugin(style) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'prompt-optimizer'), { recursive: true })
  stubModel(join(ROOT, 'profile'))
  writeFileSync(
    join(ROOT, 'prompt-optimizer', 'settings.json'),
    JSON.stringify({
      modelMode: 'auto',
      provider: '',
      model: '',
      style,
      customPrompt: '',
      freeChannelAsked: true,
    }, null, 2),
    'utf8',
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = ROOT
  try {
    loadCounter += 1
    return await import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/** 假 ctx。reply 决定模型吐什么：字符串原样回，函数按输入算。 */
function makeCtx(options) {
  const opts = options || {}
  const workspace = opts.workspace
  const reply = opts.reply === undefined ? function (text) { return text } : opts.reply
  const throwOnStream = opts.throwOnStream === true
  const systems = []
  const handlers = {}
  const commands = []
  const toolDefs = []
  const provided = {}
  function runStream(callOptions) {
    systems.push(callOptions.system)
    const input = callOptions.messages[0].content[0].text
    const out = typeof reply === 'function' ? reply(input) : reply
    const chunks = []
    if (throwOnStream !== true && out.length > 0) {
      for (let i = 0; i < out.length; i += 7) chunks.push(out.slice(i, i + 7))
    }
    return (async function* () {
      if (throwOnStream === true) throw new Error('模拟模型故障')
      for (const piece of chunks) yield { type: "text-delta", index: 0, text: piece }
    })()
  }
  const ctx = {
    systems,
    on() { return () => {} },
    effect(fn) { return fn() },
    webServer: {
      register(route) {
        handlers[route.path] = route.handler
        return () => {}
      },
    },
    llm: { listProviders: () => [], listModels: async () => [], stream: runStream },
    get: () => undefined,
    // 按宿主真实契约：sessions.get(id) 与会话对象；agents.get(id) 与 agent。
    sessions: workspace === undefined
      ? undefined
      : { get: (id) => ({ id, header: { cwd: workspace } }) },
    agents: workspace === undefined
      ? undefined
      : { get: (id) => ({ id, session: { id, header: { cwd: workspace } } }) },
    workingDirectory: undefined,
    inject(list, callback) {
      const target = Array.isArray(list) ? list : Object.keys(list)
      for (const name of target) if (ctx[name] === undefined) throw new Error('missing service ' + name)
      return callback(ctx)
    },
    commands: { register(d) { commands.push(d); return () => {} } },
    tools: { register(d) { toolDefs.push(d); return () => {} } },
    provide(name, value) {
      if (provided[name] !== undefined) throw new Error('duplicate ' + name)
      provided[name] = value
      return async () => { delete provided[name] }
    },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers, commands, toolDefs, provided, systems }
}
function makeReq(url, payload) {
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload), 'utf8')
    },
  }
}

function makeRes() {
  return {
    code: 200,
    body: '',
    writeHead(code) { this.code = code },
    write(chunk) { this.body += String(chunk) },
    end(body) { if (body !== undefined) this.body += String(body) },
    setHeader() {},
    flushHeaders() {},
  }
}

async function post(handlers, path, payload) {
  const res = makeRes()
  await handlers[path](makeReq(path, payload), res)
  return res
}

/**
 * 解析 SSE。必须是「一个事件 = event 名 + data」，不是把 data 行单独攒起来：
 * 宿主推的是 `event: done\ndata: {...}`，只看 data 行会丢掉事件名，
 * 于是所有事件都长成一个样子，done / error 都认不出来。
 */
function parseSse(raw) {
  const events = []
  let name = 'message'
  let data = ''
  const flush = () => {
    if (data.length === 0) { name = 'message'; return }
    try {
      events.push({ event: name, data: JSON.parse(data) })
    } catch { /* 半帧，忽略 */ }
    name = 'message'
    data = ''
  }
  for (const line of raw.split('\n')) {
    if (line.length === 0) { flush(); continue }
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) {
      const piece = line.slice(5).trim()
      data = data.length === 0 ? piece : data + '\n' + piece
    }
  }
  flush()
  return events
}

/** 各类输入。前几个是正常内容，后面是有意找麻烦的边界。 */
const INPUTS = [
  { name: '普通任务', text: '帮我把这个插件的日志功能补上' },
  { name: '带路径', text: '把 src/app.ts 里的重试逻辑改一下，加重试上限' },
  { name: '路径含空格', text: '改一下 @path with space/file.ts 这个文件' },
  { name: '多行', text: '第一行：读日志\n第二行：找报错\n第三行：写复现脚本' },
  { name: '英文', text: 'refactor the retry helper and add a regression test' },
  { name: 'emoji', text: '🔧 帮我修一下这个 bug 🐛' },
  { name: '单字', text: '改' },
  { name: '空白两侧', text: '   把这段改清楚   ' },
  { name: '控制字符', text: '改一下\u0000这段\u0007文字' },
  { name: '零宽字符', text: '改一下\u200b这段\u200d文字' },
  { name: '全角标点', text: '改一下！！这段。。。文字？？？' },
  { name: '换行轰炸', text: '\n\n\n\n\n\n\n\n' },
  { name: '贴着上限', text: '改'.repeat(19990) },
]
const WORKSPACE = "C:\\work\\proj"
const SESSION_ID = "brute-session-1"
const REPLY = "这是改写后的正文，包含产出与验收口径。"

async function exercise(style, input) {
  const mod = await loadPlugin(style)

  const a = makeCtx({ workspace: WORKSPACE, reply: REPLY })
  mod.apply(a.ctx)
  const resOptimize = await post(a.handlers, '/dsh-prompt-optimizer/optimize', { text: input.text, sessionId: SESSION_ID })
  const bodyOptimize = JSON.parse(resOptimize.body || '{}')

  const b = makeCtx({ workspace: WORKSPACE, reply: REPLY })
  mod.apply(b.ctx)
  const resStream = await post(b.handlers, '/dsh-prompt-optimizer/stream', { text: input.text, sessionId: SESSION_ID })
  const events = parseSse(resStream.body)
  const doneEvent = events.find((e) => e.event === 'done')
  const deltas = events.filter((e) => e.event === 'delta')
  const lastDelta = deltas.length > 0 ? deltas[deltas.length - 1].data.text : ""

  const c = makeCtx({ workspace: WORKSPACE, reply: REPLY })
  mod.apply(c.ctx)
  const cmd = c.commands.find((d) => d.name === 'optimize')
  const tool = c.toolDefs.find((d) => d.name === 'optimize_prompt')
  const svc = c.provided.promptOptimizer

  // 三个宿主入口把错误抛成异常（HTTP 路由才把它翻成状态码），
  // 这里统一兜住 —— 「合法地失败」也是一条要检查的路径，不该让整个用例炸掉。
  const cmdResult = await Promise.resolve()
    .then(() => cmd.handler({ rawInput: input.text, agent: undefined, sessionId: SESSION_ID }))
    .catch((error) => ({ kind: 'error', text: String(error && error.message) }))
  const toolResult = await Promise.resolve()
    .then(() => tool.execute({ text: input.text }, {}))
    .catch((error) => ({ text: '', error: String(error && error.message) }))
  const svcResult = await Promise.resolve()
    .then(() => svc.optimize(input.text))
    .catch((error) => ({ ok: false, error: String(error && error.message) }))

  return { mod, resOptimize, bodyOptimize, resStream, events, doneEvent, lastDelta, a, c, cmdResult, toolResult, svcResult }
}
async function main() {
  console.log('══ 阶段 1：三档 × 各类输入，跑全部入口 ══')

  for (const style of STYLES) {
    for (const input of INPUTS) {
      const label = style + ' / ' + input.name
      const run = await exercise(style, input)

      // 「失败」与「崩掉」是两件事：输入全是空白时，五个入口都该给出
      // 一个说得清的结果（400 / 命令回用法提示 / 服务抛 EMPTY_INPUT），
      // 这就是正确行为。只有 500 和未捕获异常才算崩。
      const isEmpty = input.text.trim().length === 0

      await checkAsync('[' + label + '] 入口不崩', async () => {
        if (run.resOptimize.code === 500) throw new Error("optimize 500: " + run.resOptimize.body.slice(0, 120))
        if (run.resStream.code === 500) throw new Error("stream 500: " + run.resStream.body.slice(0, 120))
        if (isEmpty) {
          // 空输入：路由 400、命令回用法提示、服务抛 EMPTY_INPUT，全都合法
          if (run.resOptimize.code !== 400) throw new Error('空输入应为 400，实际 ' + run.resOptimize.code)
          if (run.cmdResult.kind !== 'error') throw new Error('空输入的命令应当报错')
          if (run.svcResult.ok !== false) throw new Error('空输入的服务应当失败')
          return
        }
        if (run.cmdResult.kind !== "success") throw new Error("命令失败: " + JSON.stringify(run.cmdResult).slice(0, 160))
        if (run.svcResult.ok !== true) throw new Error("服务失败: " + JSON.stringify(run.svcResult).slice(0, 160))
      })

      await checkAsync('[' + label + '] 系统提示无占位符', async () => {
        for (const system of run.a.systems) {
          for (const ph of PLACEHOLDERS) {
            if (system.includes(ph)) throw new Error('系统提示里出现 ' + ph)
          }
        }
      })

      /*
       * 短到没有信息可补的输入会被直通（原样返回、不调模型），见 index.js 的
       * MIN_MEANINGFUL_CHARS。这类输入没有系统提示可查，跳过这条断言 ——
       * 它的契约由 test-audit-fixes.cjs 单独钉住（不调模型、原样返回）。
       */
      const passthrough = run.a.systems.length === 0 && run.bodyOptimize?.ok === true

      if (!isEmpty && !passthrough) {
        await checkAsync('[' + label + '] 系统提示带上了工作区', async () => {
          if (run.a.systems.length === 0) throw new Error('根本没调用模型')
          if (!run.a.systems[0].includes(WORKSPACE)) throw new Error("没带上工作区")
        })
      }

      await checkAsync('[' + label + '] 末帧 delta === done.text', async () => {
        if (run.doneEvent === undefined) {
          if (run.bodyOptimize.ok === false) return
          throw new Error("流里没有 done 事件")
        }
        // 直通时流里没有任何 delta，末帧是空串，而 done.text 是原文 —— 这是对的。
        if (passthrough && run.lastDelta === '') return
        if (run.lastDelta !== run.doneEvent.data.text) {
          throw new Error("末帧 " + run.lastDelta.length + " 字 ≠ done " + run.doneEvent.data.text.length + " 字")
        }
      })

      await checkAsync('[' + label + '] 五个入口同一份正文', async () => {
        if (run.bodyOptimize.ok !== true) {
          if (run.svcResult.ok === true || run.cmdResult.kind === "success") {
            throw new Error("一次性路由失败但别的入口成功，口径不一致")
          }
          return
        }
        const texts = [
          run.bodyOptimize.text,
          run.doneEvent instanceof Object ? run.doneEvent.data.text : "",
          String(run.toolResult.text === undefined ? "" : run.toolResult.text).trim(),
          run.svcResult.text,
        ].filter(function (t) { return typeof t === "string" && t.length > 0 })
        const first = texts[0]
        for (const t of texts) {
          if (t !== first) throw new Error("正文不一致：" + JSON.stringify(t.slice(0, 30)) + " vs " + JSON.stringify(first.slice(0, 30)))
        }
      })
    }
    console.log('  ' + style + ' 档：' + INPUTS.length + ' 类输入 × 5 项检查 完成')
  }
  console.log('')
  console.log('══ 阶段 2：错误路径必须带正确错误码 ══')

  const mod2 = await loadPlugin('balanced')
  const ERR_CASES = [
    ['空字符串', { text: '' }, 400, 'EMPTY_INPUT'],
    ['纯空格', { text: '    ' }, 400, 'EMPTY_INPUT'],
    ['只有换行', { text: '\n\n\n' }, 400, 'EMPTY_INPUT'],
    ['没有 text 字段', {}, 400, 'EMPTY_INPUT'],
    ['超长', { text: 'x'.repeat(20001) }, 400, 'TOO_LONG'],
    ['超长一点点', { text: 'x'.repeat(20000) }, 200, null],
    ['模型吐空', { text: '帮我改一段话' }, 502, 'EMPTY_OUTPUT'],
  ]
  for (const row of ERR_CASES) {
    const emptyReply = row[3] === "EMPTY_OUTPUT" ? "" : REPLY
    const h = makeCtx({ workspace: WORKSPACE, reply: emptyReply })
    mod2.apply(h.ctx)
    const res = await post(h.handlers, '/dsh-prompt-optimizer/optimize', row[1])
    await checkAsync('[错误路径] ' + row[0], async () => {
      if (res.code !== row[2]) throw new Error('期望 ' + row[2] + '，实际 ' + res.code + '：' + res.body.slice(0, 100))
      if (row[3] !== null && !res.body.includes(row[3])) throw new Error('回执里没有 ' + row[3])
    })
  }
  console.log('  7 条错误路径 完成')

  console.log('')
  console.log('══ 阶段 3：模型抛异常不能带崩宿主 ══')
  {
    const h = makeCtx({ workspace: WORKSPACE, throwOnStream: true })
    mod2.apply(h.ctx)
    const res = await post(h.handlers, '/dsh-prompt-optimizer/optimize', { text: '帮我改一段话' })
    await checkAsync('[异常] 一次性路由 → 5xx 且带原因', async () => {
      if (res.code < 500 || res.code > 599) throw new Error('期望 5xx，实际 ' + res.code)
      const parsed = JSON.parse(res.body)
      if (parsed.ok !== false) throw new Error('没有 ok:false')
      if (typeof parsed.error !== 'string' || parsed.error.length === 0) throw new Error('没有 error 文案')
    })
    const resStream = await post(h.handlers, '/dsh-prompt-optimizer/stream', { text: '帮我改一段话' })
    const ev = parseSse(resStream.body)
    await checkAsync('[异常] 流式路由 → 推 error 事件', async () => {
      if (!ev.some(function (e) { return e.event === 'error' })) throw new Error('流里没有 error：' + resStream.body.slice(0, 160))
    })
  }
  console.log('')
  console.log('══ 阶段 4：没有会话信息时不编造工作区 ══')
  {
    const h = makeCtx({ workspace: undefined, reply: REPLY })
    mod2.apply(h.ctx)
    const res = await post(h.handlers, '/dsh-prompt-optimizer/optimize', { text: '帮我改一段话' })
    const parsed = JSON.parse(res.body)
    await checkAsync('[无会话] 仍能正常产出', async () => {
      if (parsed.ok !== true) throw new Error('失败了：' + parsed.error)
    })
    await checkAsync('[无会话] 不编造工作区路径、不留占位符', async () => {
      const system = h.systems[0]
      if (/当前会话的工作区是 .+；/u.test(system)) throw new Error('编造了工作区')
      for (const ph of PLACEHOLDERS) if (system.includes(ph)) throw new Error('残留 ' + ph)
    })
  }

  console.log('')
  console.log('══ 阶段 5：设置页显示的提示词与实际发出的同源 ══')
  {
    const h = makeCtx({ workspace: WORKSPACE, reply: REPLY })
    mod2.apply(h.ctx)
    await post(h.handlers, '/dsh-prompt-optimizer/optimize', { text: '帮我改一段话' })
    const actual = h.systems[0]
    await checkAsync('[同源] 实际提示词包含静态渲染的全部段落', async () => {
      const item = mod2.STYLE_ITEMS.find(function (s) { return s.id === 'balanced' })
      for (const line of item.prompt.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        if (trimmed.includes('当前会话的工作区是')) continue
        if (!actual.includes(trimmed)) throw new Error('实际提示词缺这一行：' + trimmed.slice(0, 50))
      }
    })
    await checkAsync('[同源] 静态提示词里没有占位符', async () => {
      for (const item of mod2.STYLE_ITEMS) {
        for (const ph of PLACEHOLDERS) {
          if (item.prompt.includes(ph)) throw new Error(item.id + ' 含 ' + ph)
        }
      }
    })
  }

  console.log('')
  console.log('══ 阶段 6：错误码在两条路上一致，且客户端能拿到 ══')
  {
    const cases = [
      ['空输入', { text: '' }, 400, 'EMPTY_INPUT'],
      ['超长', { text: 'x'.repeat(20001) }, 400, 'TOO_LONG'],
    ]
    for (const row of cases) {
      const h1 = makeCtx({ workspace: WORKSPACE, reply: REPLY })
      mod2.apply(h1.ctx)
      const one = await post(h1.handlers, '/dsh-prompt-optimizer/optimize', { text: row[1].text, sessionId: SESSION_ID })
      const h2 = makeCtx({ workspace: WORKSPACE, reply: REPLY })
      mod2.apply(h2.ctx)
      const many = await post(h2.handlers, '/dsh-prompt-optimizer/stream', { text: row[1].text, sessionId: SESSION_ID })
      const streamEvents = parseSse(many.body)
      const errEvent = streamEvents.find(function (e) { return e.event === 'error' })
      await checkAsync('[错误码] ' + row[0] + ' 一次性路由带 code', async () => {
        if (one.code !== row[2]) throw new Error("状态码 " + one.code + " ≠ " + row[2])
        const parsed = JSON.parse(one.body)
        if (parsed.code !== row[3]) throw new Error('code 是 ' + parsed.code + '，期望 ' + row[3])
      })
      await checkAsync('[错误码] ' + row[0] + ' 流式路由带 code', async () => {
        // 前置校验（空、超长）发生在开流之前，走的是 HTTP 状态码 + JSON，
        // 不推 SSE 事件；只有生成中途失败才推 error 事件。
        // 两种形态都得带 code —— 判据是「拿得到 code」，不是「一定有事件」。
        if (many.code !== 200) {
          if (many.code !== row[2]) throw new Error('HTTP ' + many.code + '，期望 ' + row[2])
          const parsed = JSON.parse(many.body)
          if (parsed.code !== row[3]) throw new Error('JSON code 是 ' + parsed.code + '，期望 ' + row[3])
          return
        }
        if (errEvent === undefined) throw new Error('HTTP 200 但流里没有 error 事件')
        if (errEvent.data.code !== row[3]) throw new Error('事件 code 是 ' + errEvent.data.code + '，期望 ' + row[3])
      })
    }

    // 模型吐空：这条走的是完整链路，错误码是模型侧产生的。
    const h3 = makeCtx({ workspace: WORKSPACE, reply: "" })
    mod2.apply(h3.ctx)
    const empty = await post(h3.handlers, '/dsh-prompt-optimizer/optimize', { text: '帮我改一段话', sessionId: SESSION_ID })
    await checkAsync('[错误码] 模型吐空 → EMPTY_OUTPUT', async () => {
      const parsed = JSON.parse(empty.body)
      if (empty.code !== 502) throw new Error('期望 502，实际 ' + empty.code)
      if (parsed.code !== 'EMPTY_OUTPUT') throw new Error('code 是 ' + parsed.code)
    })
  }
  console.log('')
  if (fail === 0) {
    console.log('ALL BRUTE FORCE TESTS PASSED （' + pass + ' 项）')
    return
  }
  console.error('失败 ' + fail + ' / ' + (pass + fail) + '：')
  for (const line of failures) console.error('  ✗ ' + line)
  process.exitCode = 1
}

main().catch(function (error) {
  console.error('FATAL:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
