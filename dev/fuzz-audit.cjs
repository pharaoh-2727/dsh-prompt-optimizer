/**
 * fuzz-audit.cjs —— 对抗式审计：不验证「不该崩」，而是验证「判据在真实输入下是否可信」。
 *
 * 与 test-brute-force.cjs 的分工：
 *   那边查「不抛异常、错误码对、五个入口一致」—— 契约层面。
 *   这边查「判据本身会不会误判」—— 逻辑层面。它允许失败，输出的是发现清单。
 *
 * 跑法：node dev/fuzz-audit.cjs
 * 退出码恒为 0（这是审计工具，不是回归测试）。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = join(os.tmpdir(), 'dsho-fuzz-audit')

let loadCounter = 0
async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
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

const findings = []
const record = (severity, area, title, detail) => findings.push({ severity, area, title, detail })

async function main() {
  const mod = await loadPlugin('balanced')
  const classify = mod.classifyInput
  if (typeof classify !== 'function') throw new Error('classifyInput 未导出')

  // ══════════════════════════════════════════════════════════════════════
  // 1. 判据对抗：真实用户会写、但词表可能漏判的输入
  // ══════════════════════════════════════════════════════════════════════
  console.log('══ 1. 输入判据对抗 ══')

  const shouldBeC = [
    ['把那个函数改一下', '指代式任务，没有具体动词短语'],
    ['这个不对', '极短否定，要 DSH 判断哪里不对'],
    ['再跑一次', '延续上文的任务'],
    ['换个写法', '延续上文的任务'],
    ['继续', '延续上文的任务'],
    ['重来', '延续上文的任务'],
    ['改成 3000 字', '带数字的任务'],
    ['用 TypeScript 重写', '技术栈指定'],
    ['把上面的改清楚', '指代上文'],
    ['加一个超时', '动词在句尾'],
    ['这里应该用 Map 而不是 Object', '陈述式要求'],
    ['别用 any', '否定式要求'],
    ['remove the unused import', '英文动词开头'],
    ['把 for 循环换成 while', '代码改写'],
    ['整理成表格', '产出形态'],
    ['压到 500 字以内', '约束式要求'],
  ]
  for (const [text, why] of shouldBeC) {
    const got = classify(text)
    if (got !== 'c') {
      record('中', '判据', '任务被判成 ' + got, JSON.stringify(text) + ' —— ' + why)
    }
  }

  const shouldBeB = [
    ['这是干嘛的', '纯提问'],
    ['有啥区别', '纯提问'],
    ['是不是坏了', '纯提问'],
    ['能行吗', '纯提问'],
    ['哪个更好', '纯提问'],
    ['这样对吗', '纯提问'],
    ['why is this slow', '英文提问'],
    ['what does this do', '英文提问'],
  ]
  for (const [text, why] of shouldBeB) {
    const got = classify(text)
    if (got === 'c') {
      record('中', '判据', '提问被判成任务', JSON.stringify(text) + ' —— ' + why)
    }
  }

  // 危险组合：带路径但其实是提问
  const tricky = [
    ['README 里的这句话是什么意思？', 'b', '带文件名但是提问'],
    ['src/app.ts 为什么这么慢？', 'b', '带路径但是提问'],
    ['package.json 里的 scripts 是干嘛的？', 'b', '带文件名但是提问'],
  ]
  for (const [text, want, why] of tricky) {
    const got = classify(text)
    if (got !== want) record('高', '判据', '边界输入判成 ' + got + '（期望 ' + want + '）', JSON.stringify(text) + ' —— ' + why)
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. 档位边界对抗：整数溢出 / 极端长度
  // ══════════════════════════════════════════════════════════════════════
  console.log('══ 2. 档位边界 ══')

  const bands = {}
  const src = require('node:fs').readFileSync(PLUGIN, 'utf8')
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  let m
  while ((m = re.exec(src)) !== null) bands[m[1]] = { r: +m[2], p: +m[3], max: +m[4] }
  const limitFor = (id, len) => Math.min(bands[id].max, Math.round(Math.max(len * bands[id].r, len + bands[id].p)))
  const floorFor = (id, len) => {
    const L = limitFor(id, len)
    return Math.min(Math.max(Math.round(L * 0.5), len + 20), L - 1)
  }

  // 下限必须严格小于上限，否则「怎么写都过不了」
  for (const id of ['brief', 'balanced', 'detailed']) {
    for (const len of [1, 2, 5, 10, 20, 50, 100, 500, 1000, 5000, 19999, 20000]) {
      const L = limitFor(id, len)
      const F = floorFor(id, len)
      if (!(F < L)) record('高', '档位', '下限 >= 上限（怎么写都过不了）', id + ' 原文 ' + len + ' 字：[' + F + ', ' + L + ']')
      if (F < 0) record('高', '档位', '下限为负', id + ' 原文 ' + len)
      if (len > 0 && L <= len * 0.5) record('低', '档位', '上限不到原文一半', id + ' 原文 ' + len + ' → ' + L)
    }
  }

  // 精简档：短输入的上限是否小到「连改错别字都装不下」
  for (const len of [1, 2, 3, 5, 10]) {
    const L = limitFor('brief', len)
    const F = floorFor('brief', len)
    if (L - len <= 3) record('中', '档位', '精简档几乎没有加字空间', '原文 ' + len + ' 字 → 上限 ' + L + '（只多 ' + (L - len) + ' 字）')
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. 提示词与代码的一致性（文档漂移）
  // ══════════════════════════════════════════════════════════════════════
  console.log('══ 3. 提示词一致性 ══')
  const items = mod.STYLE_ITEMS
  for (const item of items) {
    const b = bands[item.id]
    if (!item.prompt.includes(String(b.r))) record('高', '提示词', item.id + ' 提示词没写倍数', String(b.r))
    if (!item.prompt.includes('+ ' + b.p)) record('高', '提示词', item.id + ' 提示词没写加字额度', '+ ' + b.p)
    if (!item.prompt.includes(String(b.max))) record('高', '提示词', item.id + ' 提示词没写封顶', String(b.max))
    // 提示词里说的封顶数字，必须就是 absMax
    const nums = item.prompt.match(/封顶\s*(\d+)/g) || []
    for (const n of nums) {
      const v = Number(n.replace(/\D/g, ''))
      if (v !== b.max) record('高', '提示词', item.id + ' 封顶数字与代码不一致', '提示词写 ' + v + '，代码是 ' + b.max)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 4. 空输入 / 极端输入的判据行为
  // ══════════════════════════════════════════════════════════════════════
  console.log('══ 4. 极端输入 ══')
  for (const [text, why] of [
    ['', '空串'],
    ['   ', '纯空白'],
    ['\n\n\n', '纯换行'],
    ['。', '单标点'],
    ['？？？', '纯问号'],
    ['a'.repeat(19999), '贴着上限'],
    ['a'.repeat(20001), '超过上限'],
    ['😀'.repeat(100), '纯 emoji'],
    ['\u0000', '空字符'],
  ]) {
    let got
    try { got = classify(text) } catch (e) {
      record('高', '极端', '判据抛异常', JSON.stringify(text.slice(0, 20)) + ' —— ' + why + '：' + e.message)
      continue
    }
    if (!['a', 'b', 'c'].includes(got)) record('高', '极端', '判据返回非法值', JSON.stringify(text.slice(0, 20)) + ' → ' + got)
  }

  // ══════════════════════════════════════════════════════════════════════
  // 5. stripReasoning 的对抗
  // ══════════════════════════════════════════════════════════════════════
  console.log('══ 5. 思考剥离 ══')
  const clientSrc = require('node:fs').readFileSync(join(__dirname, '..', 'client.js'), 'utf8')
  if (!clientSrc.includes('function stripReasoning')) {
    record('高', '客户端', 'stripReasoning 不存在', 'v0.1.2 的修复可能被回退')
  } else {
    // 判据是「整行相同且 >= 8 字」。检查它会不会把正常正文误删。
    // 用同样的逻辑在本地跑一遍（复制规则，不改源码）。
    const strip = (body, think) => {
      if (!body || !think) return body
      const set = new Set(think.split('\n').map(s => s.trim()).filter(s => s.length >= 8))
      if (set.size === 0) return body
      const kept = body.split('\n').filter(line => {
        const t = line.trim()
        if (t.length < 8) return true
        return !set.has(t)
      })
      const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      return out.length === 0 ? body : out
    }
    // 思考里出现了一句正常正文 —— 会被误删
    const body1 = '目标：更新 README。\n验收：不再残留第一版内容。'
    const think1 = '目标：更新 README。'
    if (strip(body1, think1) !== body1) {
      record('中', '客户端', '思考与正文有一行相同就会被删', '正文里那一行可能是有意写的，不一定是漏出来的思考')
    }
    // 正常情况：不该删
    const body2 = '目标：改配置。'
    const think2 = '这是 b 类提问，只需改写。'
    if (strip(body2, think2) !== body2) record('高', '客户端', 'stripReasoning 误删正常正文', '')
    // 全被删光时要回退
    const body3 = '这是一行很长的正文内容超过八个字'
    const think3 = '这是一行很长的正文内容超过八个字'
    if (strip(body3, think3) !== body3) record('中', '客户端', '全部被删时没有回退', '会交白卡片')
  }

  rmSync(TMP, { recursive: true, force: true })

  // ══════════════════════════════════════════════════════════════════════
  console.log('')
  if (findings.length === 0) {
    console.log('没有发现问题。')
    return
  }
  const bySeverity = { 高: [], 中: [], 低: [] }
  for (const f of findings) bySeverity[f.severity].push(f)
  console.log('发现 ' + findings.length + ' 项：高 ' + bySeverity.高.length + ' / 中 ' + bySeverity.中.length + ' / 低 ' + bySeverity.低.length)
  for (const sev of ['高', '中', '低']) {
    if (bySeverity[sev].length === 0) continue
    console.log('\n── ' + sev + ' ──')
    for (const f of bySeverity[sev]) {
      console.log('  [' + f.area + '] ' + f.title)
      if (f.detail) console.log('      ' + f.detail)
    }
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
