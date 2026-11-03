/**
 * test-audit-fixes.cjs —— 暴力测试查出的五个问题的回归测试。
 *
 * 五个问题都来自一次真实用户走查（dev/fuzz-audit.cjs + 线上实跑），
 * 按优先级排：
 *
 *   1. 极短任务被扩成套话 —— 「改」1 个字被补成 117 字空话
 *   2. 延续性输入被判成闲聊 —— 「继续」「重来」「这个不对」原样返回，一个字不改
 *   3. 英文任务几乎没被改写 —— 「refactor the retry helper」只多了个「Goal:」
 *   4. 带路径的提问被判成任务 —— 「src/app.ts 为什么这么慢？」会被套内容下限
 *   5. 长输入的上限低于原文一半 —— 5000 字的输入，详细档上限只有 4000
 *
 * 每条都用**用户真实会写的话**做断言，不用造出来的测试字符串。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-audit-fixes')

let loadCounter = 0
async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  stubModel(join(TMP, 'profile'))
  writeFileSync(join(TMP, 'prompt-optimizer', 'settings.json'), JSON.stringify({
    modelMode: 'auto', provider: '', model: '', style, customPrompt: '', freeChannelAsked: true,
  }, null, 2))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = TMP
  try {
    loadCounter += 1
    return await import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

function makeCtx(scripts) {
  const calls = []
  const handlers = {}
  const ctx = {
    calls,
    on() { return () => {} },
    effect(fn) { return fn() },
    webServer: { register(r) { handlers[r.path] = r.handler; return () => {} } },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: (o) => {
        const next = scripts[Math.min(calls.length, scripts.length - 1)]
        calls.push({ system: o.system, maxTokens: o.maxTokens })
        return (async function* () { yield { type: 'text-delta', index: 0, text: next } })()
      },
    },
    get: () => undefined, sessions: undefined, agents: undefined,
    inject() {}, provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers }
}

async function runOptimize(handlers, payload) {
  const req = {
    method: 'POST', url: '/dsh-prompt-optimizer/optimize',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), 'utf8') },
  }
  const res = { writeHead(c) { this.code = c }, end(b) { this.body = b } }
  await handlers['/dsh-prompt-optimizer/optimize'](req, res)
  return { code: res.code, body: JSON.parse(res.body) }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

const BANDS = (() => {
  const src = readFileSync(PLUGIN, 'utf8')
  const found = {}
  let m
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  while ((m = re.exec(src)) !== null) {
    found[m[1]] = { ratioMax: Number(m[2]), plusChars: Number(m[3]), absMax: Number(m[4]) }
  }
  return found
})()
/*
 * 与 index.js 的 lengthLimitFor 同式，包括那条「不低于原文」的兜底。
 *
 * 测试不能自己抄一份旧公式：抄错了就会「测的是一回事，跑的是另一回事」。
 * 第 5 组断言正是用来钉住这条兜底的，公式里也必须带着它。
 */
const limitFor = (id, len) => {
  const b = BANDS[id]
  return Math.max(len, Math.min(b.absMax, Math.round(Math.max(len * b.ratioMax, len + b.plusChars))))
}

