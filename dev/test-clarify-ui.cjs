/**
 * test-clarify-ui.cjs —— 「先问一句」必须在界面上看得见、点得动。
 *
 * 引擎侧已经在回执里放了 needsClarification 与 questions（见 test-clarify.cjs）。
 * 但标记本身没用 —— 用户看到的是卡片。如果卡片还是显示「结果」和
 * 「替换草稿 / 复制」，用户会以为那就是优化结果。
 *
 * 要看到的行为：
 *   1. 状态里记了 needsClarification 与 questions；
 *   2. 卡片上有追问区，把问题逐条列出来；
 *   3. 有「仍要优化」的出口 —— 用户不想答的时候能强行改；
 *   4. 正常结果不显示追问区。
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
  console: { log() {}, warn() {}, error() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  setTimeout, clearTimeout,
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

const registered = {}
const ctx = {
  provide: () => {}, effect: () => {},
  slots: {
    inject: (_n, fn) => fn(),
    register: (options, component) => { registered[options.name] = { options, component }; return component },
  },
}
factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}).apply(ctx)

console.log('\n[1] 状态层要接住 needsClarification 与 questions')
check('读取了 needsClarification', /needsClarification/u.test(source), '源码里没有 needsClarification')
check('状态里存了 questions', /questions:/u.test(source), '没有 questions 字段')

console.log('\n[2] 卡片上要有追问区')
check('有追问区的渲染逻辑', /dsho-dock-clarify|clarify/u.test(source), '找不到追问区的类名或标识')
check('逐条列出问题', /(?:clarify)?questions?\.map\(/iu.test(source), '没有遍历 questions')

console.log('\n[3] 要有「仍要优化」的出口')
check('有跳过追问的按钮', /仍要优化|跳过|直接改|不用问|skipClarify/u.test(source),
  '用户不想回答时没有出口')

console.log('\n[4] 追问时不许给「结果类」按钮')
{
  /*
   * 追问时正文框里放的是原文。如果还挂着「复制」「替换草稿」，
   * 用户复制到的就是他刚写的那句话，替换草稿等于把输入框换回它自己 ——
   * 两个按钮都在骗人。只留「放弃」和「仍要优化」。
   */
  // 精确切出追问分支：从 clarifyQuestions.length > 0 到 '仍要优化' 为止。
  const branch = /clarifyQuestions\.length > 0[\s\S]*?'仍要优化'/u.exec(source)
  check('切得出追问分支', branch !== null, '找不到追问分支')
  const branchText = branch ? branch[0] : ''
  check('追问分支里没有「复制」', !/'复制'/u.test(branchText), '追问分支里仍有「复制」按钮')
  check('追问分支里有「放弃」', /'放弃'/u.test(branchText), '追问分支里没有「放弃」')
  check('追问分支里没有「替换草稿」', !/clarifyQuestions\.length > 0[\s\S]{0,1600}?'替换草稿'/u.test(source),
    '追问分支里仍有「替换草稿」按钮')
  check('追问时标题不是「优化结果」', /clarifyQuestions\.length > 0[\s\S]{0,120}?需要补充信息/u.test(source),
    '标题没跟着追问状态变')
}

console.log('\n[5] 正常结果不显示追问区')
{
  // 追问区必须挂在 needsClarification 判断下。
  const m = /needsClarification[\s\S]{0,400}/u.exec(source)
  check('追问区受 needsClarification 控制', m !== null, '找不到 needsClarification 附近的代码')
}

console.log('')
if (failures > 0) {
  console.error('CLARIFY UI TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('CLARIFY UI TEST PASSED')
}
