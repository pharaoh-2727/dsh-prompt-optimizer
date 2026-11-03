/**
 * test-input-kind.cjs —— 验证「这是提问还是任务」的判据与提示词一致。
 *
 * 背景：引擎过去用一个上百词的巨型正则 TASK_HINT 判断「输入要不要展开」。
 * 那个正则把 如何|怎么|为什么|能否|配置|插件|解释|分析 全算成任务信号，
 * 于是**所有中文疑问句都被判成任务**，接着被套上长度下限：
 *
 *   怎么配置 profile？（13 字）→ 均衡档下限 47 字
 *   → 模型照着提示词的正例写（38 字）→ 判 too-short → 重试「至少 47 字」
 *   → 模型只能编出「产出 / 验收」→ 编出来的稿子长度合格 → 被收下，标成 expanded
 *
 * 提示词早就写好了判据（shared-common.txt 第 17 行）：
 *   只要需要 DSH 读写文件、跑命令或查看工作区才能推进，一律算 c)；
 *   只有不需要接触工作区的纯知识问答才算 b)。
 * 这份测试就是拿提示词的判据当权威，逐条钉住引擎侧的行为。
 *
 * 关键断言用的是**提示词文件里现成的正例**（balanced.txt 的「正确输出」），
 * 不是测试自己编的期望值 —— 免得变成同义反复。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-input-kind')

/* ---------- 从引擎源码读长度规则，避免测试自己抄一份公式抄错 ---------- */
const BANDS = (() => {
  const src = readFileSync(PLUGIN, 'utf8')
  const found = {}
  let m
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  while ((m = re.exec(src)) !== null) {
    found[m[1]] = { ratioMax: Number(m[2]), plusChars: Number(m[3]), absMax: Number(m[4]) }
  }
  if (Object.keys(found).length !== 3) throw new Error('cannot read STYLE_BANDS from plugin source')
  return found
})()

function limitFor(styleId, len) {
  const band = BANDS[styleId]
  return Math.min(band.absMax, Math.round(Math.max(len * band.ratioMax, len + band.plusChars)))
}
function floorFor(styleId, len, limit) {
  return Math.min(Math.max(Math.round(limit * 0.5), len + 20), limit - 1)
}

/**
 * 把一段基准文字补到档位区间内。
 *
 * 长度断言不能靠手数：改了 STYLE_BANDS 就会漂。这里按公式算，补到 [floor, cap] 里，
 * 并在越界时直接报错 —— 测试数据自己不合格时，不能悄悄绿过去。
 */
function fitIntoBand(base, floor, cap, label) {
  if (base.length > cap) throw new Error(label + ': fixture base too long (' + base.length + ' > ' + cap + ')')
  let text = base
  while (text.length < floor) text += '，补充说明这一项的来源与做法'
  if (text.length > cap) throw new Error(label + ': fixture overflowed the cap (' + text.length + ' > ' + cap + ')')
  return text
}

let loadCounter = 0
async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  stubModel(join(TMP, 'profile'))
  writeFileSync(
    join(TMP, 'prompt-optimizer', 'settings.json'),
    JSON.stringify({
      modelMode: 'auto', provider: '', model: '', style, customPrompt: '', freeChannelAsked: true,
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
    on() { return () => {} },
    effect(fn) { return fn() },
    webServer: { register(route) { handlers[route.path] = route.handler; return () => {} } },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
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
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers }
}

function makeReq(payload) {
  return {
    method: 'POST',
    url: '/dsh-prompt-optimizer/optimize',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload), 'utf8')
    },
  }
}

async function runOptimize(handlers, payload) {
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq(payload), res)
  return { code: res.code, body: JSON.parse(res.body) }
}

/** 一条用例：喂两次脚本化返回，看引擎收下哪一份。 */
async function runCase(spec) {
  const mod = await loadPlugin(spec.style)
  const { ctx, handlers } = makeCtx(spec.scripts)
  mod.apply(ctx)
  const r = await runOptimize(handlers, { text: spec.source, sessionId: 'kind-' + spec.name })
  if (r.code !== 200) throw new Error(spec.name + ': http ' + r.code + ' ' + JSON.stringify(r.body))
  return { body: r.body, calls: ctx.calls }
}

const CASES = []

/* ── 1. b) 类提问：模型照着提示词正例写，引擎不许把它退回重写 ─────────────
 *
 * 正例取自 balanced.txt 的「正确输出」一行，38 字，落在均衡档下限之下。
 * 旧引擎会判 too-short 并重试；重试稿编了「产出」，长度刚好合格 —— 于是
 * 一份好稿被一份编出来的稿替换掉。这条用例就是要它别换。
 */
