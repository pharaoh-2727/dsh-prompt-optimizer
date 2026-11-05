/**
 * test-hooks-order.cjs —— 组件不能在不同渲染之间改变 hook 数量。
 *
 * 为什么值得单独一套：v0.1.4 的「我的偏好」把两个 useCallback 写在了
 * 「设置还没读回来就 return」之后。首帧只跑 10 个 hook，等设置到了变成 12 个，
 * React 直接抛 "Rendered more hooks than during the previous render."，
 * 被 safe() 错误边界兜住 —— 用户看到的是一整页只剩「优化设置加载出错」。
 * 这种错在离线测试里看不出来，因为假 React 的 hook 不计数。
 *
 * 所以这里做两件事：
 *   1. 静态：任何一个组件函数里，顶格的 return 之后不允许再出现 hook 调用。
 *   2. 动态：用一个会计数的假 React，把每个注册组件按两种状态各渲染一次，
 *      两次的 hook 数必须相等。
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

const source = readFileSync(CLIENT, 'utf8')

console.log('\n[1] 静态：顶格 return 之后不能再调 hook')

/** 取出每个组件函数体（以 4 空格缩进的 function 声明为界）。 */
function componentBodies(text) {
  const lines = text.split('\n')
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^    function ([A-Z]\w*)\(/)
    if (m) heads.push({ name: m[1], index: i })
  }
  return heads.map((head, k) => ({
    name: head.name,
    lines: lines.slice(head.index, k + 1 < heads.length ? heads[k + 1].index : lines.length),
    startLine: head.index + 1,
  }))
}

const HOOK_RE = /\buse(State|Effect|Callback|Ref|Memo|LayoutEffect|ImperativeHandle|Reducer)\s*\(/
const offenders = []
for (const body of componentBodies(source)) {
  let firstReturnAt = -1
  for (let j = 1; j < body.lines.length; j++) {
    const line = body.lines[j]
    // 组件函数体是一层缩进（6 空格）的 return，嵌套在 if 里的会更深
    if (firstReturnAt === -1 && /^\s{6}return\b/.test(line)) firstReturnAt = j
    if (firstReturnAt !== -1 && HOOK_RE.test(line)) {
      offenders.push(body.name + ' 第 ' + (body.startLine + j) + ' 行：' + line.trim().slice(0, 60))
    }
  }
}
check('没有组件在顶格 return 之后调用 hook', offenders.length === 0, offenders.join(' | '))

console.log('\n[2] 动态：同一个组件两次渲染的 hook 数必须相等')

/**
 * 会计数的假 React。
 *
 * 跟默认假 React 的区别：hook 槽位跨渲染共享，并且记录每次渲染调用了几个。
 * 第二次渲染超出第一次的数量时抛错 —— 与真 React 的报错一致。
 */
function makeReact() {
  const slots = []
  const stats = { cursor: 0, prev: -1 }
  /** 每次渲染里注册的 effect，渲染完由测试手动跑一次（模拟 React 提交后的执行）。 */
  let effects = []
  /** 槽位存 { value }：用包装对象而不是裸值，避免「函数初值」被误当成惰性求值。 */
  const next = (compute) => {
    const i = stats.cursor++
    if (stats.prev >= 0 && i >= stats.prev) {
      throw new Error('Rendered more hooks than during the previous render (hook #' + (i + 1) + ')')
    }
    if (i === slots.length) slots.push({ value: compute() })
    return slots[i].value
  }
  const createElement = (type, props, ...children) => {
    const flat = children.flat(Infinity)
    return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } }
  }
  class Component { constructor(props) { this.props = props } render() { return null } }
  const React = {
    createElement,
    useState: (v) => {
      const slot = next(() => ({ v: typeof v === 'function' ? v() : v }))
      return [slot.v, (n) => { slot.v = typeof n === 'function' ? n(slot.v) : n }]
    },
    useEffect: (fn) => { next(() => null); effects.push(fn) },
    useCallback: (f) => next(() => f),
    useRef: (v) => next(() => ({ current: v })),
    useMemo: (f) => next(() => f()),
    useLayoutEffect: (fn) => { next(() => null); effects.push(fn) },
    useReducer: (r, init) => next(() => init),
    Component, Fragment: 'Fragment', memo: (c) => c, forwardRef: (c) => c,
    createContext: () => ({ Provider: 'Provider' }), useContext: () => ({}),
  }
  return {
    React, slots, stats,
    takeEffects() { const list = effects; effects = []; return list },
  }
}

/** 起一个隔离的模块实例，返回它注册的槽位表。 */
function boot(payloadFor) {
  const harness = makeReact()
  let factory = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (e) => { factory = e.factory } },
      addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1200,
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => payloadFor }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, removeEventListener: () => {},
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: CLIENT })
  if (!factory) throw new Error('client.js 没有注册 __ModuleLoader__.load')
  const registered = {}
  const ctx = {
    provide: () => {}, effect: () => {},
    slots: { inject: (_n, fn) => fn(), register: (o, c) => { registered[o.name] = { options: o, component: c }; return c } },
  }
  factory((name) => {
    if (name === 'react') return harness.React
    throw new Error('unexpected require: ' + name)
  }).apply(ctx)
  return { registered, harness }
}

const PAYLOAD = {
  ok: true,
  settings: { modelMode: 'auto', provider: 'p', model: 'm', style: 'detailed', customPrompt: '', preferences: [], freeChannelAsked: true },
  styles: [{ id: 'detailed', label: '详细', summary: 's', band: 'b', bandBadge: 'b', scope: 'x', forbid: 'y', tierPrompt: 't', prompt: 'p' }],
  models: [{ provider: 'p', model: 'm', name: 'n' }],
  freeChannel: { model: 'm', baseURL: '', usingBuiltinKey: false, status: 'ok', kind: '', message: '' },
  resolved: { provider: 'p', model: 'm', source: 'session' },
  lastUsed: null,
}

