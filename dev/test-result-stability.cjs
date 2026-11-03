#!/usr/bin/env node
/**
 * test-result-stability.cjs —— 「用户看着它长出来的字，最后必须还是那份字」。
 *
 * 为什么专门写这一套：
 *   流式接口只给**第一次尝试**挂了 hooks（见 optimizeText 的注释），
 *   而后面两次补救 —— 过度扩写拉回、档位收敛/补齐 —— 都是静默跑的。
 *   于是界面上会出现这样一幕：正文一边流一边长，长到一半突然停住，
 *   等几秒，然后**整段换成另一份完全不同的正文**。
 *   对用户来说就是「优化结果突然变成了另一个优化结果」。
 *
 * 本测试锁住两条不变量：
 *   I1 末次 delta 必须等于 done.text —— 用户看到的最后一帧就是最终结果；
 *   I2 只要最终正文不是「一路流下来那版」，流里必须先有一条 revise 事件，
 *      说明「为什么要重写」—— 替换可以是必要的，但不能是无解释的。
 *
 * 用法：node dev/test-result-stability.cjs
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-result-stability')

let loadCounter = 0

async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
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
// 与 index.js 的 floorFor 同一公式：下限 = min(max(上限 × 0.5, 原文 + 20), 上限 - 1)。
const floorFor = (styleId, len) => {
  const limit = limitFor(styleId, len)
  return Math.min(Math.max(Math.round(limit * 0.5), len + 20), limit - 1)
}

// 任务类短句：会触发「档位收敛」这条补救路。
const SOURCE = '帮我把这个插件的日志功能补上'
const TOO_LONG = '补'.repeat(limitFor('detailed', SOURCE.length) + 200)
/*
 * 收敛稿必须**落在详细档区间内**（原文 14 字 → [82, 164]）。
 *
 * 早先这份只有 60 字，低于下限 —— 它之所以能当「收敛成功」，靠的是
 * 判据里的一个缺陷：只要比上一稿短就收，不管这一稿本身合不合格。
 * 那个缺陷已修（见 test-band-overshoot.cjs），测试数据也得跟着合格。
 */
const FIXED = '目标：给这个插件的日志功能补上日志。\n步骤：1. 读入口文件，确认日志调用链；2. 接入统一日志器；3. 写一条启动日志；4. 跑一遍测试确认没有回归。\n产出：改动文件清单，以及每处改动的原因。\n验收：启动时日志按预期出现在对应级别，测试全绿。'
// 一次写对、不需要任何补救的那份：长度落在详细档的 [下限, 上限] 之间。
const CLEAN = '目标：给这个插件补上日志功能。\n步骤：先读入口文件确认调用链，再接入统一日志器，最后跑一遍测试确认没有回归。\n产出：改动文件清单，以及每处改动的原因。\n验收：日志按预期出现在对应级别，测试全绿。'
// 拉回用例的第二份：必须短到不再触发档位收敛（balanced / 2 字输入的上限是 62）。
const SHORT_OK = '把这句话说清楚：确认要做的范围，说清最终产出。'

async function runStream(handlers, payload) {
  const res = makeRes()
  await handlers['/dsh-prompt-optimizer/stream'](makeReq('/dsh-prompt-optimizer/stream', payload), res)
  const pick = (name) => res.events.filter((e) => e.event === name)
  return {
    code: res.code,
    events: res.events,
    start: pick('start'),
    revise: pick('revise'),
    delta: pick('delta'),
    done: pick('done')[0]?.data,
  }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

function lastDelta(run) {
  return run.delta.length === 0 ? '' : String(run.delta[run.delta.length - 1].data.text)
}

async function main() {
  // ── 1. 需要档位收敛的一次：末帧必须就是最终结果 ────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const { ctx, handlers } = makeCtx([TOO_LONG, FIXED])
    mod.apply(ctx)
    const run = await runStream(handlers, { text: SOURCE, sessionId: 'st1' })

    if (!run.done) throw new Error('没有 done 事件：' + JSON.stringify(run.events))
    check('收敛生效（done.adjusted === trimmed）', run.done.adjusted === 'trimmed', String(run.done.adjusted))
    check('最终正文是收敛后的那份', run.done.text === FIXED, run.done.text.slice(0, 40))

    // I1：用户看到的最后一帧 == 最终结果。
    const last = lastDelta(run)
    check('I1 末次 delta 等于 done.text', last === run.done.text,
      '末帧 ' + last.length + ' 字 / 最终 ' + run.done.text.length + ' 字')

    // 换个说法：最终正文必须在流里出现过，不能只在 done 里空降。
    const seen = run.delta.some((e) => String(e.data.text) === run.done.text)
    check('I1 最终正文在流里出现过（不是空降）', seen,
      'delta 共 ' + run.delta.length + ' 帧')

    // I2：发生了替换，就必须有解释。
    const firstStreamed = String(run.delta[0]?.data.text || '')
    const replaced = firstStreamed !== '' && !run.done.text.startsWith(firstStreamed)
    if (replaced) {
      check('I2 替换前有 revise 事件', run.revise.length > 0, '没有 revise 事件')
      const reason = run.revise.length > 0 ? String(run.revise[0].data.reason || '') : ''
      check('I2 revise 说明了原因', reason.length > 0, 'reason 为空')
    } else {
      check('I2（本次未发生替换，跳过）', true)
    }
  }

  // ── 2. 一次写对：不该冒出 revise，末帧仍然对齐 ─────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const { ctx, handlers } = makeCtx([CLEAN])
    mod.apply(ctx)
    const run = await runStream(handlers, { text: SOURCE, sessionId: 'st2' })
    check('CLEAN 落在详细档区间内（测试数据自检）',
      CLEAN.length >= floorFor('detailed', SOURCE.length) && CLEAN.length <= limitFor('detailed', SOURCE.length),
      CLEAN.length + ' 字，区间 [' + floorFor('detailed', SOURCE.length) + ', ' + limitFor('detailed', SOURCE.length) + ']')
    check('一次写对时不重试（1 次模型调用）', ctx.calls.length === 1, String(ctx.calls.length))
    check('一次写对时不推 revise', run.revise.length === 0, String(run.revise.length))
    check('I1 末次 delta 等于 done.text', lastDelta(run) === run.done?.text, lastDelta(run).slice(0, 30))
  }

  // ── 3. 过度扩写拉回：同一条不变量 ──────────────────────────────────────
  {
    const mod = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['这句该被拉回'.padEnd(600, '啊'), SHORT_OK])
    mod.apply(ctx)
    const run = await runStream(handlers, { text: 'ok', sessionId: 'st3' })
    if (ctx.calls.length > 1) {
      check('I1 拉回后末次 delta 等于 done.text', lastDelta(run) === run.done?.text,
        '末帧 ' + lastDelta(run).length + ' 字 / 最终 ' + String(run.done?.text || '').length + ' 字')
      check('I2 拉回前有 revise 事件', run.revise.length > 0, '没有 revise 事件')
    } else {
      check('（本次未触发拉回，跳过）', true)
      check('（本次未触发拉回，跳过）', true)
    }
  }

  rmSync(TMP, { recursive: true, force: true })
  if (failures > 0) {
    console.error('RESULT STABILITY TEST FAILED: ' + failures + ' 条断言未通过')
    process.exitCode = 1
    return
  }
  console.log('ALL RESULT STABILITY TESTS PASSED')
}

main().catch((error) => {
  console.error('RESULT STABILITY TEST FAILED:', error.message)
  process.exitCode = 1
})
