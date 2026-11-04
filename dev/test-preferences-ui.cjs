/**
 * test-preferences-ui.cjs —— 偏好必须在设置页里能加、能看、能删。
 *
 * 引擎侧已经会读 preferences 了（见 test-preferences.cjs），但如果设置页里
 * 没有入口，这个功能等于不存在 —— 用户不可能自己去改 settings.json。
 *
 * 要看到的行为：
 *   1. 设置页有「我的偏好」这一段
 *   2. 有输入框 + 添加按钮
 *   3. 已有的偏好逐条列出来，每条带删除键
 *   4. 回车能直接加（一句话输入不该逼人去点按钮）
 *   5. 空输入时添加按钮禁用
 *   6. 满 20 条时添加按钮禁用，并说明原因
 *   7. 存的是 preferences 字段（不是 customPrompt，不是别的名字）
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
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {} },
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

console.log('\n[1] 设置页要有「我的偏好」这一段')
check('有这一段标题', /'我的偏好'/u.test(source), '找不到「我的偏好」')
check('有说明文字（和「自定义」的区别）', /不换掉整份提示词|只加几条规则/u.test(source),
  '用户看不出它和自定义档的区别')

console.log('\n[2] 能加')
check('有输入框', /dsho-pref-input/u.test(source), '没有输入框')
check('有添加按钮', /dsho-pref-btn/u.test(source), '没有添加按钮')
check('添加按钮调 addPreference', /addPreference/u.test(source), '没有添加的处理函数')
check('存的是 preferences 字段', /preferences:\s*\[\s*\.\.\.preferences/u.test(source)
  || /preferences:\s*next/u.test(source), '没有把 preferences 存回去')

console.log('\n[3] 能看能删')
check('逐条渲染已有偏好', /preferences\.map\(/u.test(source), '没有遍历 preferences')
check('每条有删除键', /dsho-pref-del/u.test(source), '没有删除键')
check('删除按索引过滤', /preferences\.filter\(\(_, i\) => i !== index\)/u.test(source),
  '删除逻辑不对')

console.log('\n[4] 回车能直接加')
check('输入框处理 Enter', /onKeyDown/u.test(source) && /key === 'Enter'/u.test(source),
  '回车没处理')
check('回车时调 addPreference', /key === 'Enter'[\s\S]{0,200}?addPreference/u.test(source),
  '回车没接上添加')
check('输入法组合中不触发', /isComposing/u.test(source), '中文输入法选词时会误触')

console.log('\n[5] 空输入时禁用')
check('空输入禁用添加', /prefDraft\.trim\(\)\.length === 0[\s\S]{0,60}?disabled/u.test(source)
  || /disabled:[\s\S]{0,120}?prefDraft\.trim\(\)\.length === 0/u.test(source),
  '空输入也能点添加')

console.log('\n[6] 满 20 条时禁用并说明')
check('满 20 条禁用', /preferences\.length >= 20/u.test(source), '没有上限判断')
check('满 20 条有说明', /已经 20 条了|最多 20 条/u.test(source), '禁用时用户不知道为什么')

console.log('\n[7] 样式')
for (const cls of ['dsho-pref-list', 'dsho-pref-row', 'dsho-pref-text', 'dsho-pref-del',
  'dsho-pref-add', 'dsho-pref-input', 'dsho-pref-btn']) {
  check('有 .' + cls + ' 样式', new RegExp('\\.' + cls + '\\s*\\{', 'u').test(source),
    '没有样式，会挤成一坨')
}

console.log('')
if (failures > 0) {
  console.error('PREFERENCES UI TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('PREFERENCES UI TEST PASSED')
}