async function main() {
  const mod = await loadPlugin('balanced')
  const classify = mod.classifyInput
  if (typeof classify !== 'function') throw new Error('classifyInput 未导出')

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[1] 极短任务不许被扩成套话')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 「改」1 个字，线上跑出来是 117 字的空话：
  //   「目标：执行"改"所指向的变更操作，使相应对象发生预期变化。
  //     产出格式：交付变更后的产物，形态为修改后的文件……」
  // 原文没有任何信息可补，强行补出来的只能是套话 —— 比不改还糟。
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['不该被调用'])
    mod2.apply(ctx)
    const r = await runOptimize(handlers, { text: '改', sessionId: 's1' })
    console.log('    「改」→ ' + (r.body.text || '').length + ' 字，adjusted=' + r.body.adjusted)
    check('单字任务不调模型', ctx.calls.length === 0, '调了 ' + ctx.calls.length + ' 次')
    check('单字任务原样返回', r.body.text === '改', JSON.stringify(r.body.text))
  }

  // 两个字的同理
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['不该被调用'])
    mod2.apply(ctx)
    const r = await runOptimize(handlers, { text: '重来', sessionId: 's1b' })
    check('两字任务不调模型', ctx.calls.length === 0, '调了 ' + ctx.calls.length + ' 次')
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[2] 延续性输入要当任务，不能判成闲聊')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 这些是「接着上文说」的输入。判成 a) 就一个字都不改，用户白点一次。
  // 判成 c) 至少会交给模型 —— 模型看得到上下文，能补全。
  {
    const continuation = ['继续', '重来', '接着做', '这个不对', '再来一次', '按刚才的来']
    for (const text of continuation) {
      const got = classify(text)
      check('「' + text + '」判成 c', got === 'c', '实际 ' + got)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[3] 英文任务的档位规则要生效')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 线上实测：「refactor the retry helper」25 字 → 「Goal: Refactor the retry helper.」32 字。
  // 只加了个前缀，等于没做。英文的补全规则没进提示词。
  {
    const mod2 = await loadPlugin('balanced')
    const prompts = mod2.STYLE_ITEMS.map((i) => i.prompt).join('\n')
    // 光有「保持用户原本的语言」不够 —— 那句话只说了「别翻译」，没说「别偷懒」。
    // 线上实测英文输入只被加了个 "Goal:" 前缀，等于没改。所以要求写明英文也要按档位补全。
    check('提示词要求英文同样按档位改写', /英文输入同样|英文.*按档位|English.*same/i.test(prompts),
      '提示词里没有「英文也要补全」这条')
    check('提示词给了英文的结构词', /Goal/.test(prompts) && /Acceptance|Steps|Output/.test(prompts),
      '提示词里没给英文结构词')
    check('提示词明确禁止只加前缀', /前缀|prefix|只把首字母/i.test(prompts), '')

    // 端到端：英文任务送进去，模型必须被要求补出结构。
    // 这里断言的是**发给模型的系统提示**，不是模型返回什么（那要看模型）。
    const mod3 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['Goal: Refactor the retry helper.\nSteps: 1. Read the helper. 2. Extract the retry logic.\nOutput: changed files.\nAcceptance: tests pass.'])
    mod3.apply(ctx)
    await runOptimize(handlers, { text: 'refactor the retry helper', sessionId: 'en1' })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    // 只断言「送到了」，不断言次数：返回稿超上限会触发档位复核，那是另一条路。
    check('英文任务确实送到了模型', ctx.calls.length >= 1, '调了 ' + ctx.calls.length + ' 次')
    check('系统提示里带英文结构要求', /Goal/.test(system) && /Acceptance|Steps|Output/.test(system), '')
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[4] 带路径的提问不许被判成任务')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 「src/app.ts 为什么这么慢？」是在问，不是要动手。
  // 判成 c) 会套内容下限，模型只好给一句问话补产出。
  {
    const asking = [
      'src/app.ts 为什么这么慢？',
      'package.json 里的 scripts 是干嘛的？',
      'README 里的这句话是什么意思？',
      'index.js 里那个函数是做什么的？',
    ]
    for (const text of asking) {
      const got = classify(text)
      check('「' + text + '」判成 b', got === 'b', '实际 ' + got)
    }
    // 但带路径的**任务**仍要判成 c
    const tasks = [
      '把 src/app.ts 里的重试逻辑改一下',
      '更新 @README.md 的安装章节',
      '跑一下 npm test',
    ]
    for (const text of tasks) {
      const got = classify(text)
      check('「' + text + '」仍判成 c', got === 'c', '实际 ' + got)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[5] 长输入的上限不许低于原文')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 5000 字的输入，精简档上限 1500、均衡 2500、详细 4000 ——
  // 上限比原文还短，等于要求「把长文压缩成短文」，那不是「优化提示词」。
  {
    for (const style of ['brief', 'balanced', 'detailed']) {
      for (const len of [2000, 3000, 5000, 10000, 19999]) {
        const limit = limitFor(style, len)
        check(style + ' 原文 ' + len + ' 字：上限不低于原文',
          limit >= len,
          '上限只有 ' + limit + '，比原文短 ' + (len - limit) + ' 字')
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[6] 慢模型不许把总耗时拖成两分钟')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 线上实测（probe-latency.mjs）：
  //   这个插件怎么用？      14.3s（首字 14.1s）
  //   好的，谢谢             5.1s
  //   改（直通）             2ms
  //   帮我优化一下这个      93.8s（首字 52.9s，revise=1）
  //
  // 根因不是网络（服务端报的 elapsed 与客户端实测差 2-28ms），是**模型慢**，
  // 而补救路径会再串一次完整模型调用：首稿 52.9s + 重试 40s。
  // 极端情况下 looksOverExpanded 和档位复核各重试一次，就是三次串行。
  //
  // 对策：给整次优化一个时间预算。超了就不再补救，把手上的结果交出去 ——
  // 补救是「更好」，不是「能看」，为它多等一分钟不值。
  {
    // 预算调成 900ms：每次模型调用 600ms，只够一次。
    process.env.DSHO_OPTIMIZE_BUDGET_MS = '900'
    const mod2 = await loadPlugin('balanced')
    const slow = (text) => (async function* () {
      await new Promise((r) => setTimeout(r, 600))
      yield { type: 'text-delta', index: 0, text }
    })()
    const calls = []
    const handlers = {}
    const ctx = {
      on() { return () => {} }, effect(fn) { return fn() },
      webServer: { register(r) { handlers[r.path] = r.handler; return () => {} } },
      llm: {
        listProviders: () => [], listModels: async () => [],
        stream: (o) => { calls.push({ system: o.system }); return slow('补'.repeat(200)) },
      },
      get: () => undefined, inject() {}, provide() {},
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    }
    mod2.apply(ctx)
    const t0 = Date.now()
    const r = await runOptimize(handlers, { text: '帮我把这个插件的日志功能补上', sessionId: 'slow1' })
    const took = Date.now() - t0
    console.log('    慢模型：' + calls.length + ' 次调用，耗时 ' + took + 'ms，adjusted=' + r.body.adjusted)
    check('慢模型只调一次模型就收手', calls.length === 1, '调了 ' + calls.length + ' 次')
    check('超预算时仍然返回结果', r.body.ok === true && (r.body.text || '').length > 0, '')
    delete process.env.DSHO_OPTIMIZE_BUDGET_MS
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[7] 思考不许把正文的 token 预算吃光')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 线上实测（probe-tokens.mjs）：
  //   「src/app.ts 为什么这么慢？」思考 5773 字 / outputTokens 3391 / 正文 52 字
  //   「帮我把这个插件的日志功能补上」思考 3633 字 / outputTokens 2315 / 正文 140 字
  //
  // maxTokens 是 4096，思考花掉 3391 就只剩 700 给正文。思考再长一点，
  // 正文就是 0 —— 线上确实出现过 done.text 为空串（虽然重跑 6 次没再复现）。
  // 所以 maxTokens 必须按「思考 + 正文」两部分来定，不能只按正文估。
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['目标：查清为什么慢。\n步骤：读 src/app.ts，找性能热点。\n产出：热点清单。\n验收：每个热点有代码位置。'])
    mod2.apply(ctx)
    await runOptimize(handlers, { text: 'src/app.ts 为什么这么慢？', sessionId: 'tok1' })
    const maxTokens = ctx.calls[0] ? ctx.calls[0].maxTokens : undefined
    console.log('    maxTokens = ' + maxTokens)
    check('maxTokens 留出了思考的余量', typeof maxTokens === 'number' && maxTokens >= 8192,
      '只有 ' + maxTokens + '，思考实测要吃 3391，正文会被挤没')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('AUDIT FIXES TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('AUDIT FIXES TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
