/**
 * test-multi-entry.cjs —— 多入口回归测试（C17）
 *
 * 覆盖新增的三条入口：
 *   1. 会话头按钮（conversation.session.header.actions）
 *   2. 全局快捷键 Alt+O
 *   3. 斜杠命令的客户端「裸调用」装饰 —— 本环境没装 commandUi，跳过，
 *      改由 smoke-host.cjs 验宿主侧的 /optimize 命令本身。
 *
 * 复用 test-restore-state.cjs 的最小 React 桩 + 微型渲染器；
 * 区别是沙箱里多了一个 document（installShortcut 要往上挂 keydown）。
 */
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const CLIENT = process.env.DSHO_CLIENT || path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

// ── 最小 React 桩 ──────────────────────────────────────────────────────────
let hookStates = []
let hookIndex = 0
let effects = []
let scheduleRender = () => {}

function makeReact() {
  function useState(initial) {
    const arr = hookStates
    const i = hookIndex++
    if (!(i in arr)) arr[i] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const value = typeof next === 'function' ? next(arr[i]) : next
      if (Object.is(value, arr[i])) return
      arr[i] = value
      scheduleRender()
    }
    return [arr[i], setter]
  }
  function useEffect(fn, deps) {
    const arr = hookStates
    const i = hookIndex++
    const prev = arr[i]
    const changed = prev === undefined || !prev.deps || deps === undefined
      || deps.length !== prev.deps.length
      || deps.some((d, k) => !Object.is(d, prev.deps[k]))
    if (changed) { arr[i] = { deps }; effects.push(() => fn()) }
  }
  function useCallback(fn) { return fn }
  function useRef(initial) {
    const arr = hookStates
    const i = hookIndex++
    if (!(i in arr)) arr[i] = { current: initial }
    return arr[i]
  }
  class Component {
    constructor(props) { this.props = props; this.state = {} }
  }
  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
    return { type, props: { ...(props || {}), children: flat.length === 1 ? flat[0] : flat } }
  }
  return { createElement, useState, useEffect, useCallback, useRef, Component }
}

const React = makeReact()

// ── document 桩（只要 addEventListener / removeEventListener） ─────────────
const docListeners = []
const documentStub = {
  addEventListener(type, fn) { docListeners.push({ type, fn }) },
  removeEventListener(type, fn) {
    const index = docListeners.findIndex((l) => l.type === type && l.fn === fn)
    if (index >= 0) docListeners.splice(index, 1)
  },
}

// ── 加载 client.js ─────────────────────────────────────────────────────────
let factory = null
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { factory = entry.factory } }, addEventListener() {} },
  document: documentStub,
  console,
  fetch: (...args) => fetchImpl(...args),
  setTimeout, clearTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: {
    _data: new Map(),
    getItem(key) { return this._data.has(key) ? this._data.get(key) : null },
    setItem(key, value) { this._data.set(key, String(value)) },
    removeItem(key) { this._data.delete(key) },
    clear() { this._data.clear() },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: CLIENT })
if (!factory) throw new Error('client.js 没有注册 __ModuleLoader__.load')

const registered = {}
const disposers = []
const decorations = []
const ctx = {
  // commandUi 是可选服务：真实宿主里有（dsh-client-ui-commands 已挂），
  // 测试里给个桩，验证「裸调用 /optimize」这条装饰挂上了。
  inject(list, callback) {
    const names = Array.isArray(list) ? list : Object.keys(list)
    const scope = {
      effect(fn) {
        const result = fn()
        if (typeof result === 'function') disposers.push(result)
        return result
      },
      commandUi: {
        decorate(decoration) {
          decorations.push(decoration)
          return () => {}
        },
      },
    }
    if (!names.includes('commandUi')) throw new Error('unexpected inject: ' + names.join(','))
    return callback(scope)
  },
  // effect 在真实宿主里会立即执行并收集 disposer；这里照做，才能验快捷键装上了。
  effect(fn) {
    const result = fn()
    if (typeof result === 'function') disposers.push(result)
    return result
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      registered[options.name] = { options, component }
      return component
    },
  },
}
factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}).apply(ctx)

