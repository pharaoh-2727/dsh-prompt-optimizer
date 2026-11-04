/**
 * test-clarify-brute.cjs —— 对「先问一句」做极限压测。
 *
 * 上一版（test-clarify.cjs）测的是「该问的问了、不该问的没问」。
 * 这个文件问的是另一类问题：**判据在边界上会不会崩、会不会误伤**。
 *
 * 五组：
 *   1. 误伤：真实用户会写的、有对象的句子，一个都不许被判成「要问」
 *   2. 漏判：各种含糊写法，都要能认出来
 *   3. 极端输入：超长、控制字符、全 emoji、纯标点 —— 不许抛异常，且不许卡死
 *   4. 性能：一万次判定要在合理时间内跑完（它挂在每次优化的入口上）
 *   5. 一致性：needsClarification 为 true 时，classifyInput 必须是 'c'
 *
 * 退出码非 0 表示有失败项。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-clarify-brute')

let failures = 0
function check(label, cond, detail) {
  if (cond) return
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  stubModel(join(TMP, 'profile'))
  writeFileSync(join(TMP, 'prompt-optimizer', 'settings.json'), JSON.stringify({
    modelMode: 'auto', provider: '', model: '', style: 'balanced', customPrompt: '', freeChannelAsked: true,
  }, null, 2))
  process.env.DSH_HOME = TMP
  const mod = await import(pathToFileURL(PLUGIN).href)
  const needsClarify = mod.needsClarification
  const classify = mod.classifyInput

  console.log('\n[1] 误伤：有对象的句子，一个都不许问')
  /*
   * 这一组是**最重要的**。判据宁可漏判（少问一句，用户直接拿到一次平庸的改写），
   * 也不能误伤（用户明明说清了，却被拦下来问「你说的是哪个」—— 那是在浪费他的时间）。
   */
  const REAL = [
    '把 README 的安装章节更新一下',
    '帮我把这个插件的日志功能补上',
    '帮我写个登录页',
    '把 src/app.ts 里的重试逻辑改一下',
    '跑一下 npm test',
    '别用 any',
    '压到 500 字以内',
    '用 TypeScript 重写',
    '运行时报错 TypeError: x is not a function，帮我修掉',
    '把 for 循环换成 while',
    '这里应该用 Map 而不是 Object',
    '加一个超时',
    '给 fetch 加 3 秒超时',
    '把 utils.ts 里的 parseDate 抽成独立模块',
    '把这段 JSON 转成 YAML',
    '重构 retry helper',
    '把按钮改成圆角',
    '登录页的文案再短一点',
    '这个报错怎么修？',
    '这个插件怎么用？',
    '为什么构建这么慢？',
    '在 docs/ 下新建一个 FAQ.md',
    '把 package.json 里的 version 改成 0.2.0',
    '删掉未使用的 import',
    '把这段正则改成非贪婪',
    '帮我评审一下 src/server.ts 的错误处理',
    '把这三条测试用例合并成一个',
    '让 CLI 支持 --verbose 参数',
    '把暗色模式下的对比度调高',
    '重写这个 SQL 查询，避免全表扫描',
    '把这个函数拆成两个，一个只负责校验',
    '把 docs 里的链接全部检查一遍',
    '把 @README.md 的第二节删掉',
    '给这个接口加限流，每分钟 100 次',
    '把日志级别从 debug 改成 info',
    '用 Python 重写这个脚本',
    '把测试覆盖率提到 80% 以上',
    '帮我看看 http://localhost:3000 为什么 404',
    '把 <Button /> 的 onClick 换成箭头函数',
    '整理一下 CHANGELOG 里 0.1.3 那一段',
    // 延续性输入：对象在上下文里，不在这儿。
    '这个不对',
    '这里错了',
    '那个有问题',
    '重来',
    '接着做',
    '按刚才的来',
  ]
  for (const t of REAL) {
    check('「' + t + '」不该问', needsClarify(t) === false, '判成了要问')
  }

  console.log('\n[2] 漏判：含糊写法都要认出来')
  const VAGUE = [
    '帮我优化一下这个',
    '把那个改一下',
    '优化一下这段',
    '帮我改改这个吧',
    '整理一下那个',
    '这个帮我弄一下',
    '优化这个',
    '改改这段',
    '把这个弄一下',
    '那个再改改',
    '帮我看看这个',
    '这段优化下',
    '弄一下这个',
    '这个处理一下',
    '优化一下它',
  ]
  for (const t of VAGUE) {
    check('「' + t + '」该问', needsClarify(t) === true, '漏判了')
  }

  console.log('\n[3] 极端输入：不许抛异常，不许卡死')
  const EXTREME = [
    '', ' ', '\n', '\t', '\u0000', '\u0000\u0000', '。', '？？？', '！！！',
    '😀', '😀😀😀😀', '🎉🎉', 'a', 'ab', 'abc', 'a'.repeat(1000),
    'a'.repeat(20000), '帮'.repeat(20000), '这个'.repeat(5000),
    '这个\u0000那个', '\uD800', '\uDFFF', '\uFFFF',
    '帮我优化一下这个' + 'x'.repeat(19980),
    '  帮我优化一下这个  ',
    '\n\n帮我优化一下这个\n\n',
    '这个'.repeat(3) + ' 那个'.repeat(3),
    '???', '...', '——', '～～～',
    '帮我优化一下这个帮我优化一下这个帮我优化一下这个',
  ]
  for (const t of EXTREME) {
    const label = JSON.stringify(String(t).slice(0, 14))
    let got
    try { got = needsClarify(t) } catch (e) {
      check('极端输入 ' + label + ' 不抛异常', false, e.message)
      continue
    }
    check('极端输入 ' + label + ' 返回布尔', typeof got === 'boolean', String(got))
  }
  // 非字符串输入
  for (const t of [null, undefined, 0, 1, NaN, true, false, {}, [], [1, 2], () => {}]) {
    let got
    try { got = needsClarify(t) } catch (e) {
      check('非字符串 ' + String(t) + ' 不抛异常', false, e.message)
      continue
    }
    check('非字符串 ' + String(t) + ' 返回布尔', typeof got === 'boolean', String(got))
  }

  console.log('\n[4] 性能：一万次判定要在 1 秒内跑完')
  {
    const sample = REAL.concat(VAGUE)
    const t0 = Date.now()
    for (let i = 0; i < 10000; i++) needsClarify(sample[i % sample.length])
    const ms = Date.now() - t0
    console.log('    10000 次判定 ' + ms + 'ms')
    check('一万次判定 < 1000ms', ms < 1000, ms + 'ms')
  }
  // 超长输入的性能（正则回溯风险）
  {
    const huge = '帮我优化一下这个' + 'x'.repeat(19900)
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) needsClarify(huge)
    const ms = Date.now() - t0
    console.log('    20 次 2 万字判定 ' + ms + 'ms')
    check('超长输入不卡死（20 次 < 3000ms）', ms < 3000, ms + 'ms')
  }

  console.log('\n[5] 一致性：要问的一定是任务类')
  for (const t of REAL.concat(VAGUE)) {
    if (needsClarify(t) === true) {
      check('「' + t + '」要问时必须是 c 类', classify(t) === 'c', '是 ' + classify(t))
    }
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failures > 0) {
    console.error('CLARIFY BRUTE TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('CLARIFY BRUTE TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
