/**
 * test-unchanged.cjs —— 模型把原文原样吐回来时，引擎必须再试一次。
 *
 * 线上实测：「帮我优化一下这个」跑 8 次，有 2 次拿回来的就是原文本身，
 * 一个字都没改。用户点了「优化」，等了几秒，什么都没发生。
 *
 * 链路：
 *   首稿 = 原文 → 判 too-short（8 字 < 详细档下限 78）
 *   → 带「补出产出与验收」重试
 *   → 重试稿**还是原文**
 *   → 接受判据要求「比上一稿长」，8 > 8 不成立 → 拒绝
 *   → 最终把原文原样交出去
 *
 * 判据本身没错（它确实没变好），错的是**没有针对「原样返回」这件事本身重试**。
 * 长度不够只是症状，真正的问题是模型没做事。
 *
 * 只对任务类（c）追究：a) 寒暄和 b) 提问原样返回是正常的，
 * 它们本来就不该被改动。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-unchanged')

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

const norm = (s) => String(s ?? '').replace(/\s+/gu, ' ').trim()

async function main() {
  console.log('\n[1] 任务类输入原样返回 → 必须重试，且接受改写稿')
  {
    const mod = await loadPlugin('detailed')
    const SRC = '帮我优化一下这个'
    const FIXED = '目标：优化「这个」所指的对象。\n步骤：先确认要优化的是哪个文件或哪段文字，确认后再动手改。\n产出格式：给出优化后的版本，并说明改了哪几处。\n验收标准：改动的每一处都能对应到原文说过的要求。'
    const { ctx, handlers } = makeCtx([SRC, FIXED])  // 首稿原样，重试给出真正的改写
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u1' })

    console.log('    模型调用 ' + ctx.calls.length + ' 次 | 最终 ' + (r.body.text || '').length + ' 字')
    check('首稿原样返回时会再试一次', ctx.calls.length >= 2, '只调了 ' + ctx.calls.length + ' 次')
    check('最终结果不是原文', norm(r.body.text) !== norm(SRC), JSON.stringify(r.body.text))
    check('最终结果就是重试稿', norm(r.body.text) === norm(FIXED), JSON.stringify((r.body.text || '').slice(0, 60)))
  }

  console.log('\n[2] 重试指令要明确指出「你只是重复了原文」')
  {
    const mod = await loadPlugin('detailed')
    const SRC = '帮我优化一下这个'
    const { ctx, handlers } = makeCtx([SRC, '目标：优化「这个」。\n产出格式：改好的版本。\n验收标准：改动能对应原文要求。'])
    mod.apply(ctx)
    await runOptimize(handlers, { text: SRC, sessionId: 'u2' })
    const retrySystem = ctx.calls[1] ? ctx.calls[1].system : ''
    /*
     * 只看「本次修正要求」之后那一段。
     *
     * 不能对整个 system 做正则：基础提示词里本来就有「照原样保留」这句话
     * （公共规则第 1 条讲代码片段要原样保留），一正则就假通过。
     */
    const marker = '下面是本次修正要求'
    const idx = retrySystem.indexOf(marker)
    const instruction = idx < 0 ? '' : retrySystem.slice(idx)
    check('重试提示里点明了「原样重复」',
      /重复|原样返回|一个字都没改|没有任何改动|未做任何改动|与原文完全相同/u.test(instruction),
      '修正指令段里没说清问题：' + JSON.stringify(instruction.slice(0, 120)))
  }

  console.log('\n[3] 重试还是原样 → 不许假装改过')
  {
    const mod = await loadPlugin('detailed')
    const SRC = '帮我优化一下这个'
    const { ctx, handlers } = makeCtx([SRC, SRC])  // 两次都原样
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u3' })
    console.log('    调用 ' + ctx.calls.length + ' 次 | 结果 ' + JSON.stringify((r.body.text || '').slice(0, 30)) + ' | adjusted=' + r.body.adjusted)
    check('不许标成 adjusted（没改就不算调整过）', r.body.adjusted === null, String(r.body.adjusted))
    check('不许超过两次调用（别死循环）', ctx.calls.length <= 2, '调了 ' + ctx.calls.length + ' 次')
  }

  console.log('\n[4] 提问原样返回是正常的，不许重试')
  {
    const mod = await loadPlugin('balanced')
    const SRC = '这个插件怎么用？'
    const { ctx, handlers } = makeCtx([SRC, '这个插件应该怎么用？'])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u4' })
    console.log('    调用 ' + ctx.calls.length + ' 次 | 结果 ' + JSON.stringify(r.body.text))
    check('提问原样返回只调一次模型', ctx.calls.length === 1, '调了 ' + ctx.calls.length + ' 次')
    check('提问原样返回照常收下', norm(r.body.text) === norm(SRC), JSON.stringify(r.body.text))
  }

  console.log('\n[5] 寒暄原样返回是正常的，不许重试')
  {
    const mod = await loadPlugin('balanced')
    const SRC = '好的，谢谢'
    const { ctx, handlers } = makeCtx([SRC, '好的，谢谢。'])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u5' })
    check('寒暄原样返回只调一次模型', ctx.calls.length === 1, '调了 ' + ctx.calls.length + ' 次')
  }

  console.log('\n[6] 只差标点/空白不算原样返回（那是有效的微调）')
  {
    const mod = await loadPlugin('balanced')
    const SRC = '把 README 的安装章节更新一下'
    const OUT = '把 @README.md 的安装章节更新一下。'
    const { ctx, handlers } = makeCtx([OUT])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u6' })
    check('有实质改动的稿子不会触发原样重试', ctx.calls.length === 1 || !norm(r.body.text).includes('原样'), '调了 ' + ctx.calls.length + ' 次')
    check('结果被收下', norm(r.body.text) === norm(OUT), JSON.stringify(r.body.text))
  }

  console.log('\n[7] 重试后还是原样 → 回执要带一个明确标记，界面能据此提示')
  {
    const mod = await loadPlugin('detailed')
    const SRC = '帮我优化一下这个'
    const { ctx, handlers } = makeCtx([SRC, SRC])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u7' })
    console.log('    unchanged 标记 = ' + JSON.stringify(r.body.unchanged) + ' | 结果长度 ' + (r.body.text || '').length)
    check('回执里有 unchanged:true', r.body.unchanged === true, JSON.stringify(r.body.unchanged))
    check('原样返回时 adjusted 仍是 null', r.body.adjusted === null, String(r.body.adjusted))
  }

  console.log('\n[8] 正常改写时不许带 unchanged 标记')
  {
    const mod = await loadPlugin('balanced')
    const SRC = '把 README 的安装章节更新一下'
    const OUT = '目标：更新 @README.md 的安装章节。\n产出格式：改好的章节。\n验收标准：安装步骤能照着做。'
    const { ctx, handlers } = makeCtx([OUT])
    mod.apply(ctx)
    const r = await runOptimize(handlers, { text: SRC, sessionId: 'u8' })
    check('没有 unchanged 标记', r.body.unchanged !== true, JSON.stringify(r.body.unchanged))
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('UNCHANGED TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('UNCHANGED TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
