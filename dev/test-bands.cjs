/**
 * test-bands.cjs —— 验证三档的边界逻辑与档位复核。
 *
 * 覆盖：
 *   1. 每档的长度上限 = max(原文长度 × 倍数, 原文长度 + 加字额度)；
 *   2. 三档上限严格递增（递进差异成立）；
 *   3. 每档 prompt 必须写明自己的长度上限，且数字与引擎一致；
 *   4. 三档的禁止项互不相同；
 *   5. 提示词里的长度公式与引擎里的常量一一对应。
 */
const { pathToFileURL } = require('node:url')

const PLUGIN = process.env.DSHO_PLUGIN || require('node:path').join(__dirname, '..', 'index.js')

async function main() {
  const mod = await import(pathToFileURL(PLUGIN).href)

  // 这些是内部函数，没有导出；通过 apply(ctx) 的闭包拿不到，
  // 所以直接读源码里的常量做等价计算，再对导出的 STYLE_ITEMS 做校验。
  const src = require('node:fs').readFileSync(PLUGIN, 'utf8')

  const bands = {}
  const bandRe = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  let m
  while ((m = bandRe.exec(src)) !== null) {
    bands[m[1]] = {
      ratioMax: Number(m[2]),
      plusChars: Number(m[3]),
      absMax: Number(m[4]),
    }
  }
  console.log('bands       :', JSON.stringify(bands))
  if (Object.keys(bands).length !== 3) throw new Error('expected 3 bands')

  // 引擎里的公式：上限 = max(长度 × 倍数, 长度 + 加字额度)，再被 absMax 截顶。
  const limitFor = (styleId, len) => {
    const band = bands[styleId]
    return Math.min(band.absMax, Math.round(Math.max(len * band.ratioMax, len + band.plusChars)))
  }

  // ── 1. 长度上限 = max(倍数, 加字额度) ────────────────────────────────
  // 短输入走加字额度（1.15 倍几乎等于不许改），长输入走倍数。
  const cases = [
    ['brief', 10, 20],        // max(11.5, 10+10) = 20
    ['brief', 59, 69],        // max(67.85, 69) = 69
    ['brief', 60, 70],        // max(69, 70) = 70  ← 加字额度开始占优
    ['brief', 200, 230],      // max(230, 210) = 230
    ['brief', 1000, 1150],    // max(1150, 1010) = 1150
    ['balanced', 20, 80],     // max(32, 80) = 80
    ['balanced', 100, 160],   // max(160, 160) = 160
    ['balanced', 200, 320],   // max(320, 260) = 320
    ['balanced', 1000, 1600],
    ['detailed', 30, 180],    // max(66, 180) = 180
    ['detailed', 150, 330],   // max(330, 300) = 330
    ['detailed', 200, 440],   // max(440, 350) = 440
    ['detailed', 1000, 2200],
    ['detailed', 5000, 4000], // absMax 兜底
  ]
  for (const [style, len, expected] of cases) {
    const got = limitFor(style, len)
    if (got !== expected) throw new Error(`limit ${style}/${len}: got ${got}, want ${expected}`)
  }
  console.log('limits      : ✓', cases.length, 'cases')

  // ── 2. 三档上限必须严格递增，否则「递进差异」不成立 ──────────────────
  for (const len of [20, 60, 100, 200, 1000]) {
    const b = limitFor('brief', len)
    const a = limitFor('balanced', len)
    const d = limitFor('detailed', len)
    if (!(b < a && a < d)) throw new Error(`tiers not monotonic at ${len}: ${b}/${a}/${d}`)
  }
  console.log('monotonic   : ✓ brief < balanced < detailed at every length')

  // ── 3. 每档 prompt 必须写明自己的长度上限，且数字与引擎一致 ─────────
  for (const item of mod.STYLE_ITEMS) {
    if (!item.band) throw new Error(`style ${item.id} lacks band label`)
    if (!item.bandBadge) throw new Error(`style ${item.id} lacks band badge`)
    if (!item.summary) throw new Error(`style ${item.id} lacks summary`)
    const ratio = String(bands[item.id].ratioMax)
    const plus = String(bands[item.id].plusChars)
    if (!item.prompt.includes(ratio)) {
      throw new Error(`style ${item.id} prompt does not mention ratio ${ratio}`)
    }
    if (!item.prompt.includes(`+ ${plus} 字`)) {
      throw new Error(`style ${item.id} prompt does not mention + ${plus} 字`)
    }
    if (!item.prompt.includes('长度上限')) {
      throw new Error(`style ${item.id} prompt lacks 长度上限 section`)
    }
    if (!item.prompt.includes('DSH 场景约定')) throw new Error(`style ${item.id} lacks DSH scene`)
    if (!item.prompt.includes('公共规则')) throw new Error(`style ${item.id} lacks COMMON`)
    // band 标签里的公式必须与引擎常量一致
    if (!item.band.includes(ratio) || !item.band.includes(`+ ${plus} 字`)) {
      throw new Error(`style ${item.id} band label does not match engine constants: ${item.band}`)
    }
  }
  console.log('prompts     : ✓ each states its own length bound + DSH scene + COMMON')

  // ── 4. 三档的禁止项必须互不相同（差异可感知的关键）────────────────────
  const brief = mod.STYLE_ITEMS.find((s) => s.id === 'brief').prompt
  const balanced = mod.STYLE_ITEMS.find((s) => s.id === 'balanced').prompt
  const detailed = mod.STYLE_ITEMS.find((s) => s.id === 'detailed').prompt

  if (!brief.includes('不得新增要求')) throw new Error('brief must forbid adding content')
  if (!balanced.includes('明确验收口径')) throw new Error('balanced must require acceptance criteria')
  if (!detailed.includes('去重与收紧')) throw new Error('detailed must forbid redundancy')
  if (!detailed.includes('步骤不超过 6 条')) throw new Error('detailed must cap section count')
  if (!detailed.includes('输入上下文')) throw new Error('detailed must have 输入上下文 section')
  if (brief.includes('明确验收口径')) throw new Error('brief must NOT require acceptance criteria')
  console.log('tiers       : ✓ brief=minimal / balanced=产出+验收 / detailed=要素补全+去重')

  // ── 5. 档位递增确实体现在长度上限数字上 ───────────────────────────────
  const briefRatio = bands.brief.ratioMax
  const balRatio = bands.balanced.ratioMax
  const detRatio = bands.detailed.ratioMax
  if (!(briefRatio < balRatio && balRatio < detRatio)) throw new Error('ratios not increasing')
  const briefPlus = bands.brief.plusChars
  const balPlus = bands.balanced.plusChars
  const detPlus = bands.detailed.plusChars
  if (!(briefPlus < balPlus && balPlus < detPlus)) throw new Error('plusChars not increasing')
  console.log('ratios      : ✓', briefRatio, '<', balRatio, '<', detRatio)
  console.log('plusChars   : ✓', briefPlus, '<', balPlus, '<', detPlus)

  console.log('\nBAND LOGIC TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
