/**
 * test-band-correction.cjs —— 验证「档位复核」真的会在引擎侧生效。
 *
 * 关键点：档位来自插件自己的设置文件（~/.dsh/prompt-optimizer/settings.json），
 * 请求体里并不带 style。所以测试用临时的 DSH_HOME 放一份指定档位的设置，
 * 再 import 插件 —— 模块顶层的 loadSettings() 会在 import 时读到它。
 *
 * 覆盖三个场景：
 *   1. 详细档返回超长输出 → 引擎带修正指令重试，adjusted='trimmed'；
 *   2. 均衡档只改了错别字 → 引擎重试补写，adjusted='expanded'；
 *   3. 一次到位 → 不重试，adjusted=null。
 * 另外验证重试始终用用户选的那一档（不会偷偷换档）。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-band-home')

// 自动模式要能解析出一个模型，否则引擎在跑到档位复核之前就停住了。

let loadCounter = 0

/** 用一份指定档位的设置加载一份全新的插件实例。 */
async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  // 兜底链末端会读 profile patch 里的默认模型；临时目录刚被清空，这里补一份桩
  //（见 stub-model.cjs）。放在 rm 之后，否则会被连同 TMP 一起删掉。
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
    const url = pathToFileURL(PLUGIN).href + `?v=${loadCounter}`
    return await import(url)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function makeCtx(scripts) {
  const calls = []
  const listeners = {}
  const handlers = {}
  const ctx = {
    calls,
    on(event, fn) {
      ;(listeners[event] ||= []).push(fn)
      return () => {}
    },
    effect(fn) {
      const result = fn()
      return result
    },
    webServer: {
      register(route) {
        handlers[route.path] = route.handler
        return () => {}
      },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      // 每次调用消耗 scripts 里的下一个返回值；用完重复最后一个。
      stream: (options) => {
        const next = scripts[Math.min(calls.length, scripts.length - 1)]
        calls.push({ system: options.system, input: options.messages[0].content[0].text })
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: next }
        })()
      },
    },
    get: () => undefined,
    sessions: undefined,
    agents: undefined,
    // C17 之后 host 半区会挂可选入口（commands / tools / provide）；
    // 这两个用例只关心改写逻辑，给空桩即可。
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers }
}

function makeReq(bodyText) {
  return {
    method: 'POST',
    url: '/dsh-prompt-optimizer/optimize',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(bodyText), 'utf8')
    },
  }
}

async function runOptimize(handlers, payload) {
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq(payload), res)
  return { code: res.code, body: JSON.parse(res.body) }
}

/**
 * 读出插件引擎里的长度规则，避免测试自己抄一份公式抄错。
 *
 * 引擎公式（index.js 的 STYLE_BANDS / lengthLimitFor）：
 *   上限 = min(absMax, round(max(原文长度 × 倍数, 原文长度 + 加字额度)))
 *   下限 = min(max(round(上限 × 0.5), 原文长度 + 20), 上限 - 1)
 */
function readBands() {
  const src = require('node:fs').readFileSync(PLUGIN, 'utf8')
  const bands = {}
  let m
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  while ((m = re.exec(src)) !== null) {
    bands[m[1]] = {
      ratioMax: Number(m[2]),
      plusChars: Number(m[3]),
      absMax: Number(m[4]),
    }
  }
  if (Object.keys(bands).length !== 3) throw new Error('cannot read STYLE_BANDS from plugin source')
  return bands
}

const BANDS = readBands()

function limitFor(styleId, len) {
  const band = BANDS[styleId]
  return Math.min(band.absMax, Math.round(Math.max(len * band.ratioMax, len + band.plusChars)))
}

function floorFor(styleId, len, limit) {
  const wanted = Math.max(Math.round(limit * 0.5), len + 20)
  return Math.min(wanted, limit - 1)
}