CASES.push({
  name: 'b 类提问 · 提示词自己的正例不许被换掉',
  style: 'balanced',
  source: '怎么配置 profile？',
  scripts: [
    'profile 怎么配置？需要改哪个文件、填哪些项，给出可直接照着做的步骤。',
    fitIntoBand('目标：说明 profile 的配置方法。',
      floorFor('balanced', '怎么配置 profile？'.length, limitFor('balanced', '怎么配置 profile？'.length)),
      limitFor('balanced', '怎么配置 profile？'.length),
      'case1 编造稿'),
  ],
  expectAdjusted: null,
  expectCalls: 1,
  expectTextIsFirst: true,
})

/* ── 2. b) 类提问：模型自己就编了，引擎也不许把它标成「已补齐」 ──────────── */
CASES.push({
  name: 'b 类提问 · 编出来的产出不许被标成 expanded',
  style: 'balanced',
  source: '为什么我的插件不生效？',
  scripts: [
    fitIntoBand('目标：排查插件不生效的原因。',
      floorFor('balanced', '为什么我的插件不生效？'.length, limitFor('balanced', '为什么我的插件不生效？'.length)),
      limitFor('balanced', '为什么我的插件不生效？'.length),
      'case2 编造稿'),
    '不该被用到',
  ],
  expectAdjusted: null,
  expectCalls: 1,
  expectTextIsFirst: true,
})

/* ── 3. 详细档同样：提问不该被套上 82 字的内容下限 ──────────────────────── */
CASES.push({
  name: 'b 类提问 · 详细档不设内容下限',
  style: 'detailed',
  source: '为什么我的插件不生效？',
  scripts: [
    '插件没生效通常是因为没重载：改完要刷新宿主，再看日志里有没有注册成功的记录。',
    '不该被用到',
  ],
  expectAdjusted: null,
  expectCalls: 1,
  expectTextIsFirst: true,
})

/* ── 4. c) 类任务：提示词明说的边界例子「看看我的 profile 配得对不对」────── */
CASES.push({
  name: 'c 类任务 · 要看工作区的提问仍按下限补写',
  style: 'balanced',
  source: '看看我的 profile 配得对不对',
  scripts: [
    '看看我的 profile 配得对不对',
    fitIntoBand('目标：检查 profile 配置是否正确。',
      floorFor('balanced', '看看我的 profile 配得对不对'.length, limitFor('balanced', '看看我的 profile 配得对不对'.length)),
      limitFor('balanced', '看看我的 profile 配得对不对'.length),
      'case4 补写稿'),
  ],
  expectAdjusted: 'expanded',
  expectCalls: 2,
  expectTextIsFirst: false,
})

/* ── 5. c) 类任务：带动作动词的请求，行为必须保持不变 ───────────────────── */
CASES.push({
  name: 'c 类任务 · 帮我跑测试仍按下限补写',
  style: 'balanced',
  source: '帮我把测试跑一下',
  scripts: [
    '帮我把测试跑一下',
    fitIntoBand('目标：跑一遍测试并贴出结果。',
      floorFor('balanced', '帮我把测试跑一下'.length, limitFor('balanced', '帮我把测试跑一下'.length)),
      limitFor('balanced', '帮我把测试跑一下'.length),
      'case5 补写稿'),
  ],
  expectAdjusted: 'expanded',
  expectCalls: 2,
  expectTextIsFirst: false,
})

/* ── 6. c) 类任务：带仓库内路径，判据必须认得出来 ───────────────────────── */
CASES.push({
  name: 'c 类任务 · 带路径的请求仍按下限补写',
  style: 'balanced',
  source: '把 src/app.ts 里的重试逻辑改一下',
  scripts: [
    '把 src/app.ts 里的重试逻辑改一下',
    fitIntoBand('目标：改掉 src/app.ts 里的重试逻辑。',
      floorFor('balanced', '把 src/app.ts 里的重试逻辑改一下'.length, limitFor('balanced', '把 src/app.ts 里的重试逻辑改一下'.length)),
      limitFor('balanced', '把 src/app.ts 里的重试逻辑改一下'.length),
      'case6 补写稿'),
  ],
  expectAdjusted: 'expanded',
  expectCalls: 2,
  expectTextIsFirst: false,
})

/**
 * 判据语料。
 *
 * 前 8 条是旧词表全部误判成 c) 的中文疑问句 —— 它们正是这次要修的东西，
 * 所以逐条钉住。末尾几条是提示词文件里现成的边界例子，不能自己另编一套。
 */
