/**
 * test-manifest.cjs —— 插件清单与官方发布契约一致。
 *
 * DSH 0.2.x 的插件管理器按「包根的 icon 字段 / 导出的 ./icon」取图标，
 * 按「导出的 locale/<语言>.json 里的 meta.title/description」取标题与描述，
 * 缺失时回退默认插画与 package.json 的 description。
 * 这不会阻断加载，但插件在「插件」页里会变成一行没有名字的默认卡片，
 * 所以把它当成契约的一部分来断言。
 *
 * 用 node:test 之外的最小断言：run-all.cjs 只认退出码。
 */
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function check(ok, message) {
  if (!ok) throw new Error(message)
}

// 1. 官方模板要求的四项导出：. / ./client / ./locale/*.json / ./icon
check(pkg.exports && pkg.exports['.'] === './index.js', 'exports["."] must point at index.js')
check(pkg.exports['./client'] === './client.js', 'exports["./client"] must point at client.js')
check(pkg.exports['./locale/*.json'] === './locale/*.json', 'exports must expose ./locale/*.json')
check(pkg.exports['./icon'] === './icon.svg', 'exports must expose ./icon')
check(pkg.icon === './icon.svg', 'package.json icon field must point at icon.svg')

// 2. 声明了的文件必须真的存在，且写进 files（否则 npm 打包会漏掉）
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
  check(existsSync(path.join(ROOT, required)), 'missing file: ' + required)
  check(pkg.files.includes(required), 'files[] must include ' + required)
}
check(pkg.files.includes('locale/*.json'), 'files[] must include locale/*.json')

// 3. 每种界面语言都要有一份能解析的 locale，且带 meta.title / meta.description
const { readdirSync } = require('node:fs')
const localeDir = path.join(ROOT, 'locale')
check(existsSync(localeDir), 'missing locale/ directory')
const locales = readdirSync(localeDir).filter((name) => name.endsWith('.json'))
check(locales.length > 0, 'locale/ has no .json files')
for (const name of locales) {
  const text = readFileSync(path.join(localeDir, name), 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('locale/' + name + ' is not valid JSON: ' + error.message)
  }
  check(typeof parsed?.meta?.title === 'string' && parsed.meta.title.length > 0,
    'locale/' + name + ' must carry meta.title')
  check(typeof parsed?.meta?.description === 'string' && parsed.meta.description.length > 0,
    'locale/' + name + ' must carry meta.description')
  // meta.detail 若指向文档，文件必须存在 —— 否则插件页会显示读取失败
  if (typeof parsed.meta.detail === 'string') {
    check(existsSync(path.join(ROOT, parsed.meta.detail)), 'locale/' + name + ' meta.detail points at a missing file')
  }
}
check(locales.includes('zh.json') && locales.includes('en.json'), 'locale needs zh.json and en.json at least')

// 4. icon 必须是可解码的 SVG（插件管理器会解码，坏了就退回默认插画）
const icon = readFileSync(path.join(ROOT, 'icon.svg'), 'utf8')
check(icon.includes('<svg'), 'icon.svg must contain an <svg> root')
check(/viewBox="[^"]+"/u.test(icon), 'icon.svg should declare a viewBox so it scales in the row')

// 5. 客户端半区的入口形态（插件管理器按 dsh.client 找 bundle）
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at cordis.patch.yml')

console.log('manifest    : ✓ exports / files / icon / locale 与官方发布契约一致')
console.log('locales     : ' + locales.join(', '))
console.log('ALL MANIFEST TESTS PASSED')