// ── 断言注册结果 ───────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

const header = registered['conversation.session.header.actions']
const Button = registered['conversation.input.right'] && registered['conversation.input.right'].component
const Card = registered['conversation.input.dock'] && registered['conversation.input.dock'].component
const Header = header && header.component

// ── 微型渲染器（同 test-restore-state.cjs） ────────────────────────────────
function walk(el, visit) {
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (Array.isArray(el)) { el.forEach((c) => walk(c, visit)); return }
  if (typeof el !== 'object') return
  visit(el)
  const kids = el.props && el.props.children
  if (kids !== undefined) walk(kids, visit)
}
function textOf(el) {
  let out = ''
  walk(el, (node) => { if (typeof node.props?.children === 'string') out += node.props.children })
  return out
}
function findButton(el) {
  let found = null
  walk(el, (node) => { if (!found && node.type === 'button') found = node })
  return found
}
function findButtonByText(el, text) {
  let found = null
  walk(el, (node) => {
    if (found) return
    if (node.type !== 'button') return
    if (textOf(node) === text) found = node
  })
  return found
}

let draft = ''
let current = null
let currentCard = null
let currentHeader = null

function props() {
  return {
    sessionId: 'session-test',
    useInput: (selector) => selector({ draft }),
    inputActions: { setDraft: (text) => { draft = text; render() } },
  }
}

function isClassComponent(type) {
  return typeof type === 'function' && type.prototype && type.prototype.render
}
function renderElement(el) {
  if (el === null || el === undefined || typeof el === 'boolean') return null
  if (Array.isArray(el)) return el.map(renderElement)
  if (typeof el !== 'object') return el
  const type = el.type
  if (typeof type === 'function') {
    if (isClassComponent(type)) {
      const instance = new type(el.props)
      instance.state = instance.state || {}
      return renderElement(instance.render())
    }
    return renderElement(type(el.props))
  }
  return el
}

const slotStates = new Map()
let renderCounter = 0
function renderSlotComponent(Component, slotKey) {
  let slot = slotStates.get(slotKey)
  if (slot === undefined) { slot = { states: [], index: 0 }; slotStates.set(slotKey, slot) }
  const savedHookStates = hookStates
  const savedHookIndex = hookIndex
  const savedEffects = effects
  hookStates = slot.states
  hookIndex = 0
  effects = []
  let out
  if (isClassComponent(Component)) out = renderElement(new Component(props()).render())
  else out = renderElement(Component(props()))
  const queued = effects
  effects = []
  for (const fn of queued) { hookStates = slot.states; fn() }
  hookStates = savedHookStates
  hookIndex = savedHookIndex
  effects = savedEffects
  return out
}

function render() {
  const my = ++renderCounter
  const buttonTree = renderSlotComponent(Button, 'conversation.input.right')
  const cardTree = renderSlotComponent(Card, 'conversation.input.dock')
  const headerTree = renderSlotComponent(Header, 'conversation.session.header.actions')
  if (renderCounter !== my) return current
  current = buttonTree
  currentCard = cardTree
  currentHeader = headerTree
  return current
}

function mount(initialDraft) {
  slotStates.clear()
  draft = initialDraft
  render()
}
scheduleRender = () => { render() }

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
function cardButton(text) { return findButtonByText(currentCard, text) }
function cardVisible() {
  return currentCard !== null && typeof currentCard === 'object' && currentCard.type !== undefined
}
function headerButton() { return findButton(currentHeader) }