async function main() {
  // ── 场景 1：详细档返回超长输出 → 应被削短 ────────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const source = '帮我把这个插件的日志功能补上'
    const cap = limitFor('detailed', source.length)
    const tooLong = '补'.repeat(cap + 200)          // 明显超出详细档上限
    const fixed = '目标：补上日志功能。\n步骤：读入口、接入日志器、写一条日志、跑测试。\n产出：改动的文件清单。\n验收：测试通过且日志出现。'
    const { ctx, handlers } = makeCtx([tooLong, fixed])
    mod.apply(ctx)

    const r = await runOptimize(handlers, { text: source, sessionId: 's1' })
    console.log('trim case   : http', r.code, '| adjusted =', r.body.adjusted,
      '| len =', r.body.text ? r.body.text.length : 0, '| cap =', cap)
    if (r.code !== 200) throw new Error('trim case failed: ' + JSON.stringify(r.body))
    if (r.body.adjusted !== 'trimmed') {
      throw new Error('expected adjusted=trimmed, got ' + r.body.adjusted)
    }
    if (r.body.text !== fixed) throw new Error('expected the retried (shorter) text')
    if (ctx.calls.length !== 2) throw new Error('expected exactly 2 llm calls, got ' + ctx.calls.length)
    // 重试必须仍在详细档：system 里应含详细档独有的「去重与收紧」。
    if (!ctx.calls[1].system.includes('去重与收紧')) {
      throw new Error('retry did not stay in the detailed tier')
    }
    if (!ctx.calls[1].system.includes('本次修正要求')) {
      throw new Error('retry prompt lacks correction instruction')
    }
    console.log('trim retry  : ✓ stayed in detailed tier, carried correction instruction')
  }

  // ── 场景 2：均衡档只改了错别字 → 应被补写 ────────────────────────────
  {
    const mod = await loadPlugin('balanced')
    const source = '帮我把测试跑一下'
    const tooShort = '帮我把测试跑一下'            // 与原文几乎相同
    const expanded = '目标：把测试跑一遍。\n命令：运行测试脚本。\n产出：测试结果摘要。\n验收：贴出通过或失败的原文。'
    const { ctx, handlers } = makeCtx([tooShort, expanded])
    mod.apply(ctx)

    const r = await runOptimize(handlers, { text: source, sessionId: 's2' })
    console.log('expand case : http', r.code, '| adjusted =', r.body.adjusted,
      '| len =', r.body.text ? r.body.text.length : 0)
    if (r.code !== 200) throw new Error('expand case failed: ' + JSON.stringify(r.body))
    if (r.body.adjusted !== 'expanded') {
      throw new Error('expected adjusted=expanded, got ' + r.body.adjusted)
    }
    if (r.body.text !== expanded) throw new Error('expected the retried (longer) text')
    if (ctx.calls.length !== 2) throw new Error('expected exactly 2 llm calls, got ' + ctx.calls.length)
    if (!ctx.calls[1].system.includes('明确验收口径')) {
      throw new Error('retry did not stay in the balanced tier')
    }
    console.log('expand retry: ✓ stayed in balanced tier')
  }

  // ── 场景 3：一次到位 → 不重试，adjusted 为 null ───────────────────────
  {
    const mod = await loadPlugin('balanced')
    const source = '帮我把项目里的测试脚本跑一遍，确认没有报错，并把结果贴出来'
    const cap = limitFor('balanced', source.length)
    const floor = floorFor('balanced', source.length, cap)
    // 长度落在均衡档的区间内（下限 ≤ 长度 ≤ 上限）。
    const good = '目标：跑一遍测试脚本并确认结果。\n命令：运行仓库里的测试入口。\n产出：测试结果摘要，列出通过与失败的用例。\n验收：贴出命令的完整输出。'
    console.log('clean bounds: floor =', floor, '| cap =', cap, '| good len =', good.length)
    if (good.length < floor || good.length > cap) {
      throw new Error('fixture text must sit inside [floor, cap]: ' + good.length)
    }
    const { ctx, handlers } = makeCtx([good])
    mod.apply(ctx)

    const r = await runOptimize(handlers, { text: source, sessionId: 's3' })
    console.log('clean case  : http', r.code, '| adjusted =', r.body.adjusted,
      '| len =', r.body.text ? r.body.text.length : 0,
      '| llm calls =', ctx.calls.length)
    if (r.code !== 200) throw new Error('clean case failed: ' + JSON.stringify(r.body))
    if (r.body.adjusted !== null) throw new Error('expected adjusted=null, got ' + r.body.adjusted)
    if (ctx.calls.length !== 1) throw new Error('should not retry, calls = ' + ctx.calls.length)
    console.log('no retry    : ✓ one-shot result kept as-is')
  }

  // ── 场景 4：补写之后又超长 → 必须拒绝这次重试结果 ────────────────────
  //
  // 真实案发现场：13 字的提问「怎么配置 profile？」在均衡档被写成 93 字，
  // 上限只有 73。第一次判「过短」，重试后变成「过长」，旧逻辑只看长度有没有
  // 变大就接受了 —— 结果既没守住上限、还标成 expanded 骗过了复核。
  {
    const mod = await loadPlugin('balanced')
    const source = '怎么配置 profile？'
    const cap = limitFor('balanced', source.length)
    const overlong = '补'.repeat(cap + 30)          // 重试后又超长
    const { ctx, handlers } = makeCtx([source, overlong])
    mod.apply(ctx)

    const r = await runOptimize(handlers, { text: source, sessionId: 's4' })
    console.log('too-short→too-long: http', r.code, '| adjusted =', r.body.adjusted,
      '| len =', r.body.text ? r.body.text.length : 0, '| cap =', cap)
    if (r.code !== 200) throw new Error('case 4 failed: ' + JSON.stringify(r.body))
    if (r.body.adjusted === 'expanded') {
      throw new Error('accepted an over-long retry as expanded (len ' + r.body.text.length + ' > cap ' + cap + ')')
    }
    if (r.body.text.length > cap) {
      throw new Error('returned text exceeds the band cap: ' + r.body.text.length + ' > ' + cap)
    }
    console.log('over-long retry: ✓ rejected, kept the in-band original')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('\nBAND CORRECTION TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
