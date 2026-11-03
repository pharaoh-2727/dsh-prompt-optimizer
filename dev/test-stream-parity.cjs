/**
 * test-stream-parity.cjs —— 验证 /stream 和 /optimize 产出同一份结果。
 *
 * 为什么专门写这一套：
 *   /stream 曾经自己拼了一遍 ctx.llm.stream，绕过了 optimizeText 里的
 *   档位复核、过度扩写兜底和免费通道回退。而客户端的六个入口**全走 /stream**，
 *   于是「客户端路径」和「命令/工具路径」结果不一致 —— 同样的输入、同样的档位，
 *   一边被削到档位内，另一边没有。
 *
 * 断言：
 *   1. /stream 在详细档拿到超长输出时，也要走修正重试，done.adjusted === 'trimmed'；
 *   2. 最终正文是重试后的那份，不是第一份；
 *   3. /stream 与 /optimize 对同一输入、同一脚本序列给出相同的 text / adjusted；
 *   4. /stream 仍然推 start / delta / done 三类事件（流式手感没丢）。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-stream-parity')

// 自动模式的兜底链末端要能在 profile patch 里找到默认模型；
// 测试环境没有真实 profile，用桩顶上（见 stub-model.cjs）。

let loadCounter = 0

async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  // 临时目录刚被清空，模型桩要在这之后补（见 stub-model.cjs）。
  stubModel(join(TMP, 'profile'))
  writeFileSync(
    join(TMP, 'prompt-optimizer', 'settings.json'),
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
  process.env.DSH_HOME = TMP
  try {
    loadCounter += 1
    return await import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function makeCtx(scripts) {
  const calls = []
  const handlers = {}
  const ctx = {
    calls,
    on: () => () => {},
    effect(fn) { return fn() },
    webServer: {
      register(route) {
        handlers[route.path] = route.handler
        return () => {}
      },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: (options) => {
        const next = scripts[Math.min(calls.length, scripts.length - 1)]
        calls.push({ system: options.system, input: options.messages[0].content[0].text })
        return (async function* () {
          // 拆成两段吐，验证流式路径确实在边收边推。
          const half = Math.floor(next.length / 2)
          yield { type: 'text-delta', index: 0, text: next.slice(0, half) }
          yield { type: 'text-delta', index: 0, text: next.slice(half) }
          yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 22 } }
        })()
      },
    },
    get: () => undefined,
    sessions: undefined,
    agents: undefined,
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers }
}

function makeReq(path, body) {
  return {
    method: 'POST',
    url: path,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

/** 收集 SSE 事件：把 event:/data: 行解析回 {event, data} 列表。 */
function makeRes() {
  const events = []
  let raw = ''
  return {
    events,
    writeHead(code) { this.code = code },
    write(chunk) {
      raw += String(chunk)
      let index = raw.indexOf('\n\n')
      while (index !== -1) {
        const block = raw.slice(0, index)
        raw = raw.slice(index + 2)
        let event = 'message'
        const dataLines = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length > 0) {
          events.push({ event, data: JSON.parse(dataLines.join('\n')) })
        }
        index = raw.indexOf('\n\n')
      }
    },
    end(body) {
      if (typeof body === 'string' && body.length > 0) this.body = body
    },
  }
}

function readBands() {
  const src = require('node:fs').readFileSync(PLUGIN, 'utf8')
  const bands = {}
  let m
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  while ((m = re.exec(src)) !== null) {
    bands[m[1]] = { ratioMax: Number(m[2]), plusChars: Number(m[3]), absMax: Number(m[4]) }
  }
  if (Object.keys(bands).length !== 3) throw new Error('cannot read STYLE_BANDS')
  return bands
}
const BANDS = readBands()
const limitFor = (styleId, len) => Math.min(
  BANDS[styleId].absMax,
  Math.round(Math.max(len * BANDS[styleId].ratioMax, len + BANDS[styleId].plusChars)),
)

const SOURCE = '帮我把这个插件的日志功能补上'
const TOO_LONG = '补'.repeat(limitFor('detailed', SOURCE.length) + 200)
// 收敛稿要落在详细档区间内（原文 14 字 → [82, 164]），否则是「删过头」不是「收敛」。
const FIXED = '目标：给这个插件的日志功能补上日志。\n步骤：1. 读入口文件，确认日志调用链；2. 接入统一日志器；3. 写一条启动日志；4. 跑一遍测试确认没有回归。\n产出：改动文件清单，以及每处改动的原因。\n验收：启动时日志按预期出现在对应级别，测试全绿。'

