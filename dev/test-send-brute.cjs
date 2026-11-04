/**
 * test-send-brute.cjs —— 对「发出去」做极限压测。
 *
 * 这一项比「先问一句」危险得多：它会把内容真的发进对话。
 * 发错了用户能看见，但代价是浪费一次模型调用、把上下文搅乱 ——
 * 所以边界必须钉死。
 *
 * 五组：
 *   1. 该拒绝的都拒绝（生成中 / 空结果 / 宿主能力缺失 / 各种畸形 state）
 *   2. 该发的一个字节都不许改（结果原样进草稿）
 *   3. 连点两次不许发两次
 *   4. 宿主抛异常不许吞掉
 *   5. 超长结果也要能发
 */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')

const CLIENT = process.env.DSHO_CLIENT || join(__dirname, '..', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

let failures = 0
function check(label, cond, detail) {
  if (cond) return
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

function extractFn(name) {
  const start = source.indexOf('async function ' + name + '(')
  if (start < 0) return null
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

const fnText = extractFn('sendToChat')
if (!fnText) { console.error('找不到 sendToChat'); process.exit(1) }

async function run(store, discard) {
  const f = new Function('previewStore', 'discardPreview',
    'return (async () => { ' + fnText + '\n return sendToChat })()')
  const fn = await f(store, discard)
  return fn()
}

async function main() {
  console.log('\n[1] 该拒绝的都拒绝')
  const rejectCases = [
    ['生成中', { phase: 'running', result: 'x' }],
    ['空闲态', { phase: 'idle', result: 'x' }],
    ['结果为空串', { phase: 'ready', result: '' }],
    ['结果全是空白', { phase: 'ready', result: '   \n\t  ' }],
    ['结果不是字符串', { phase: 'ready', result: 123 }],
    ['结果 null', { phase: 'ready', result: null }],
    ['结果 undefined', { phase: 'ready', result: undefined }],
    ['没有 phase', { result: 'x' }],
    ['state 是空对象', {}],
  ]
  for (const [label, state] of rejectCases) {
    const calls = []
    const store = {
      state,
      inputActions: { setDraft() { calls.push('setDraft') }, submit() { calls.push('submit') } },
    }
    const discarded = []
    let got
    try { got = await run(store, () => discarded.push(1)) } catch (e) {
      check(label + ' 不抛异常', false, e.message); continue
    }
    check(label + ' 不发', got === false && calls.length === 0 && discarded.length === 0,
      'r=' + got + ' calls=' + JSON.stringify(calls) + ' discard=' + discarded.length)
  }

  console.log('\n[2] 宿主能力缺失时安静退出')
  for (const [label, actions] of [
    ['没有 inputActions', null],
    ['没有 setDraft', { submit() {} }],
    ['没有 submit', { setDraft() {} }],
    ['setDraft 不是函数', { setDraft: 1, submit() {} }],
    ['submit 不是函数', { setDraft() {}, submit: 'x' }],
    ['两个都是 null', { setDraft: null, submit: null }],
  ]) {
    const store = { state: { phase: 'ready', result: 'x' }, inputActions: actions }
    let got
    try { got = await run(store, () => {}) } catch (e) {
      check(label + ' 不抛异常', false, e.message); continue
    }
    check(label + ' 返回 false', got === false, String(got))
  }

  console.log('\n[3] 该发的一个字节都不许改')
  const payloads = [
    '目标：更新 README。',
    '目标：更新 README。\n产出格式：改好的章节。\n验收标准：能照着做。',
    '第一行\n\n\n空行要保留\n\n',
    '  前后有空格  ',
    '含 ' + String.fromCharCode(96) + '代码' + String.fromCharCode(96) + ' 和 @路径/to/file.ts',
    'emoji 😀🎉 与中文混排',
    'a'.repeat(5000),
    '目标：' + '长'.repeat(3000),
    '- 列表项 1\n- 列表项 2\n- 列表项 3',
    'tab\t分隔\t内容',
  ]
  for (const payload of payloads) {
    const calls = []
    const store = {
      state: { phase: 'ready', result: payload },
      inputActions: {
        setDraft(t) { calls.push(['setDraft', t]) },
        submit() { calls.push(['submit']) },
      },
    }
    await run(store, () => {})
    const sent = calls[0] && calls[0][1]
    // 允许 trim 首尾空白（提交前会 trim），但内部结构一个字节都不许动。
    check('内容原样（' + JSON.stringify(payload.slice(0, 16)) + '）',
      typeof sent === 'string' && sent === payload.trim(),
      JSON.stringify(sent).slice(0, 80))
  }

  console.log('\n[4] 连点两次不许发两次')
  {
    const calls = []
    let discardCount = 0
    const store = {
      state: { phase: 'ready', result: '目标：x' },
      inputActions: {
        setDraft(t) { calls.push(['setDraft', t]) },
        submit() { calls.push(['submit']) },
      },
    }
    const discard = () => {
      discardCount++
      store.state = { ...store.state, phase: 'idle' }
    }
    const f = new Function('previewStore', 'discardPreview',
      'return (async () => { ' + fnText + '\n return sendToChat })()')
    const send = await f(store, discard)
    const first = await send()
    const second = await send()
    console.log('    第一次=' + first + ' 第二次=' + second + ' | submit 次数=' + calls.filter((c) => c[0] === 'submit').length)
    check('第一次成功', first === true, String(first))
    check('第二次被拒', second === false, String(second))
    check('只提交一次', calls.filter((c) => c[0] === 'submit').length === 1,
      String(calls.filter((c) => c[0] === 'submit').length))
  }

  console.log('\n[5] 宿主抛异常不许吞掉')
  {
    const store = {
      state: { phase: 'ready', result: '目标：x' },
      inputActions: { setDraft() { throw new Error('编辑器炸了') }, submit() {} },
    }
    let threw = false
    try { await run(store, () => {}) } catch (e) { threw = true }
    /*
     * 这里**允许**抛：宿主编辑器炸了，界面上的按钮不该假装成功。
     * 但必须是有意义的异常，不能是 undefined 之类。
     */
    check('异常会往外传（不吞掉）', threw === true, '异常被吞了')
  }

  console.log('')
  if (failures > 0) {
    console.error('SEND BRUTE TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
  } else {
    console.log('SEND BRUTE TEST PASSED')
  }
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
