/**
 * test-fallback-options.cjs —— 优化失败时，别只丢一句错误给用户。
 *
 * 线上真实的失败长什么样：
 *   1. 取不到模型（没在设置里选过、profile 里也没有默认模型）
 *      →「取不到可用模型。请到「设置 → 优化」选择模型……」
 *   2. 免费通道密钥无效 → 回退到对话模型，回退不了才报错
 *   3. 模型返回空 →「模型没有返回内容，请重试」
 *   4. 超长 →「内容过长（N 字符），请精简到 4000 以内」
 *
 * 这些错误的共同点是：**用户看完了不知道下一步该点什么。**
 * 文案说「请到设置里选模型」，但设置在哪、要不要重试、能不能换个档 ——
 * 全靠用户自己琢磨。
 *
 * 这里给每次失败配一组备选动作：每个都有 label + kind，客户端照着渲染按钮。
 * 关键是**只给真的能做的**：
 *   - 没配模型时给「去选模型」，不给「重试」（重试还是同一个错）
 *   - 超长时给「精简到 N 字」和「换精简档」，不给「去选模型」
 *   - 未知错误才给「重试」
 *
 * 四条必须成立：
 *   1. 每次失败都带 options（哪怕是空数组，不能是 undefined）
 *   2. options 里每一项都有可用的 label 与 kind
 *   3. kind 是固定集合里的值（客户端只认这几个，多一个就渲染不出来）
 *   4. 错的建议不许给：没配模型不给「重试」，超长不给「去选模型」
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-fallback')

let loadCounter = 0
async function loadPlugin(withModel) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  // 不写 stub-model 就是「一个模型都没有」的环境。
  if (withModel) {
    mkdirSync(join(TMP, 'profile'), { recursive: true })
    writeFileSync(join(TMP, 'profile', 'cordis.patch.yml'),
      '- id: agent-default-model\n  config:\n    provider: test-provider\n    model: test-model\n')
  }
  writeFileSync(join(TMP, 'prompt-optimizer', 'settings.json'), JSON.stringify({
    modelMode: 'auto', provider: '', model: '', style: 'balanced',
    customPrompt: '', freeChannelAsked: true,
  }, null, 2))
  const prev = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE_DIR }
  process.env.DSH_HOME = TMP
  process.env.DSH_PROFILE_DIR = join(TMP, 'profile')
  try {
    loadCounter += 1
    return await import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
  } finally {
    if (prev.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev.home
    if (prev.profile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev.profile
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
      listProviders: () => [], listModels: async () => [],
      stream: (o) => {
        const next = scripts[Math.min(calls.length, scripts.length - 1)]
        calls.push({ system: o.system })
        return (async function* () { yield { type: 'text-delta', index: 0, text: next } })()
      },
    },
    get: () => undefined, inject() {}, provide() {},
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
  let body = {}
  try { body = JSON.parse(res.body) } catch { body = { raw: res.body } }
  return { code: res.code, body }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

/** 客户端只认这几种动作；多一种就渲染不出来。 */
const KINDS = new Set(['retry', 'pick-model', 'shorten', 'switch-style', 'open-settings', 'report'])

function checkOptions(label, body) {
  const opts = body.options
  check(label + '：带 options 字段', Array.isArray(opts), '拿到的是 ' + typeof opts)
  if (!Array.isArray(opts)) return []
  check(label + '：不是空数组', opts.length > 0, '一个建议都没给')
  for (const [i, item] of opts.entries()) {
    check(label + '：第 ' + (i + 1) + ' 项有 label',
      item && typeof item.label === 'string' && item.label.trim().length > 0, JSON.stringify(item))
    check(label + '：第 ' + (i + 1) + ' 项的 kind 在允许集合里',
      item && KINDS.has(item.kind), JSON.stringify(item && item.kind))
  }
  return opts
}

const GOOD = '目标：更新 README 的安装章节，把 Node 版本要求与三条安装步骤写清楚。\n产出：改好的安装章节正文。\n验收：照这三步能装好，不出现原文没有的依赖。'