const CORPUS = [
  // b) 提问：只问做法，公共规则明令「问什么就还问什么」
  ['怎么配置 profile？', 'b'],
  ['如何安装这个插件？', 'b'],
  ['为什么我的插件不生效？', 'b'],
  ['能不能解释一下这个报错是什么意思？', 'b'],
  ['profile 和插件有什么区别？', 'b'],
  ['为什么同一个对话换模型会变慢？', 'b'],
  ['这个配置项是什么意思？', 'b'],
  ['怎么理解 cordis 的 effect？', 'b'],
  ['同一个对话里固定用同一个模型是不是更省？', 'b'],
  ['什么是 cordis？', 'b'],
  ['how do I configure the profile?', 'b'],
  // a) 寒暄 / 陈述
  ['好的', 'a'],
  ['谢谢', 'a'],
  ['完成得很好', 'a'],
  ['就这样', 'a'],
  ['ok', 'a'],
  // c) 任务：提示词里的两个边界例子
  ['看看我的 profile 配得对不对', 'c'],
  ['帮我把测试跑一下', 'c'],
  // c) 任务：其余常见形态
  ['把 index.js 里的 TASK_HINT 改掉', 'c'],
  ['给我写个登录页', 'c'],
  ['把这个报错修掉', 'c'],
  ['帮我把这个插件的日志功能补上', 'c'],
  ['把 src/app.ts 里的重试逻辑改一下', 'c'],
  ['改一下 @path with space/file.ts 这个文件', 'c'],
  ['帮我写个脚本', 'c'],
  ['帮我跑一下测试脚本', 'c'],
  ['运行 npm test', 'c'],
  ['检查一下 git status', 'c'],
  ['解释一下这个报错：TypeError: x is not a function', 'c'],
  ['重构 client.js', 'c'],
  ['refactor the retry helper and add a regression test', 'c'],
  ['🔧 帮我修一下这个 bug 🐛', 'c'],
  ['改', 'c'],
  ['   把这段改清楚   ', 'c'],
  ['能不能帮我改一下这个文件？', 'c'],
  ['在 ~/.dsh/plugins 下面加一个文件', 'c'],
]

async function checkCorpus(mod) {
  if (typeof mod.classifyInput !== 'function') {
    throw new Error('插件没有导出 classifyInput，判据没法直接钉住')
  }
  let bad = 0
  for (const [text, want] of CORPUS) {
    const got = mod.classifyInput(text)
    if (got !== want) {
      bad += 1
      console.error('    XX ' + JSON.stringify(text) + ' → ' + got + '，期望 ' + want)
    }
  }
  if (bad > 0) throw new Error('判据语料 ' + bad + ' / ' + CORPUS.length + ' 条不符')
  console.log('')
  console.log('判据语料    : ✓ ' + CORPUS.length + ' 条（b 类提问 ' + CORPUS.filter((c) => c[1] === 'b').length
    + ' / a 类 ' + CORPUS.filter((c) => c[1] === 'a').length
    + ' / c 类 ' + CORPUS.filter((c) => c[1] === 'c').length + '）')
}

async function main() {
  console.log('均衡档区间 :', JSON.stringify(BANDS))
  await checkCorpus(await loadPlugin('balanced'))
  let passed = 0
  for (const spec of CASES) {
    const { body, calls } = await runCase(spec)
    const got = body.adjusted
    const okAdjusted = got === spec.expectAdjusted
    const okCalls = calls.length === spec.expectCalls
    const firstScript = spec.scripts[0]
    const okText = spec.expectTextIsFirst ? body.text === firstScript : body.text !== firstScript
    console.log('')
    console.log('· ' + spec.name)
    console.log('    输入 ' + spec.source.length + ' 字 | 档位 ' + spec.style
      + ' | 区间 [' + floorFor(spec.style, spec.source.length, limitFor(spec.style, spec.source.length))
      + ', ' + limitFor(spec.style, spec.source.length) + ']')
    console.log('    首稿 ' + firstScript.length + ' 字 | 结果 ' + (body.text ? body.text.length : 0) + ' 字'
      + ' | adjusted=' + got + ' | 调用 ' + calls.length + ' 次')
    if (!okAdjusted) throw new Error(spec.name + ': adjusted 期望 ' + spec.expectAdjusted + '，实际 ' + got)
    if (!okCalls) throw new Error(spec.name + ': 期望调用 ' + spec.expectCalls + ' 次，实际 ' + calls.length + ' 次')
    if (!okText) {
      throw new Error(spec.name + ': 收下的正文不对（期望'
        + (spec.expectTextIsFirst ? '首稿' : '重试稿') + '）')
    }
    passed += 1
  }
  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  console.log('INPUT KIND TEST PASSED （' + passed + ' 条用例）')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