// ── fetch 桩：只关心 /stream 与 /abort ─────────────────────────────────────
const NL = String.fromCharCode(10)
function sseFrame(name, payload) {
  return 'event: ' + name + NL + 'data: ' + JSON.stringify(payload) + NL + NL
}
function sseResponse(frames) {
  let index = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined }
            const value = frames[index]
            index += 1
            return { done: false, value }
          },
        }
      },
    },
  }
}
let optimizeText = '【优化后】请在工作区执行任务并汇总结果'
let streamCalls = 0
let abortCalls = 0
fetchImpl = async (url) => {
  const target = String(url)
  if (target.includes('/abort')) {
    abortCalls++
    return { ok: true, status: 200, json: async () => ({ ok: true, aborted: true }) }
  }
  if (target.includes('/stream')) {
    streamCalls++
    return sseResponse([
      sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
      sseFrame('delta', { text: optimizeText }),
      sseFrame('done', { ok: true, text: optimizeText, provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
    ])
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

// ── 快捷键派发 ─────────────────────────────────────────────────────────────
function pressAltO(overrides) {
  let prevented = false
  const event = {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: 'KeyO',
    key: 'o',
    defaultPrevented: false,
    isComposing: false,
    preventDefault() { prevented = true },
    ...(overrides || {}),
  }
  for (const listener of docListeners.slice()) {
    if (listener.type === 'keydown') listener.fn(event)
  }
  return prevented
}

async function main() {
  console.log('\n[1] 会话头按钮已注册到 conversation.session.header.actions')
  check('槽位已注册', header !== undefined, String(header))
  check('id = dsh-prompt-optimizer', header?.options.id === 'dsh-prompt-optimizer', header?.options.id)
  check('order = 5（排在任务列表/子代理之前）', header?.options.order === 5, String(header?.options.order))
  check('label() = 优化', header?.options.label() === '优化', String(header?.options.label()))

  console.log('\n[2] Alt+O 监听已装上（document keydown 一条）')
  check('装了 1 条 keydown 监听', docListeners.filter((l) => l.type === 'keydown').length === 1,
    String(docListeners.length))
  check('effect 收集到 disposer', disposers.length >= 1, String(disposers.length))

  console.log('\n[3] 空草稿：会话头按钮禁用，Alt+O 不吞键')
  mount('')
  let hb = headerButton()
  check('按钮存在', hb !== undefined, String(hb))
  check('空草稿时 disabled=true', hb.props.disabled === true, String(hb.props.disabled))
  check('data-state=idle', hb.props['data-state'] === 'idle', hb.props['data-state'])
  streamCalls = 0
  check('Alt+O 没有 preventDefault（这个键此刻无事可做）', pressAltO() === false, 'prevented')
  await tick()
  check('没有发请求', streamCalls === 0, String(streamCalls))

  console.log('\n[4] 有草稿：会话头按钮可点，点了就走优化')
  mount('帮我把项目跑一下')
  hb = headerButton()
  check('disabled=false', hb.props.disabled === false, String(hb.props.disabled))
  streamCalls = 0
  hb.props.onClick()
  await tick()
  check('发了 1 次流式请求', streamCalls === 1, String(streamCalls))
  check('草稿没被覆盖', draft === '帮我把项目跑一下', draft)
  check('预览卡出现', cardVisible() === true, String(cardVisible()))

  console.log('\n[5] 有结果待采用：会话头按钮切 ready 并带小圆点')
  hb = headerButton()
  check('data-state=ready', hb.props['data-state'] === 'ready', hb.props['data-state'])
  let dot = null
  walk(currentHeader, (node) => { if (node.props?.className === 'dsho-head-dot') dot = node })
  check('小圆点存在', dot !== null, String(dot))
  check('title 提示替换', /替换输入框/.test(hb.props.title), hb.props.title)

  console.log('\n[6] 再点会话头按钮 = 采用结果')
  hb.props.onClick()
  await tick()
  check('草稿被替换成优化结果', draft === optimizeText, draft)
  check('预览卡收起', cardVisible() === false, String(cardVisible()))

  console.log('\n[7] Alt+O：有草稿时触发优化')
  mount('帮我把项目跑一下')
  streamCalls = 0
  check('Alt+O 吞掉了这个键', pressAltO() === true, 'not prevented')
  await tick()
  check('发了 1 次流式请求', streamCalls === 1, String(streamCalls))
  check('结果进了预览卡', cardVisible() === true, String(cardVisible()))
  check('草稿没被覆盖', draft === '帮我把项目跑一下', draft)

  console.log('\n[8] Alt+O：有结果待采用时 = 采用，而不是再跑一遍')
  streamCalls = 0
  pressAltO()
  await tick()
  check('没有再发请求', streamCalls === 0, String(streamCalls))
  check('草稿被替换', draft === optimizeText, draft)

  console.log('\n[9] Alt+O 的边界：输入法组合中 / 带 Ctrl / 带 Shift 都不认')
  mount('帮我把项目跑一下')
  streamCalls = 0
  check('isComposing 时不处理', pressAltO({ isComposing: true }) === false, 'prevented')
  check('Ctrl+Alt+O 不处理', pressAltO({ ctrlKey: true }) === false, 'prevented')
  check('Shift+Alt+O 不处理', pressAltO({ shiftKey: true }) === false, 'prevented')
  check('Meta+Alt+O 不处理', pressAltO({ metaKey: true }) === false, 'prevented')
  check('别的键不处理', pressAltO({ code: 'KeyP', key: 'p' }) === false, 'prevented')
  check('已被别人 preventDefault 的不处理', pressAltO({ defaultPrevented: true }) === false, 'prevented')
  await tick()
  check('以上都没有发请求', streamCalls === 0, String(streamCalls))

  console.log('\n[10] 运行中按 Alt+O 不会重复发起')
  streamCalls = 0
  mount('跑一下测试')
  const hb2 = headerButton()
  hb2.props.onClick()      // 开始
  pressAltO()              // 运行中再按
  await tick(40)
  check('只发了 1 次请求', streamCalls === 1, String(streamCalls))

  console.log('\n[11] /optimize 的客户端装饰已挂上（裸调用跑在当前草稿上）')
  check('挂了 1 条装饰', decorations.length === 1, String(decorations.length))
  const decoration = decorations[0]
  check('装饰名是 optimize', decoration?.name === 'optimize', String(decoration?.name))
  check('kind=action', decoration?.ui?.kind === 'action', String(decoration?.ui?.kind))
  check('available 恒真', decoration?.available({}) === true, String(decoration?.available({})))
  // 上一个用例留下了一份 ready 的预览（source 是别的文本），先放弃掉，
  // 否则 triggerOptimize 会走「采用」分支并因为冲突而什么都不做。
  mount('帮我把项目跑一下')
  if (cardVisible()) {
    const discard = cardButton('放弃')
    if (discard) discard.props.onClick()
    await tick()
  }
  check('旧预览已清掉', cardVisible() === false, String(cardVisible()))
  streamCalls = 0
  decoration.ui.run({ sessionId: 'session-test' })
  await tick()
  check('裸调用 /optimize 触发了优化', streamCalls === 1, String(streamCalls))
  check('结果进预览卡', cardVisible() === true, String(cardVisible()))
  check('草稿没被覆盖', draft === '帮我把项目跑一下', draft)
  // 有结果时再裸调用 = 采用（与快捷键一致）。
  streamCalls = 0
  decoration.ui.run({ sessionId: 'session-test' })
  await tick()
  check('有结果时裸调用 = 采用', draft === optimizeText, draft)
  check('没有再发请求', streamCalls === 0, String(streamCalls))

  console.log('\n[12] 插件卸载时快捷键被摘掉')
  for (const dispose of disposers) dispose()
  check('keydown 监听已移除', docListeners.filter((l) => l.type === 'keydown').length === 0,
    String(docListeners.length))

  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
