/**
 * test-send.cjs —— 「发出去」：结果出来后直接送进对话，不用复制粘贴。
 *
 * 用户现在的流程：点优化 → 等几秒 → 看结果 → 点「替换草稿」→ 再按回车。
 * 中间那两步纯属多余 —— 他要的就是「把这句发出去」。
 *
 * 宿主暴露了 inputActions.submit()（见 SessionInputShell 的 actions），
 * 和 setDraft 是同一组。所以「发出去」= 写草稿 + 立即提交，一次点击。
 *
 * 三个必须成立的点：
 *   1. 顺序 —— 先 setDraft 再 submit。反了发出去的就是用户原来那句。
 *   2. 边界 —— 生成中、没有结果时不许发。
 *   3. 收尾 —— 发出去之后卡片要关掉，不然它还挡在那儿显示一个已经用掉的结果。
 */
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')

const CLIENT = process.env.DSHO_CLIENT || join(__dirname, '..', 'client.js')

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

function makeReact() {
  const createElement = (type, props, ...children) => {
    const flat = children.flat(Infinity)
    return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } }
  }
  class Component { constructor(props) { this.props = props } render() { return null } }
  return {
    createElement, useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {}, useCallback: (f) => f, useRef: (v) => ({ current: v }),
    useMemo: (f) => f(), Component, Fragment: 'Fragment',
    memo: (c) => c, forwardRef: (c) => c, useLayoutEffect: () => {},
    createContext: () => ({ Provider: 'Provider' }), useContext: () => ({}),
  }
}

const source = readFileSync(CLIENT, 'utf8')
const React = makeReact()
let factory = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1200,
  },
  console,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: {
    _data: new Map(),
    getItem(k) { return this._data.has(k) ? this._data.get(k) : null },
    setItem(k, v) { this._data.set(k, String(v)) },
    removeItem(k) { this._data.delete(k) },
    clear() { this._data.clear() },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: CLIENT })
if (!factory) throw new Error('client.js 没有注册 __ModuleLoader__.load')

console.log('\n[1] 要有「发出去」这个动作')
check('有 sendToChat 之类的实现', /sendToChat|submitDraft|发出|发送/u.test(source),
  '找不到发送实现')
// 宿主那组动作在代码里叫 actions（来自 previewStore.inputActions），
  // 这里查的是「确实调了 submit」+「它确实取自 inputActions」两件事。
check('调用了宿主的 submit', /\bactions\.submit\s*\(/u.test(source),
  '没有调用 actions.submit()')
check('actions 取自 inputActions', /previewStore\.inputActions/u.test(source),
  '没有从 previewStore 取 inputActions')
check('注入时检查了 submit 是否存在', /typeof actions\.submit !== 'function'/u.test(source),
  '没有检查宿主是否提供 submit')
check('卡片上有按钮', /'发出去'|'发送'/u.test(source), '没有按钮文案')

console.log('\n[2] 顺序必须是先写草稿再提交')
{
  /*
   * 反了的话，发出去的是用户原来那句 —— 而且不会报错，
   * 用户只会看到「我点了发出去，发出去的还是原文」，比不工作还糟。
   */
  const fn = /function sendToChat[\s\S]{0,900}?\n    \}/u.exec(source)
  check('找得到 sendToChat 实现', fn !== null, '没有这个函数')
  if (fn) {
    const body = fn[0]
    const setAt = body.indexOf('setDraft')
    const submitAt = body.search(/\.submit\s*\(/u)
    check('先 setDraft', setAt >= 0, '没有 setDraft')
    check('后 submit', submitAt >= 0, '没有 submit')
    check('setDraft 在 submit 之前', setAt >= 0 && submitAt > setAt,
      'setDraft@' + setAt + ' submit@' + submitAt)
  }
}

console.log('\n[3] 边界：生成中 / 没结果时不许发')
{
  const g = /sendToChat[\s\S]{0,600}/u.exec(source)
  check('检查了 phase', g !== null && /phase\s*!==\s*'ready'|phase\s*===\s*'running'/u.test(g[0]),
    '没有挡住生成中的情况')
  check('检查了空结果', g !== null && /length\s*>\s*0|trim\(\)/u.test(g[0]),
    '没有挡住空结果')
}

console.log('\n[4] 发出去之后卡片要收起来')
{
  const g = /sendToChat[\s\S]{0,1400}/u.exec(source)
  check('发送成功后关卡片', g !== null && /reset\(\)|discardPreview|phase:\s*'idle'/u.test(g[0]),
    '发送后卡片还开着')
}

console.log('\n[5] 卡片自己要能拿到输入动作')
{
  /*
   * 预览卡住在 conversation.input.dock 槽位，自己就拿得到 standardProps。
   * 只靠按钮组件注入的话，按钮不在场时（从设置页回来、会话头还没挂载）
   * inputActions 是 null —— 「替换草稿」和「发出去」都会静默失效，
   * 而且不会报错，用户只会觉得「点了没反应」。
   */
  const cardStart = source.indexOf('function PreviewCard(props)')
  const card = cardStart < 0 ? null : [source.slice(cardStart, cardStart + 2500)]
  check('切得出 PreviewCard', card !== null, '找不到 PreviewCard')
  check('PreviewCard 自己注入 inputActions',
    card !== null && /previewStore\.inputActions\s*=\s*props\.inputActions/u.test(card[0]),
    'PreviewCard 没自己注入')
}

console.log('\n[6] 追问状态下不给「发出去」')
{
  /*
   * 追问时正文框里放的是原文。这时候点「发出去」等于把用户刚写的话原样发出去 ——
   * 他要的是「帮我改」，不是「帮我发」。
   */
  const branch = /clarifyQuestions\.length > 0[\s\S]*?'仍要优化'/u.exec(source)
  check('切得出追问分支', branch !== null, '找不到追问分支')
  check('追问分支里没有「发出去」', branch !== null && !/'发出去'/u.test(branch[0]),
    '追问分支里出现了「发出去」')
}

console.log('')
if (failures > 0) {
  console.error('SEND TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('SEND TEST PASSED')
}