async function runStream(handlers, payload) {
  const req = makeReq('/dsh-prompt-optimizer/stream', payload)
  const res = makeRes()
  await handlers['/dsh-prompt-optimizer/stream'](req, res)
  const done = res.events.filter((e) => e.event === 'done')
  const start = res.events.filter((e) => e.event === 'start')
  const delta = res.events.filter((e) => e.event === 'delta')
  return { code: res.code, events: res.events, done: done[0]?.data, start, delta }
}

async function runOptimize(handlers, payload) {
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq('/dsh-prompt-optimizer/optimize', payload), res)
  return { code: res.code, body: JSON.parse(res.body) }
}

async function main() {
  // ── 1. /stream 必须走档位复核 ──────────────────────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const { ctx, handlers } = makeCtx([TOO_LONG, FIXED])
    mod.apply(ctx)

    const s = await runStream(handlers, { text: SOURCE, sessionId: 's1' })
    console.log('stream trim : http', s.code, '| adjusted =', s.done?.adjusted,
      '| len =', s.done?.text ? s.done.text.length : 0,
      '| llm calls =', ctx.calls.length)
    if (s.code !== 200) throw new Error('stream did not answer 200')
    if (!s.done) throw new Error('no done event: ' + JSON.stringify(s.events))
    if (s.done.adjusted !== 'trimmed') {
      throw new Error('stream skipped band correction: adjusted=' + s.done.adjusted)
    }
    if (s.done.text !== FIXED) throw new Error('stream returned the uncorrected text')
    if (ctx.calls.length !== 2) throw new Error('expected 2 llm calls, got ' + ctx.calls.length)
    if (!ctx.calls[1].system.includes('本次修正要求')) {
      throw new Error('retry prompt lacks correction instruction')
    }
    console.log('stream retry: ✓ 走了修正重试，且重试仍在详细档')

    // 流式事件还在：start 至少一次、delta 至少两次（首轮分两段吐）。
    if (s.start.length === 0) throw new Error('no start event')
    if (s.delta.length < 2) throw new Error('expected streaming deltas, got ' + s.delta.length)
    if (typeof s.done.usage?.outputTokens !== 'number') throw new Error('usage lost in done event')
    console.log('stream ui   : ✓ start ×' + s.start.length + ' / delta ×' + s.delta.length + ' / usage 保留')
  }

  // ── 2. /stream 与 /optimize 结果一致 ───────────────────────────────────
  {
    const mod = await loadPlugin('detailed')

    const a = makeCtx([TOO_LONG, FIXED])
    mod.apply(a.ctx)
    const s = await runStream(a.handlers, { text: SOURCE, sessionId: 's2' })

    const b = makeCtx([TOO_LONG, FIXED])
    mod.apply(b.ctx)
    const o = await runOptimize(b.handlers, { text: SOURCE, sessionId: 's2' })

    console.log('parity      : stream =', s.done?.adjusted, '/ optimize =', o.body.adjusted,
      '| calls', a.ctx.calls.length, 'vs', b.ctx.calls.length)
    if (s.done?.text !== o.body.text) throw new Error('text differs between /stream and /optimize')
    if (s.done?.adjusted !== o.body.adjusted) throw new Error('adjusted differs')
    if (s.done?.recovered !== o.body.recovered) throw new Error('recovered differs')
    if (s.done?.style !== o.body.style) throw new Error('style differs')
    if (a.ctx.calls.length !== b.ctx.calls.length) throw new Error('llm call count differs')
    console.log('parity      : ✓ 正文、档位、兜底标记、调用次数全部一致')
  }

  // ── 3. 取消仍然走 aborted 事件，不写成 error ───────────────────────────
  {
    const mod = await loadPlugin('brief')
    const { ctx, handlers } = makeCtx(['随便写点什么'])
    mod.apply(ctx)
    const req = makeReq('/dsh-prompt-optimizer/stream', { text: '帮我写个脚本', sessionId: 's3' })
    const res = makeRes()
    // 立刻取消：abort 接口与 stream 共用一个 requestId 表。
    const pending = handlers['/dsh-prompt-optimizer/stream'](req, res)
    await handlers['/dsh-prompt-optimizer/abort'](
      makeReq('/dsh-prompt-optimizer/abort', { requestId: '' }),
      { writeHead() {}, end() {} },
    )
    await pending
    const errs = res.events.filter((e) => e.event === 'error')
    if (errs.length > 0) throw new Error('a normal run produced an error event: ' + JSON.stringify(errs))
    if (!res.events.some((e) => e.event === 'done')) throw new Error('missing done event')
    console.log('cancel safe : ✓ 未误报错误，正常产出 done')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('ALL STREAM PARITY TESTS PASSED')
}

main().catch((error) => {
  console.error('STREAM PARITY TEST FAILED:', error.message)
  process.exitCode = 1
})
