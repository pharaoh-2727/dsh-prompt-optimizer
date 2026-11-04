/**
 * test-clarify.cjs —— 信息不足的任务，先问一句，别硬改。
 *
 * 问题（线上实测）：
 *   「帮我优化一下这个」跑 8 次，0~2 次拿回来的就是原文，其余几次产出的是
 *   「目标：优化这个。」这类同义反复 —— 原文没有说清「这个」是什么，
 *   模型只能猜，猜出来的都是废话。
 *
 * 所有在模型侧做的补救（重试、目标字数、unchanged 标记）都治不了它：
 * **输入本来就缺信息，模型再努力也补不出来。**
 *
 * 做法：认出「对象只有一个指示代词」的输入，不调模型，直接返回一组追问，
 * 让用户点选。产品上承认「这条不够」，比假装能改要好。
 *
 * 只对任务类（c）这么做。提问（b）和寒暄（a）本来就不需要对象。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-clarify')

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
  return { code: res.code, body: JSON.parse(res.body) }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

async function main() {
  const mod = await loadPlugin('balanced')
  const needsClarify = mod.needsClarification
  if (typeof needsClarify !== 'function') {
    console.error('needsClarification 未导出')
    process.exit(1)
  }

  console.log('\n[1] 只有指示代词当对象 → 要问')
  for (const text of [
    '帮我优化一下这个',
    '把那个改一下',
    '优化一下这段',
    '帮我改改这个吧',
    '整理一下那个',
    '这个帮我弄一下',
  ]) {
    check('「' + text + '」要追问', needsClarify(text) === true, '判成了不用问')
  }

  console.log('\n[2] 有具体对象 → 不要问')
  for (const text of [
    '把 README 的安装章节更新一下',
    '帮我把这个插件的日志功能补上',
    '帮我写个登录页',
    '把 src/app.ts 里的重试逻辑改一下',
    '跑一下 npm test',
    '别用 any',
    '压到 500 字以内',
    '用 TypeScript 重写',
    '运行时报错 TypeError: x is not a function，帮我修掉',
    '我需要你帮我把项目里的测试全部跑一遍，然后把失败的用例整理成一个清单',
  ]) {
    check('「' + text + '」不要问', needsClarify(text) === false, '判成了要问')
  }

  console.log('\n[3] 提问与寒暄 → 不要问（它们本来就不需要对象）')
  for (const text of ['这个插件怎么用？', '怎么配置 profile？', '好的，谢谢', '继续',
    // 延续性输入：对象在上下文里（上一轮的产物），不缺信息。
    '这个不对', '这里错了', '重来', '接着做']) {
    check('「' + text + '」不要问', needsClarify(text) === false, '判成了要问')
  }

  console.log('\n[4] 极端输入不许抛异常')
  for (const text of ['', '   ', '\n\n', '。', '？？？', 'a'.repeat(20000), '😀', '\u0000']) {
    let got
    try { got = needsClarify(text) } catch (e) {
      check('极端输入 ' + JSON.stringify(String(text).slice(0, 12)) + ' 不抛异常', false, e.message)
      continue
    }
    check('极端输入 ' + JSON.stringify(String(text).slice(0, 12)) + ' 返回布尔', typeof got === 'boolean', String(got))
  }

  console.log('\n[5] 端到端：要问的时候不调模型')
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['不该被调用'])
    mod2.apply(ctx)
    const r = await runOptimize(handlers, { text: '帮我优化一下这个', sessionId: 'c1' })
    console.log('    模型调用 ' + ctx.calls.length + ' 次 | ok=' + r.body.ok + ' | needsClarification=' + r.body.needsClarification)
    check('不调模型', ctx.calls.length === 0, '调了 ' + ctx.calls.length + ' 次')
    check('返回 ok', r.body.ok === true, JSON.stringify(r.body).slice(0, 120))
    check('带 needsClarification 标记', r.body.needsClarification === true, String(r.body.needsClarification))
    check('给出追问列表', Array.isArray(r.body.questions) && r.body.questions.length >= 2,
      JSON.stringify(r.body.questions))
    check('text 字段是原文（别把空串塞给界面）', typeof r.body.text === 'string' && r.body.text.length > 0, JSON.stringify(r.body.text))
  }

  console.log('\n[6] 端到端：不要问的时候照常调模型')
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['目标：更新 @README.md 的安装章节。\n产出格式：改好的章节。\n验收标准：安装步骤能照着做。'])
    mod2.apply(ctx)
    const r = await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 'c2' })
    check('调了模型', ctx.calls.length >= 1, '没调模型')
    check('没有 needsClarification 标记', r.body.needsClarification !== true, String(r.body.needsClarification))
    check('正常返回改写稿', typeof r.body.text === 'string' && r.body.text.length > 0, '')
  }

  console.log('\n[7] 追问内容要具体可用（不是「请补充更多信息」这种空话）')
  {
    const mod2 = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['不该被调用'])
    mod2.apply(ctx)
    const r = await runOptimize(handlers, { text: '帮我优化一下这个', sessionId: 'c3' })
    const qs = r.body.questions || []
    const all = qs.map((q) => (typeof q === 'string' ? q : JSON.stringify(q))).join(' ')
    console.log('    追问: ' + all.slice(0, 200))
    check('问到「对象是什么」', /对象|哪个|哪段|什么内容|指的是/u.test(all), all.slice(0, 100))
    check('问到「往哪个方向改」', /方向|改成什么|怎么改|目标|目的/u.test(all), all.slice(0, 100))
    check('至少两个问题', qs.length >= 2, String(qs.length))
  }

  console.log('\n[8] 六个入口都要能表达「先问一句」')
  {
    /*
     * 只修好按钮这一条路不够：斜杠命令、工具、服务都是用户会碰到的入口。
     * 它们如果照旧把原文当结果交出去，用户会以为改写失败了。
     */
    const mod2 = await loadPlugin('balanced')
    const commands = {}
    const toolsReg = {}
    const provided = {}
    const ctx = {
      on() { return () => {} }, effect(fn) { return fn() },
      webServer: { register() { return () => {} } },
      inject(names, fn) {
        if (names.includes('tools')) fn({ effect(f) { f() }, tools: { register(d) { toolsReg[d.name] = d; return () => {} } } })
        if (names.includes('commands')) fn({ effect(f) { f() }, commands: { register(d) { commands[d.definitionId || d.name] = d; return () => {} } } })
        if (names.includes('services')) fn({ effect(f) { f() }, provide(n, v) { services[n] = v } })
      },
      get: () => undefined,
      provide(name, value) { provided[name] = value },
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    }
    mod2.apply(ctx)

    const cmd = Object.values(commands)[0]
    check('注册了斜杠命令', cmd !== undefined, '没有命令')
    if (cmd) {
      const out = await cmd.handler({ rawInput: '帮我优化一下这个' })
      check('斜杠命令说明「没说清」', /没说清|先补充|请先补/u.test(out.text), out.text.slice(0, 80))
      check('斜杠命令列出问题', /指的是|方向|拿到什么/u.test(out.text), out.text.slice(0, 80))
    }

    const tool = toolsReg['optimize_prompt']
    check('注册了工具', tool !== undefined, '没有工具')
    if (tool) {
      const out = await tool.execute({ text: '帮我优化一下这个' }, {})
      check('工具说明「没说清」', /没说清|先补充|请先补/u.test(out.text), out.text.slice(0, 80))
    }

    // 服务是 ctx.provide 注册的（不是 inject），测试桩里要一并接住。
    const svc = provided['promptOptimizer'] || Object.values(provided)[0]
    check('注册了服务', svc !== undefined, '没有服务')
    if (svc) {
      const out = await svc.optimize('帮我优化一下这个')
      check('服务回执带 needsClarification', out.needsClarification === true, String(out.needsClarification))
      check('服务回执带 questions', Array.isArray(out.questions) && out.questions.length >= 2, String((out.questions || []).length))
    }
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('CLARIFY TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('CLARIFY TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