/**
 * 渲染两次：第一次用「什么都还没加载」的空响应，第二次用完整响应。
 *
 * 这正是真机上崩溃的那两次 —— 第一次是「正在读取…」，第二次设置到了。
 */
function renderTwice(entry, props) {
  const Boundary = entry.component
  let Inner
  try {
    Inner = new Boundary(props).render().type
  } catch (err) {
    return { ok: false, reason: '错误边界的构造函数就抛了：' + err.message }
  }
  const render = () => {
    if (Inner === null || typeof Inner !== 'function') return { children: [] }
    return Inner(props) || {}
  }
  try {
    render()
    return { ok: true, render }
  } catch (err) {
    return { ok: false, reason: '首帧就抛了：' + err.message + '\n' + String(err.stack).split('\n').slice(1,4).join('\n') }
  }
}

/**
 * 每个槽位单独起一个模块实例：hook 槽位是按组件实例分配的，
 * 几个组件共用一个 harness 会互相串号。
 */
const PROPS = {
  sessionId: 'session-0000',
  // 宿主的 standardProps 里 useInput 是个 selector 钩子，这里给个等价替身。
  useInput: (selector) => selector({ draft: '' }),
  inputActions: { setDraft: () => {}, submit: () => {} },
}

/** 渲染两帧：第一帧按组件自己的初始状态，第二帧原样再渲染一次。 */
async function hookCountsOf(name) {
  const { registered, harness } = boot(PAYLOAD)
  const entry = registered[name]
  if (!entry) return { error: '没有注册这个槽位' }
  let Inner
  try {
    Inner = new (entry.component)(PROPS).render().type
  } catch (err) {
    return { error: '错误边界的构造函数就抛了：' + err.message }
  }
  if (typeof Inner !== 'function') return { error: '槽位里没有可渲染的组件' }
  const render = () => {
    harness.stats.cursor = 0
    try {
      Inner(PROPS)
      return { ok: true, count: harness.stats.cursor }
    } catch (err) {
      return { ok: false, count: harness.stats.cursor, error: err.message }
    }
  }
  const first = render()
  if (!first.ok) return { error: '首帧就抛了：' + first.error }
  // 首帧提交后 React 会跑 effect：组件在这里发起请求，请求回来再 setState。
  // 这一步是关键 —— 状态真的变了，第二帧才会走到另一条渲染分支。
  for (const fn of harness.takeEffects()) {
    try { fn() } catch { /* effect 自己抛不算这个测试的事 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  harness.stats.prev = first.count
  const second = render()
  if (!second.ok) return { error: '第二帧抛了：' + second.error, first: first.count, second: second.count }
  return { first: first.count, second: second.count }
}

async function main() {
let names = []
try {
  names = Object.keys(boot(PAYLOAD).registered).sort()
} catch (err) {
  check('能启动模块', false, err.message)
}
check('至少注册了设置页', names.includes('settings.section'), '注册的有：' + names.join(', '))

for (const name of names) {
  const result = await hookCountsOf(name)
  if (result.error) { check(name + ' 两次渲染 hook 数一致', false, result.error); continue }
  check(name + ' 两次渲染 hook 数一致（' + result.first + ' / ' + result.second + '）',
    result.first === result.second, '第一帧 ' + result.first + ' 个，第二帧 ' + result.second + ' 个')
}

console.log('\n[3] 设置页要真的渲染出内容（不是只剩一行字）')

/** 把渲染树里的文字全摘出来。 */
function collectText(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return out }
  if (typeof node === 'object' && node.props) { collectText(node.props.children, out); return out }
  return out
}

async function renderSettings() {
  const { registered, harness } = boot(PAYLOAD)
  const entry = registered['settings.section']
  if (!entry) return { error: '没有注册 settings.section' }
  const Inner = new (entry.component)(PROPS).render().type
  harness.stats.cursor = 0
  const first = Inner(PROPS)
  const firstText = []
  collectText(first, firstText)
  // 首帧应该是「正在读取…」，不是报错
  const firstRender = firstText.join(' ')
  for (const fn of harness.takeEffects()) {
    try { fn() } catch { /* 探测请求失败不算 */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  harness.stats.prev = harness.stats.cursor
  harness.stats.cursor = 0
  const second = Inner(PROPS)
  const text = []
  collectText(second, text)
  return { firstRender, text: text.join(' ') }
}

const rendered = await renderSettings()
if (rendered.error) {
  check('设置页能渲染', false, rendered.error)
} else {
  check('首帧是「正在读取…」而不是报错', /正在读取/u.test(rendered.firstRender) && !/出错/u.test(rendered.firstRender), rendered.firstRender.slice(0, 80))
  check('读完设置后不再停在「正在读取…」', !/正在读取/u.test(rendered.text), rendered.text.slice(0, 120))
  for (const expect of ['优化用的模型', '改写力度', '我的偏好']) {
    check('渲染出「' + expect + '」这一段', rendered.text.includes(expect), '页面上找不到，实际文字：' + rendered.text.slice(0, 160))
  }
  check('渲染出当前档位的提示词预览', /系统提示词|你会收到/u.test(rendered.text)
    || rendered.text.length > 400, '页面基本是空的')
}

console.log('')
if (failures > 0) {
  console.error('HOOKS ORDER TEST FAILED（' + failures + ' 项）')
  process.exitCode = 1
} else {
  console.log('HOOKS ORDER TEST PASSED')
}
}

void main()

