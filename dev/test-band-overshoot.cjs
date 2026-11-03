/**
 * test-band-overshoot.cjs —— 重试稿「从超长变成过短」时不许被当成收敛成功。
 *
 * 案发现场（用户截图）：
 *
 *   优化中 ：「超出这一档的长度上限，正在重新收敛…」254 字
 *   最终   ：161 字，标着「已按档位上限收敛」，内容几乎就是原文
 *
 * 链路：首稿超上限 → 判 too-long → 带「删到 N 字以内」的指令重试
 *      → 模型一路删过头，交回一稿低于下限 → 判 too-short
 *      → 但接受判据只看「比上一稿短」，于是收下，还记成 trimmed。
 *
 * 判据本身写错了：'too-long' → 'too-short' 是**越过了整个区间**，
 * 不是收敛。把它当成功，用户拿到的是被删空的原稿。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-overshoot')

const BANDS = (() => {
  const src = readFileSync(PLUGIN, 'utf8')
  const found = {}
  let m
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  while ((m = re.exec(src)) !== null) {
    found[m[1]] = { ratioMax: Number(m[2]), plusChars: Number(m[3]), absMax: Number(m[4]) }
  }
  if (Object.keys(found).length !== 3) throw new Error('cannot read STYLE_BANDS')
  return found
})()

const limitFor = (id, len) => {
  const b = BANDS[id]
  return Math.min(b.absMax, Math.round(Math.max(len * b.ratioMax, len + b.plusChars)))
}
const floorFor = (id, len, limit) => Math.min(Math.max(Math.round(limit * 0.5), len + 20), limit - 1)

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
        calls.push({ system: o.system })
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

async function main() {
  // 用一条真实的 c) 类任务：带路径，会触发内容下限
  const SOURCE = '目标：更新 @README.md，其中很多内容仍停留在第一版。\n\n请从下面两个方案中任选一个，并说明选择理由。\n\n产出：改好的 README，以及一句说明所选方案。\n验收标准：README 中不再残留第一版的内容。'
  const len = SOURCE.trim().length
  const limit = limitFor('detailed', len)
  const floor = floorFor('detailed', len, limit)
  console.log('原文 ' + len + ' 字 | 详细档区间 [' + floor + ', ' + limit + ']')

  // ── 场景 1：超长 → 重试删过头，变成过短 ──────────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const tooLong = '补'.repeat(limit + 120)
    // 重试交回的稿子比下限还短 —— 这正是「161 字」那种结果
    const tooShort = '目标：更新 @README.md。'
    const { ctx, handlers } = makeCtx([tooLong, tooShort])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SOURCE, sessionId: 's1' })
    console.log('')
    console.log('· 超长 → 删过头变过短')
    console.log('    首稿 ' + tooLong.length + ' 字 | 重试 ' + tooShort.length + ' 字 | 下限 ' + floor)
    console.log('    最终 ' + (r.body.text || '').length + ' 字 | adjusted=' + r.body.adjusted)
    check('不许把「越过整个区间」记成收敛成功', r.body.adjusted !== 'trimmed', 'adjusted=' + r.body.adjusted)
    check('最终结果仍在下限之上', (r.body.text || '').length >= floor,
      (r.body.text || '').length + ' < ' + floor)
  }

  // ── 场景 2：超长 → 重试仍然超长但更短（这是真的在收敛，应当接受）────
  {
    const mod = await loadPlugin('detailed')
    const tooLong = '补'.repeat(limit + 200)
    const stillLong = '改'.repeat(limit + 40)
    const { ctx, handlers } = makeCtx([tooLong, stillLong])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SOURCE, sessionId: 's2' })
    console.log('')
    console.log('· 超长 → 重试仍超长但更短（同一方向上确实收敛了）')
    console.log('    首稿 ' + tooLong.length + ' → 重试 ' + stillLong.length + ' | 最终 ' + (r.body.text || '').length)
    check('同一方向上变短可以接受', (r.body.text || '') === stillLong)
  }

  // ── 场景 3：超长 → 重试正好落在区间内 ────────────────────────────────
  {
    const mod = await loadPlugin('detailed')
    const tooLong = '补'.repeat(limit + 100)
    let good = '目标：更新 @README.md 里过时的内容。'
    while (good.length < floor) good += '把每一段对照当前实现核对一遍。'
    const { ctx, handlers } = makeCtx([tooLong, good])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SOURCE, sessionId: 's3' })
    console.log('')
    console.log('· 超长 → 重试落在区间内')
    console.log('    重试 ' + good.length + ' 字（区间 [' + floor + ', ' + limit + ']）| 最终 ' + (r.body.text || '').length)
    check('落在区间内的重试照常接受', (r.body.text || '') === good, 'adjusted=' + r.body.adjusted)
    check('标成 trimmed', r.body.adjusted === 'trimmed', 'adjusted=' + r.body.adjusted)
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('BAND OVERSHOOT TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('BAND OVERSHOOT TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
