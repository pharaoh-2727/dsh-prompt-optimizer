/**
 * test-fallback-brute.cjs —— 「失败时给备选」的极限压测。
 *
 * 这个功能的风险不是「没给建议」，是**给错建议**：
 *   - 没配模型时建议「重试」→ 用户点三次还是同一个错，比不给更糟
 *   - 超长时建议「去选模型」→ 完全无关，浪费用户时间
 *   - 建议文案太长 / 是空话 → 按钮挤爆，或者用户看不懂
 *   - 服务端给了一个客户端不认识的 kind → 点了没反应
 *
 * 另外还有一批「服务端不该崩」的边角：
 *   - 错误对象没有 message
 *   - 错误是字符串而不是 Error
 *   - 错误码是没见过的值
 *   - 文案里有超长数字（精简到 N 字，N 是 20 位）
 *   - 文案里根本没有数字
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-fallback-brute')

let loadCounter = 0
async function loadPlugin() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  mkdirSync(join(TMP, 'profile'), { recursive: true })
  writeFileSync(join(TMP, 'profile', 'cordis.patch.yml'),
    '- id: agent-default-model\n  config:\n    provider: test-provider\n    model: test-model\n')
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

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

const KINDS = new Set(['retry', 'pick-model', 'shorten', 'switch-style', 'open-settings'])
const CLIENT_KINDS = (() => {
  const src = require('node:fs').readFileSync(join(__dirname, '..', 'client.js'), 'utf8')
  const found = new Set()
  for (const m of src.matchAll(/kind === '([a-z-]+)'/gu)) found.add(m[1])
  return found
})()

function validate(label, opts) {
  check(label + '：返回数组', Array.isArray(opts), typeof opts)
  if (!Array.isArray(opts)) return
  check(label + '：非空', opts.length > 0, '空数组')
  for (const [i, o] of opts.entries()) {
    check(label + '：第 ' + (i + 1) + ' 项有 label',
      o && typeof o.label === 'string' && o.label.trim().length > 0, JSON.stringify(o))
    check(label + '：第 ' + (i + 1) + ' 项的 kind 在允许集合里',
      o && KINDS.has(o.kind), JSON.stringify(o && o.kind))
    check(label + '：第 ' + (i + 1) + ' 项客户端认得',
      o && CLIENT_KINDS.has(o.kind), (o && o.kind) + ' 客户端没处理')
    if (o && typeof o.label === 'string') {
      check(label + '：第 ' + (i + 1) + ' 项 label 不超过 20 字',
        o.label.length <= 20, o.label + ' (' + o.label.length + ')')
    }
  }
}

async function main() {
  const mod = await loadPlugin()
  const fn = mod.fallbackOptionsFor
  check('导出 fallbackOptionsFor', typeof fn === 'function', '没导出')
  if (typeof fn !== 'function') { process.exit(1) }

  console.log('\n[1] 每种已知错误码都要给出建议')
  for (const code of ['EMPTY_INPUT', 'TOO_LONG', 'EMPTY_OUTPUT', 'UNKNOWN']) {
    validate(code, fn(code, '随便一句文案'))
  }

  console.log('\n[2] 错的建议不许给')
  {
    const noModel = fn('UNKNOWN', '取不到可用模型。请到「设置 → 优化」选择模型。')
    check('没模型时不给 retry', !noModel.some((o) => o.kind === 'retry'), JSON.stringify(noModel))
    const tooLong = fn('TOO_LONG', '内容过长（20001 字符），请精简到 20000 以内')
    check('超长时不给 pick-model', !tooLong.some((o) => o.kind === 'pick-model'), JSON.stringify(tooLong))
    check('超长时不给 retry（再跑还是超长）', !tooLong.some((o) => o.kind === 'retry'), JSON.stringify(tooLong))
    const empty = fn('EMPTY_INPUT', '输入为空')
    check('空输入时不给 retry', !empty.some((o) => o.kind === 'retry'), JSON.stringify(empty))
  }

  console.log('\n[3] 极端文案不许崩')
  {
    const weird = [
      [undefined, undefined],
      [null, null],
      ['', ''],
      ['TOO_LONG', undefined],
      ['TOO_LONG', ''],
      ['UNKNOWN', 'x'.repeat(100000)],
      ['UNKNOWN', '\u0000\u0001\u0007'],
      ['WEIRD_CODE', '没见过的错误码'],
      ['TOO_LONG', '内容过长（99999999999999999999 字符），请精简到 99999999999999999999 以内'],
      ['TOO_LONG', '内容过长，请精简'],
      [42, 42],
      [{}, {}],
      [['a'], ['b']],
    ]
    for (const [code, msg] of weird) {
      let crashed = false
      let opts = null
      try { opts = fn(code, msg) } catch (err) {
        crashed = true
        console.log('    崩了：' + String(err && err.message ? err.message : err))
      }
      check('code=' + String(code).slice(0, 20) + ' msg 长度=' + String(msg).length + '：不崩',
        !crashed, '抛异常了')
      if (!crashed) validate('同上', opts)
    }
  }

  console.log('\n[4] 超长文案里的数字不许被当成上限发出去')
  {
    const opts = fn('TOO_LONG', '内容过长（99999999999999999999 字符），请精简到 99999999999999999999 以内')
    const hint = opts.find((o) => o.kind === 'shorten')
    check('有 shorten', hint !== undefined, JSON.stringify(opts))
    if (hint !== undefined) {
      check('hint 里的数字是有限值', Number.isFinite(Number(/(\d+)/u.exec(hint.hint || '')?.[1])),
        String(hint.hint))
    }
  }

  console.log('\n[5] 同一个错误反复算，结果必须一致（不能有隐藏状态）')
  {
    const a = JSON.stringify(fn('TOO_LONG', '内容过长（5000 字符），请精简到 4000 以内'))
    const b = JSON.stringify(fn('TOO_LONG', '内容过长（5000 字符），请精简到 4000 以内'))
    check('两次结果相同', a === b, a + ' vs ' + b)
    const c = JSON.stringify(fn('UNKNOWN', '网络超时'))
    const d = JSON.stringify(fn('UNKNOWN', '网络超时'))
    check('UNKNOWN 两次结果相同', c === d, c + ' vs ' + d)
  }

  console.log('\n[6] 性能：一万次不许超 1 秒')
  {
    const startedAt = Date.now()
    for (let i = 0; i < 10000; i++) fn('UNKNOWN', '取不到可用模型。请到「设置 → 优化」选择模型。')
    const ms = Date.now() - startedAt
    check('一万次 ' + ms + 'ms < 1000ms', ms < 1000, ms + 'ms')
  }

  console.log('\n[7] 建议数量要克制（最多 3 条，多了就是让用户选择困难）')
  {
    for (const code of ['EMPTY_INPUT', 'TOO_LONG', 'EMPTY_OUTPUT', 'UNKNOWN']) {
      const opts = fn(code, '取不到可用模型')
      check(code + ' 不超过 3 条', opts.length <= 3, opts.length + ' 条')
    }
  }

  if (failures > 0) {
    console.log('\n' + failures + ' 项未通过')
    process.exit(1)
  }
  console.log('\nALL FALLBACK BRUTE TESTS PASSED')
}

main().catch((err) => { console.error(err); process.exit(1) })
