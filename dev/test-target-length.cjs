/**
 * test-target-length.cjs —— 系统提示要告诉模型「这次写到多长」。
 *
 * 问题（线上实测，15 次跑 11 次触发重试）：
 *   把 README 的安装章节更新一下（18 字，均衡档区间 [49, 98]）
 *     run1 太短 → 重试补齐
 *     run2 太长 → 重试收敛
 *     run3 太短 → 重试补齐
 *
 * 同一个输入，三次的重试原因都不一样 —— 模型在区间边缘随机摆动。
 * 它不知道「该写多少字」，只能凭感觉猜；猜偏了引擎就重试一次，
 * 一次优化变成两次模型调用，用户多等一倍时间。
 *
 * 修法：在系统提示里直接给出目标字数。模型不用猜，第一次就落在区间内。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-target-length')

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
const limitFor = (id, len) => {
  const b = BANDS[id]
  return Math.max(len, Math.min(b.absMax, Math.round(Math.max(len * b.ratioMax, len + b.plusChars))))
}
const floorFor = (id, len) => {
  const L = limitFor(id, len)
  return Math.min(Math.max(Math.round(L * 0.5), len + 20), L - 1)
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
        calls.push({ system: o.system, maxTokens: o.maxTokens })
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

/**
 * 从系统提示里把「目标字数」抠出来。
 *
 * 提示原文是：「本次目标：原文 18 字，改写到大约 74 字（可接受范围 49–98 字）。」
 * 必须抓「大约 N 字」，不能抓第一个数字 —— 第一个是原文长度。
 */
function targetFrom(system) {
  const idx = system.indexOf('本次目标')
  if (idx < 0) return null
  const m = /改写到大约\s*(\d+)\s*字/u.exec(system.slice(idx))
  return m === null ? null : Number(m[1])
}

async function main() {
  console.log('\n[1] 任务类输入：系统提示要给出目标字数')
  {
    const mod = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['目标：更新 README 的安装章节。\n产出：改好的章节。\n验收：安装步骤能照着做。'])
    mod.apply(ctx)
    await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 't1' })

    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    const len = '把 README 的安装章节更新一下'.length
    const F = floorFor('balanced', len)
    const L = limitFor('balanced', len)
    const target = targetFrom(system)

    console.log('    原文 ' + len + ' 字 | 均衡档区间 [' + F + ', ' + L + '] | 提示里的目标 ' + target + ' 字')
    check('系统提示里有目标字数', target !== null, '没找到「本次目标 N 字」')
    check('目标字数落在区间内', target !== null && target >= F && target <= L,
      target + ' 不在 [' + F + ', ' + L + '] 内')
    check('目标字数取区间中点附近', target !== null && Math.abs(target - (F + L) / 2) <= (L - F) / 4,
      '中点 ' + Math.round((F + L) / 2) + '，实际 ' + target)
  }

  console.log('\n[2] 提问类输入：不设目标字数（它本来就不该被补长）')
  {
    const mod = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx(['这个插件应该怎么用？'])
    mod.apply(ctx)
    await runOptimize(handlers, { text: '这个插件怎么用？', sessionId: 't2' })
    const system = ctx.calls[0] ? ctx.calls[0].system : ''
    check('提问的系统提示里没有目标字数', targetFrom(system) === null, '不该给提问设字数目标')
  }

  console.log('\n[3] 三档都要给，且各自的目标不同')
  {
    const len = '把 README 的安装章节更新一下'.length
    const targets = {}
    for (const style of ['brief', 'balanced', 'detailed']) {
      const mod = await loadPlugin(style)
      const { ctx, handlers } = makeCtx(['目标：更新安装章节。\n产出：改好的章节。\n验收：能照着做。'])
      mod.apply(ctx)
      await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 't3-' + style })
      const system = ctx.calls[0] ? ctx.calls[0].system : ''
      const t = targetFrom(system)
      const F = floorFor(style, len)
      const L = limitFor(style, len)
      targets[style] = t
      console.log('    ' + style.padEnd(9) + ' 区间 [' + F + ', ' + L + '] → 目标 ' + t)
      check(style + ' 的目标落在自己的区间内', t !== null && t >= F && t <= L, t + ' 不在 [' + F + ', ' + L + ']')
    }
    check('三档的目标字数互不相同',
      new Set(Object.values(targets)).size === 3, JSON.stringify(targets))
  }

  console.log('\n[4] 重试时也要带上目标字数')
  {
    // 首稿故意写短，逼出一次「补齐」重试；重试的系统提示同样要带目标。
    const mod = await loadPlugin('balanced')
    const { ctx, handlers } = makeCtx([
      '太短了。',
      '目标：更新 README 的安装章节。\n步骤：读 README、定位安装章节、改写。\n产出：改好的章节。\n验收：安装步骤能照着做，命令都能跑通。',
    ])
    mod.apply(ctx)
    await runOptimize(handlers, { text: '把 README 的安装章节更新一下', sessionId: 't4' })
    console.log('    模型调用 ' + ctx.calls.length + ' 次')
    check('确实触发了重试', ctx.calls.length >= 2, '只调了 ' + ctx.calls.length + ' 次')
    const retrySystem = ctx.calls[1] ? ctx.calls[1].system : ''
    check('重试的系统提示也带目标字数', targetFrom(retrySystem) !== null, '重试提示里没有目标字数')
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('TARGET LENGTH TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('TARGET LENGTH TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
