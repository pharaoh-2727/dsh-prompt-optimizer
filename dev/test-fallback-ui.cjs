/**
 * test-fallback-ui.cjs —— 失败时的备选动作，界面上要看得见、点得动。
 *
 * 引擎侧已经在回执里放了 options（见 test-fallback-options.cjs）。
 * 但标记本身没用 —— 用户看到的是那颗「优化」按钮下面的一行红字。
 * 如果那行字下面还是空的，用户仍然只知道「失败了」，不知道下一步点什么。
 *
 * 要看到的行为：
 *   1. 状态层接住了 options；
 *   2. 有备选时把它们渲染成按钮，逐个带 label；
 *   3. 有备选时不自动消失（5 秒倒计时会把还没点的按钮吞掉）；
 *   4. 四种 kind 各有对应的处理，不能点了没反应；
 *   5. 没备选时维持原样（只显示文案）。
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
    location: { assign: () => {} },
  },
  console: { log() {}, warn() {}, error() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  setTimeout, clearTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
  document: { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} },
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

console.log('\n[1] 状态层要接住 options')
check('有 errorOptions 之类的状态', /errorOptions|setErrorOptions/u.test(source), '找不到存备选的状态')
check('showError 接受 options', /showError\s*=\s*useCallback\(\s*\(\s*message[^)]*options/u.test(source)
  || /showError\([^)]*,\s*[^)]*options/u.test(source), 'showError 只收一个参数')
check('runOptimize 的返回值带 options', /options:\s*Array\.isArray\(result\.options\)/u.test(source),
  'runOptimize 没把 options 传出来')

console.log('\n[2] 有备选时渲染成按钮')
check('有备选区的渲染', /dsho-err-options|errOptions/u.test(source), '找不到备选区')
check('逐个渲染备选', /errorOptions\.map\(/u.test(source), '没有遍历 errorOptions')
check('每个按钮带 label', /option\.label|item\.label/u.test(source), '按钮没有 label')
check('有备选区的样式', /\.dsho-err-options\s*\{/u.test(source), '没有样式，会挤成一坨')

console.log('\n[3] 有备选时不许自动消失')
{
  const m = /const list = Array\.isArray\(options\)[\s\S]{0,400}?setTimeout/u.exec(source)
  check('切得出「有备选时不设定时器」的分支', m !== null, '找不到那段判断')
  const block = m ? m[0] : ''
  check('只在没备选时才 setTimeout', /list\.length === 0[\s\S]{0,80}?setTimeout/u.test(block),
    '有备选也照样 5 秒消失，用户还没点就没了')
}

console.log('\n[4] 四种 kind 各有处理')
for (const kind of ['retry', 'switch-style', 'shorten', 'pick-model']) {
  check('处理了 ' + kind, new RegExp("kind === '" + kind + "'", 'u').test(source),
    kind + ' 点了没反应')
}
check('open-settings 也处理了', /kind === 'open-settings'|kind === 'pick-model' \|\| kind === 'open-settings'/u.test(source),
  'open-settings 点了没反应')

console.log('\n[5] 没备选时维持原样')
check('空数组时不渲染备选区', /errorOptions\.length === 0[\s\S]{0,120}?null/u.test(source),
  '空数组也渲染了一个空容器')

console.log('\n[6] 点完之后要清掉，不能留着上一次的按钮')
check('点备选时先清空', /setErrorOptions\(\[\]\)/u.test(source), '点了之后按钮还留着')

console.log('')
if (failures > 0) {
  console.error('FALLBACK UI TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('FALLBACK UI TEST PASSED')
}
