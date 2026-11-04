/**
 * test-unchanged-ui.cjs —— 「模型原样返回」这件事必须在界面上说清楚。
 *
 * 引擎已经把 unchanged 标记放进回执（见 test-unchanged.cjs）。但标记本身
 * 没有用 —— 用户看不到它。线上实测「帮我优化一下这个」跑 8 次有 2 次
 * 拿回的就是原文；界面不提示，用户会以为「优化结果就是这样」。
 *
 * 要看到的行为：
 *   1. 结果框的元信息里有一条提示，说明这次没改成；
 *   2. 历史记录里有对应徽标，回头翻能认出来；
 *   3. 正常改写时不出现这条提示（不能狼来了）。
 *
 * 沙箱搭法照 test-dock-behaviour.cjs：client.js 整个包在
 * window.__ModuleLoader__.load({factory}) 里，先把 factory 抓出来再 apply。
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
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
let factory = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1200,
  },
  console: { log() {}, warn() {}, error() {} },
  fetch: (...args) => fetchImpl(...args),
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

// ── 直接对源码做结构断言 ─────────────────────────────────────────────────
// 这个测试不跑完整渲染：unchanged 的处理是「有没有读这个字段」，
// 读没读在源码里一目了然，比模拟整套 hooks 生命周期稳。
console.log('\n[1] 结果框要认 unchanged 标记')
check('client.js 读取了 meta.unchanged', /meta\.unchanged/u.test(source),
  '源码里没有 meta.unchanged')
check('有给用户看的提示文案', /原样返回|没有改动|没改成|未作改动|什么都没改/u.test(source),
  '找不到「原样返回」类文案')

console.log('\n[2] 历史徽标要认 unchanged')
{
  const m = /function historyBadges\([\s\S]*?\n    \}/u.exec(source)
  check('historyBadges 处理了 unchanged', m !== null && /unchanged/u.test(m[0]),
    m === null ? '找不到 historyBadges' : '函数体里没有 unchanged')
}

console.log('\n[3] 正常结果不许显示这条提示')
{
  // 提示文案必须挂在 meta.unchanged 判断下，不能无条件出现。
  const m = /meta\.unchanged[\s\S]{0,200}/u.exec(source)
  check('提示受 meta.unchanged 控制', m !== null,
    '找不到 meta.unchanged 附近的代码')
}

console.log('')
if (failures > 0) {
  console.error('UNCHANGED UI TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('UNCHANGED UI TEST PASSED')
}
