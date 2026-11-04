/**
 * test-prefs-fallback-cover.cjs —— 补上两个没有直接测到的函数。
 *
 * 覆盖率自检查出两个函数只在别处被间接用到，没有测试直接盯着它们：
 *   - appendPreferences：把偏好拼进提示词的那一步
 *   - openSettingsPanel：点开设置面板（失败时「去选模型」走的路）
 *
 * 这两个恰恰是最容易悄悄坏掉的地方：
 *   前者拼接位置错了，偏好就会顶掉公共规则；
 *   后者找错了按钮，用户点了没反应 —— 而「没反应」在测试里不报错。
 */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

const ROOT = join(__dirname, '..')
const CLIENT = process.env.DSHO_CLIENT || join(ROOT, 'client.js')
const PLUGIN = process.env.DSHO_PLUGIN || join(ROOT, 'index.js')

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

console.log('\n[1] appendPreferences 的拼接位置')
{
  /*
   * 直接读源码判断，不走运行时：这个函数是模块私有的，
   * 而它唯一的行为就是「插在哪儿」。测位置比测返回值更直接。
   */
  const src = readFileSync(PLUGIN, 'utf8')
  const fn = /function appendPreferences\(base, preferences\) \{[\s\S]*?\n\}/u.exec(src)
  check('切得出 appendPreferences', fn !== null, '找不到函数体')
  const body = fn ? fn[0] : ''
  check('用公共规则的标题做定位锚', body.includes('公共规则（三档都适用'), '没有锚点')
  check('插在锚点之前（slice(0, idx) + block + slice(idx)）',
    /base\.slice\(0, idx\) \+ block \+ '\\n\\n' \+ base\.slice\(idx\)/u.test(body),
    '拼接方式不是「插在锚点之前」')
  check('没有偏好时原样返回', /list\.length === 0\) return base/u.test(body), '空偏好也拼了一段')
  check('找不到锚点时追加到末尾（不丢偏好）', /idx < 0\) return base \+ '\\n\\n' \+ block/u.test(body),
    '锚点缺失时偏好会静默丢掉')
  check('写明冲突时以档位/公共规则为准', body.includes('以那些规则为准'), '没有这句兜底')
}

console.log('\n[2] openSettingsPanel 的行为')
{
  const source = readFileSync(CLIENT, 'utf8')
  const fn = /function openSettingsPanel\(\) \{[\s\S]*?\n    \}/u.exec(source)
  check('切得出 openSettingsPanel', fn !== null, '找不到函数')
  const body = fn ? fn[0] : ''
  check('不跳 URL（会 404）', !body.includes('location.assign') && !body.includes('location.href'),
    '还在跳 URL')
  check('找「设置」文字的按钮', body.includes("=== '设置'"), '没有按文字找')
  check('也认 aria-label / title', body.includes('aria-label') && body.includes('title'),
    '只认文字，图标按钮找不到')
  check('点的是 click()', body.includes('.click()'), '找到了却没点')
  check('找不到就返回 false', /return false/u.test(body), '找不到时没告诉调用方')
  check('异常也不抛', /catch/u.test(body), '没兜异常，一个 DOM 异常会带崩按钮')
}

console.log('\n[3] 调用方要处理「找不到设置入口」')
{
  const source = readFileSync(CLIENT, 'utf8')
  check('openSettingsPanel 返回 false 时给文案',
    /if \(!openSettingsPanel\(\)\)[\s\S]{0,300}?setError/u.test(source),
    '找不到入口就静默失败，用户点了没反应')
  check('文案里写了路径', /设置 → 优化/u.test(source), '没说清去哪')
}

console.log('')
if (failures > 0) {
  console.error('COVER TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('COVER TEST PASSED')
}