async function main() {
  console.log('\n[1] 取不到模型：建议「去选模型」，不建议「重试」')
  {
    const mod = await loadPlugin(false)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const out = await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 'f1' })
    check('确实失败了', out.body.ok === false, JSON.stringify(out.body).slice(0, 120))
    const opts = checkOptions('取不到模型', out.body)
    const kinds = opts.map((o) => o.kind)
    check('给了「去选模型」', kinds.includes('pick-model') || kinds.includes('open-settings'),
      JSON.stringify(kinds))
    check('不给「重试」（重试还是同一个错）', !kinds.includes('retry'), JSON.stringify(kinds))
  }

  console.log('\n[2] 超长：建议「精简」或「换精简档」，不建议「去选模型」')
  {
    const mod = await loadPlugin(true)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const long = 'x'.repeat(20001)
    const out = await runOptimize(handlers, { text: long, sessionId: 'f2' })
    check('确实失败了', out.body.ok === false, JSON.stringify(out.body).slice(0, 120))
    check('错误码是 TOO_LONG', out.body.code === 'TOO_LONG', String(out.body.code))
    const opts = checkOptions('超长', out.body)
    const kinds = opts.map((o) => o.kind)
    check('给了「精简」或「换档」', kinds.includes('shorten') || kinds.includes('switch-style'),
      JSON.stringify(kinds))
    check('不给「去选模型」（跟模型无关）',
      !kinds.includes('pick-model') && !kinds.includes('open-settings'), JSON.stringify(kinds))
  }

  console.log('\n[3] 模型返回空：建议「重试」')
  {
    const mod = await loadPlugin(true)
    const { ctx, handlers } = makeCtx([''])
    mod.apply(ctx)
    const out = await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 'f3' })
    check('确实失败了', out.body.ok === false, JSON.stringify(out.body).slice(0, 120))
    const opts = checkOptions('模型返回空', out.body)
    check('给了「重试」', opts.map((o) => o.kind).includes('retry'), JSON.stringify(opts.map((o) => o.kind)))
  }

  console.log('\n[4] 空输入：带 options 且不建议重试')
  {
    const mod = await loadPlugin(true)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const out = await runOptimize(handlers, { text: '   ', sessionId: 'f4' })
    check('确实失败了', out.body.ok === false, JSON.stringify(out.body).slice(0, 120))
    const opts = checkOptions('空输入', out.body)
    check('不给「重试」', !opts.map((o) => o.kind).includes('retry'), JSON.stringify(opts.map((o) => o.kind)))
  }

  console.log('\n[5] 成功结果不许带 options（那是失败时才有的东西）')
  {
    const mod = await loadPlugin(true)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const out = await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 'f5' })
    check('这次成功了', out.body.ok === true, JSON.stringify(out.body).slice(0, 120))
    check('成功结果不带 options', out.body.options === undefined || out.body.options === null,
      JSON.stringify(out.body.options))
  }

  console.log('\n[6] 每个建议都必须是可执行的一句话，不是空话')
  {
    const mod = await loadPlugin(false)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const out = await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 'f6' })
    const opts = Array.isArray(out.body.options) ? out.body.options : []
    for (const [i, item] of opts.entries()) {
      check('第 ' + (i + 1) + ' 项的 label 不是「请重试」这类空话',
        !/^请?重试$|^确定$|^好的$/u.test(item.label), JSON.stringify(item.label))
      check('第 ' + (i + 1) + ' 项的 label 不超过 20 字',
        item.label.length <= 20, item.label + ' (' + item.label.length + ' 字)')
    }
  }

  console.log('\n[7] 流式那条路也要带 options')
  {
    const mod = await loadPlugin(false)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    const events = []
    const req = {
      method: 'POST', url: '/dsh-prompt-optimizer/stream',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ text: '把 README 的安装章节更新一下', sessionId: 'f7' }), 'utf8')
      },
    }
    const res = {
      writeHead() {},
      write(chunk) { events.push(String(chunk)) },
      end() {},
    }
    await handlers['/dsh-prompt-optimizer/stream'](req, res)
    const errEvent = events.find((e) => e.startsWith('event: error'))
    check('推了 error 事件', errEvent !== undefined, events.length + ' 条事件')
    if (errEvent !== undefined) {
      const dataLine = errEvent.split('\n').find((l) => l.startsWith('data: ')) || ''
      let data = {}
      try { data = JSON.parse(dataLine.slice(6)) } catch { data = {} }
      check('error 事件带 options', Array.isArray(data.options), '拿到的是 ' + typeof data.options)
      if (Array.isArray(data.options)) {
        check('error 事件的 options 非空', data.options.length > 0, '空的')
      }
    }
  }

  if (failures > 0) {
    console.log('\n' + failures + ' 项未通过')
    process.exit(1)
  }
  console.log('\nALL FALLBACK OPTIONS TESTS PASSED')
}

main().catch((err) => { console.error(err); process.exit(1) })
