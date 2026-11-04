/**
 * test-preferences.cjs —— 个性化增量：用户攒的偏好要真的进到系统提示里。
 *
 * 为什么要有这个功能：
 *   用户发现自己每次都在改同一件事 ——「别用 emoji」「产出用编号列表」
 *   「不要写"综上所述"」。每次都得在原文里再说一遍，或者改完自己再手动删。
 *
 *   设置里本来有 customPrompt，但它有两个问题：
 *     1. 它是**换掉**整份系统提示词，用户得从头写一遍三档规则；
 *     2. 只在「自定义」档生效，换个档就没了。
 *
 *   偏好是**加在**当前档位之上的几条规则，三档都生效。
 *
 * 五条必须成立的点：
 *   1. 有偏好 → 系统提示里出现，且逐条原样出现（一个字都不许改）
 *   2. 没偏好 → 系统提示里不出现「用户偏好」这段（不能平白多一块）
 *   3. 偏好排在公共规则之前（公共规则优先级最高，不能被偏好盖掉）
 *   4. 重试也带偏好（重试产出的就是最终结果，那一次同样要守偏好）
 *   5. 脏数据不崩：非数组、非字符串、空串、超长、超过 20 条
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-preferences')

let loadCounter = 0
async function loadPlugin(preferences, style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  stubModel(join(TMP, 'profile'))
  const saved = {
    modelMode: 'auto', provider: '', model: '', style: style || 'balanced',
    customPrompt: '', freeChannelAsked: true,
  }
  if (preferences !== undefined) saved.preferences = preferences
  writeFileSync(join(TMP, 'prompt-optimizer', 'settings.json'), JSON.stringify(saved, null, 2))
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

const TASK = '把 README 的安装章节更新一下'
const GOOD = '目标：更新 README 的安装章节，把 Node 版本要求与三条安装步骤写清楚。\n产出：改好的安装章节正文。\n验收：照这三步能装好，不出现原文没有的依赖。'

async function main() {
  console.log('\n[1] 有偏好：要出现在系统提示里，且逐条原样')
  {
    const prefs = ['不要用 emoji', '产出用编号列表，不要用无序符号']
    const mod = await loadPlugin(prefs)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p1' })

    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    check('提示里有「用户偏好」这一段', system.includes('用户偏好'), '整段都没出现')
    for (const p of prefs) {
      check('偏好原样出现：' + p, system.includes(p), '被改写或丢掉了')
    }
    check('偏好带编号', /用户偏好[\s\S]*1\.\s*不要用 emoji/u.test(system), '没有编号')
  }

  console.log('\n[2] 没有偏好：不许平白多出一块')
  {
    const mod = await loadPlugin(undefined)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p2' })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    check('不出现「用户偏好」', !system.includes('用户偏好'), '没配偏好却多了一块')
  }

  console.log('\n[3] 偏好排在公共规则之前')
  {
    const mod = await loadPlugin(['不要用 emoji'])
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p3' })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    const prefIdx = system.indexOf('用户偏好')
    const commonIdx = system.indexOf('公共规则（三档都适用')
    check('两段都在', prefIdx >= 0 && commonIdx >= 0, 'pref=' + prefIdx + ' common=' + commonIdx)
    check('偏好在公共规则之前', prefIdx >= 0 && commonIdx >= 0 && prefIdx < commonIdx,
      'pref=' + prefIdx + ' common=' + commonIdx)
  }

  console.log('\n[4] 重试也要带偏好')
  {
    // 第一稿太短（触发补齐重试），第二稿合格。
    const mod = await loadPlugin(['不要用 emoji'])
    const { ctx, handlers } = makeCtx(['目标：更新安装章节。', GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p4' })
    check('确实重试了一次', ctx.calls.length >= 2, '只调了 ' + ctx.calls.length + ' 次')
    const retrySystem = ctx.calls[1] ? ctx.calls[1].system : ''
    check('重试提示里也有偏好', retrySystem.includes('不要用 emoji'), '重试那一次丢了偏好')
  }

  console.log('\n[5] 三档都要生效')
  for (const style of ['brief', 'balanced', 'detailed']) {
    const mod = await loadPlugin(['不要用 emoji'], style)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p5-' + style })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    check(style + ' 档带上了偏好', system.includes('不要用 emoji'), '这一档丢了偏好')
  }

  console.log('\n[6] 脏数据不许崩，也不许把垃圾发出去')
  {
    const cases = [
      { name: '不是数组', value: 'not-an-array' },
      { name: 'null', value: null },
      { name: '数字', value: 42 },
      { name: '数组里混着非字符串', value: ['好的偏好', 42, null, { a: 1 }, '另一个'] },
      { name: '全是空串', value: ['', '   ', '\t'] },
      { name: '超长（201 字）', value: ['x'.repeat(201)] },
    ]
    for (const item of cases) {
      let crashed = false
      let system = ''
      try {
        const mod = await loadPlugin(item.value)
        const { ctx, handlers } = makeCtx([GOOD])
        mod.apply(ctx)
        await runOptimize(handlers, { text: TASK, sessionId: 'p6' })
        system = ctx.calls[0] ? ctx.calls[0].system : ''
      } catch (err) {
        crashed = true
        console.log('    崩了：' + String(err && err.message ? err.message : err))
      }
      check(item.name + '：不崩', !crashed, '抛异常了')
      if (!crashed && item.name === '数组里混着非字符串') {
        check('只留下字符串那两条', system.includes('好的偏好') && system.includes('另一个')
          && !system.includes('42'), '非字符串没被滤掉')
      }
      if (!crashed && item.name === '超长（201 字）') {
        check('超长那条被丢掉', !system.includes('xxxxx'), '超长偏好被发出去了')
      }
      if (!crashed && item.name === '全是空串') {
        check('不出现「用户偏好」', !system.includes('用户偏好'), '空偏好也拼了一段')
      }
    }
  }

  console.log('\n[7] 超过 20 条只留前 20 条')
  {
    const many = Array.from({ length: 25 }, (_, i) => '偏好' + (i + 1))
    const mod = await loadPlugin(many)
    const { ctx, handlers } = makeCtx([GOOD])
    mod.apply(ctx)
    await runOptimize(handlers, { text: TASK, sessionId: 'p7' })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    check('第 20 条还在', system.includes('偏好20'), '前 20 条被砍了')
    check('第 21 条被丢掉', !system.includes('偏好21'), '没截断')
  }

  console.log('\n[8] normalizePreferences 本身的行为')
  {
    const mod = await loadPlugin(undefined)
    const fn = mod.normalizePreferences
    check('导出 normalizePreferences', typeof fn === 'function', '没导出')
    if (typeof fn === 'function') {
      check('去首尾空白', JSON.stringify(fn(['  a  '])) === JSON.stringify(['a']), JSON.stringify(fn(['  a  '])))
      check('保留顺序', JSON.stringify(fn(['b', 'a'])) === JSON.stringify(['b', 'a']), JSON.stringify(fn(['b', 'a'])))
      check('不去重（用户写两遍就发两遍）', fn(['a', 'a']).length === 2, JSON.stringify(fn(['a', 'a'])))
      check('非数组返回空数组', JSON.stringify(fn('x')) === '[]', JSON.stringify(fn('x')))
      check('undefined 返回空数组', JSON.stringify(fn(undefined)) === '[]', JSON.stringify(fn(undefined)))
    }
  }

  if (failures > 0) {
    console.log('\n' + failures + ' 项未通过')
    process.exit(1)
  }
  console.log('\nALL PREFERENCES TESTS PASSED')
}

main().catch((err) => { console.error(err); process.exit(1) })
