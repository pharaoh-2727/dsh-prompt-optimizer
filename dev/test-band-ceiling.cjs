/**
 * test-band-ceiling.cjs —— 提示词承诺的长度上限必须与代码封顶一致。
 *
 * 案发经过：提示词对模型说「不超过原文的 2.2 倍」，代码却在 4000 字处封顶。
 * 3960 字的输入，提示词承诺 8712 字，代码只给 4000 —— 差 4712 字。
 * 模型照着提示词写，必然被判 too-long 然后反复重试，白烧 token。
 *
 * 这条测试把「承诺」和「实现」钉在一起：三档的提示词里必须写出实际封顶字数，
 * 且那个数字必须等于 STYLE_BANDS 的 absMax。
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log('  PASS  ' + name)
  } catch (error) {
    fail += 1
    console.error('  FAIL  ' + name + ' —— ' + error.message)
  }
}

/** 从源码读三档的封顶值，避免测试自己抄一份抄错。 */
function readBands() {
  const src = readFileSync(PLUGIN, 'utf8')
  const bands = {}
  const re = /(\w+): \{ ratioMax: ([\d.]+), plusChars: (\d+), absMax: (\d+) \}/g
  let m
  while ((m = re.exec(src)) !== null) {
    bands[m[1]] = { ratioMax: Number(m[2]), plusChars: Number(m[3]), absMax: Number(m[4]) }
  }
  return bands
}

async function main() {
  const { STYLE_ITEMS } = await import(require('node:url').pathToFileURL(PLUGIN).href + '?v=' + Date.now())
  const bands = readBands()

  for (const item of STYLE_ITEMS) {
    const band = bands[item.id]
    // 提示词里必须写出封顶字数（不是只写倍数）。
    check(item.id + ' 提示词写明封顶字数 ' + band.absMax, () => {
      if (!item.tierPrompt.includes(String(band.absMax))) {
        throw new Error('提示词里找不到 ' + band.absMax + '，模型无从知道真实上限')
      }
    })
    // 且必须说清「封顶优先于倍数」。
    check(item.id + ' 提示词说明两者取小', () => {
      if (!/封顶|取小|不超过.*字/u.test(item.tierPrompt)) {
        throw new Error('没有说明倍数与封顶的关系')
      }
    })
    // band 文案也要对齐（设置页给用户看的那句）。
    check(item.id + ' band 文案含封顶值', () => {
      if (!item.band.includes(String(band.absMax))) {
        throw new Error('band 文案写的是「' + item.band + '」，没提封顶 ' + band.absMax)
      }
    })
  }

  // 反证：倍数上限确实会在长输入上超过封顶 —— 这就是必须写封顶的原因。
  check('长输入下倍数确实会超过封顶（说明这条规则不是多余的）', () => {
    const band = bands.detailed
    const longLen = Math.ceil(band.absMax / band.ratioMax) + 500
    const byRatio = Math.round(longLen * band.ratioMax)
    if (byRatio <= band.absMax) {
      throw new Error('构造的输入不够长，测不到这个现象')
    }
  })

  if (fail > 0) {
    console.error('\n失败 ' + fail + ' / ' + (pass + fail))
    process.exit(1)
  }
  console.log('\nALL BAND CEILING TESTS PASSED')
}

main().catch((error) => { console.error(error); process.exit(1) })
