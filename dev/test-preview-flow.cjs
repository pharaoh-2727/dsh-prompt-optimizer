/**
 * dsh-prompt-optimizer —— A 组行为测试
 *
 *   A1 预览确认：优化结果不直接盖住草稿，先落到输入框上方的预览卡，
 *                用户点「替换草稿」才写回。
 *   A2 编辑竞态保护：等待期间用户又改了输入 → 结果标记为冲突，
 *                「替换草稿」禁用，结果不覆盖用户新写的内容。
 *   A3 取消：按钮在优化进行中变「取消」，点一下走 abort 路由，
 *                取消不报错（不弹红色错误）。
 *
 * 本机没有可用的 react 包（asar 内也没有，浏览器端由宿主基座提供），
 * 所以这里用一个最小的 React 桩 + 微型渲染器，直接把 client.js 里的
 * OptimizeButton 和 PreviewCard 跑起来。
 *
 * 注意：hook 状态跨渲染持久（与 React 一致），每个用例开头用 mount()
 * 重置成一次全新挂载，避免用例之间互相污染。
 */
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const CLIENT = process.env.DSHO_CLIENT
  || path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

// ── 最小 React 桩 ──────────────────────────────────────────────────────────
let hookStates = []
let hookIndex = 0
let effects = []
let scheduleRender = () => {}
// 每次 setState 都会 +1，用来发现「渲染过程中状态又变了」。
let stateVersion = 0

function makeReact() {
  // 每个 hook 都记住自己所在的 state 数组 —— 两个槽位各有一份，
  // setter 必须写回自己那份，不能跟着全局变量跑偏。
  function useState(initial) {
    const arr = hookStates
    const i = hookIndex++
    if (!(i in arr)) arr[i] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      const value = typeof next === 'function' ? next(arr[i]) : next
      if (Object.is(value, arr[i])) return
      arr[i] = value
      stateVersion++
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
    if (changed) {
      arr[i] = { deps }
      effects.push(() => fn())
    }
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

// ── 加载 client.js ─────────────────────────────────────────────────────────
let factory = null
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
// window 上的全局监听（结果区缩放手柄的拖动过程）
const windowListeners = []
// DOM 节点引用：测试里手动把 ref 指到带 getBoundingClientRect 的假节点上。
const domNodes = new Map()
// 假节点的矩形（高度/宽度/位置都可单独设定）。
const domRects = new Map()
const sandbox = {
  window: {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    // 结果区缩放手柄要监听 window 上的 pointermove/pointerup。
    addEventListener: (type, fn) => { windowListeners.push({ type, fn }) },
    removeEventListener: (type, fn) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.fn === fn)
      if (index >= 0) windowListeners.splice(index, 1)
    },
    // 往外扩宽时要看视口还剩多少空间。
    innerWidth: 1200,
  },
  console,
  fetch: (...args) => fetchImpl(...args),
  setTimeout, clearTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
  // 记住结果区高度要用 localStorage；这里给一个最小的内存实现。
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
// 插件挂到 context 上的内部状态（previewStore），用来在用例之间复位。
const provided = {}
const ctx = {
  provide: (name, value) => { provided[name] = value },
  effect: () => {},
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

const Button = registered['conversation.input.right'].component
if (!Button) throw new Error('没有注册 conversation.input.right 组件')
const Card = registered['conversation.input.dock'] && registered['conversation.input.dock'].component
if (!Card) throw new Error('没有注册 conversation.input.dock 组件（预览卡）')

// ── 微型渲染器 ────────────────────────────────────────────────────────────
function walk(el, visit) {
  if (el === null || el === undefined || typeof el === 'boolean') return
  if (Array.isArray(el)) { el.forEach((c) => walk(c, visit)); return }
  if (typeof el !== 'object') return
  visit(el)
  const kids = el.props && el.props.children
  if (kids !== undefined) walk(kids, visit)
}

function findButton(el) {
  let found = null
  walk(el, (node) => { if (!found && node.type === 'button') found = node })
  return found
}

function findButtons(el) {
  const all = []
  walk(el, (node) => { if (node.type === 'button') all.push(node) })
  return all
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

function textOf(el) {
  let out = ''
  walk(el, (node) => { if (typeof node.props?.children === 'string') out += node.props.children })
  return out
}

let draft = ''
let current = null
let currentCard = null

function props() {
  return {
    sessionId: 'session-test',
    useInput: (selector) => selector({ draft }),
    inputActions: {
      setDraft: (text) => { draft = text; render() },
    },
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
  // DOM 元素：造一个假的节点，把 ref 指上去。
  // 结果区的缩放手柄要靠 ref.current.getBoundingClientRect() 量高度，
  // 所以这里必须真的把子节点也渲染一遍，ref 才会被填上。
  if (typeof type === 'string') {
    const children = el.props && el.props.children
    if (children !== undefined) {
      el.props.children = Array.isArray(children)
        ? children.map(renderElement)
        : renderElement(children)
    }
    if (el.props && el.props.ref) {
      const className = el.props.className || type
      const rect = domRects.get(className) || { height: 220, width: 800, top: 0, left: 0 }
      const node = {
        tagName: type,
        className,
        getBoundingClientRect: () => {
          const custom = domRects.get(className)
          const height = custom ? custom.height : (domNodes.get(className) || 220)
          const width = custom ? custom.width : 800
          const top = custom ? custom.top : 0
          const left = custom ? custom.left : 0
          return { height, width, top, left, bottom: top + height, right: left + width }
        },
      }
      el.props.ref.current = node
    }
  }
  return el
}

/**
 * 渲染一个组件，单独给它一套 hook 槽位。
 *
 * 两个槽位的组件是彼此独立的实例，hook 状态不能混在一起 ——
 * 共享的话 Button 的第 0 个 useState 会被 Card 的第 0 个覆盖。
 *
 * 但状态必须**跨渲染持久**（与 React 一致）：每次渲染只是把 hookIndex
 * 归零重新按顺序取用同一批 state/ref，不是重新分配一批。
 */
const slotStates = new Map()
let renderCounter = 0

function renderSlotComponent(Component, slotKey) {
  let slot = slotStates.get(slotKey)
  if (slot === undefined) {
    slot = { states: [], index: 0 }
    slotStates.set(slotKey, slot)
  }
  const savedHookStates = hookStates
  const savedHookIndex = hookIndex
  const savedEffects = effects

  hookStates = slot.states
  hookIndex = 0
  effects = []
  let out
  if (isClassComponent(Component)) {
    out = renderElement(new Component(props()).render())
  } else {
    out = renderElement(Component(props()))
  }
  const queued = effects
  effects = []
  // 宿主里 effects 在 commit 后执行；这里同步跑。
  // 跑 effect 期间 hookStates 必须还是这个槽位的，否则 setState 会写错地方。
  for (const fn of queued) {
    hookStates = slot.states
    fn()
  }

  hookStates = savedHookStates
  hookIndex = savedHookIndex
  effects = savedEffects
  return out
}

function render() {
  const my = ++renderCounter
  const buttonTree = renderSlotComponent(Button, 'conversation.input.right')
  // 预览卡是另一个槽位的独立组件：单独挂一次。
  const cardTree = renderSlotComponent(Card, 'conversation.input.dock')
  // effect 里可能又触发了渲染（setState → scheduleRender）。那时以最新那次为准，
  // 别用这次算出来的旧树把它盖掉。
  if (renderCounter !== my) return current
  current = buttonTree
  currentCard = cardTree
  return current
}

/**
 * 全新挂载：清空 hook 状态，模拟用户重新打开页面。
 *
 * 顺带把模块级的「正在生成」复位：上一个用例若是从流中途切走的，
 * 不清掉的话新挂载的按钮一上来就写着「取消」。
 */
function mount(initialDraft) {
  slotStates.clear()
  draft = initialDraft
  render()
}

scheduleRender = () => { render() }

// ── 断言 ──────────────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

/**
 * 清掉 window 上残留的全局监听。
 *
 * 每次拖动前先清一次：否则会抓到上一段手势留下的监听，测的就不是当前这次。
 */
function clearWindowListeners() {
  windowListeners.length = 0
}

/** 取最近注册的那个 pointermove 监听。 */
function lastMoveListener() {
  const all = windowListeners.filter((l) => l.type === 'pointermove')
  return all.length === 0 ? undefined : all[all.length - 1]
}

/** 结束当前手势（触发 pointerup，插件会顺手摘掉监听）。 */
function endGesture() {
  const all = windowListeners.filter((l) => l.type === 'pointerup')
  if (all.length === 0) return
  all[all.length - 1].fn()
}

function state() {
  const btn = findButton(current)
  return {
    label: textOf(btn),
    disabled: !!btn.props.disabled,
    mode: btn.props['data-mode'],
    title: btn.props.title,
    aria: btn.props['aria-label'],
  }
}

function click() { findButton(current).props.onClick() }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

// 可控的 optimize / abort 响应
let optimizeText = '【优化后】请在 DSH 工作区执行任务并汇总结果'
let optimizeDelay = 0
let optimizeCalls = 0
let optimizeFails = false
let optimizeAborts = false
let abortCalls = 0
let clipboardText = ''
let streamCalls = 0
// 模拟老版宿主：/stream 不存在（404），客户端必须改走 /optimize。
let streamMissing = false
// done 帧里「这一版经历了什么」的三个字段，测试按需改。
let doneAdjusted = null
let doneRecovered = false
let doneSource = 'session'
// 流里要不要插一帧 revise（服务端说「要整段换稿了」）。
let streamRevise = ''
// 帧与帧之间隔多少毫秒：用来观察「换稿中」这种中间态。
let streamFrameDelay = 0
// 每帧的延迟也可以单独给：用来让某一类事件停得更久，好观察中间态。
let streamFrameDelays = null

// ── SSE 响应桩 ──────────────────────────────────────────────────────────
// 服务端推的是 SSE：一串「event: 名字\ndata: {...}\n\n」的帧。
// 这里按真实格式造帧，再切成若干 chunk 喂给 reader。
const NL = String.fromCharCode(10)

function sseFrame(name, payload) {
  return 'event: ' + name + NL + 'data: ' + JSON.stringify(payload) + NL + NL
}

function sseResponse(frames, frameDelay, perFrame) {
  let index = 0
  const waitFor = (i) => {
    const custom = Array.isArray(perFrame) ? perFrame[i] : undefined
    const ms = typeof custom === 'number' ? custom : frameDelay
    return typeof ms === 'number' && ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null
  }
  return {
    ok: true,
    status: 200,
    // 真实响应一定带 content-type：客户端靠它判断「这是不是一条 SSE」。
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined }
            const value = frames[index]
            const gate = waitFor(index)
            index += 1
            if (gate !== null) await gate
            return { done: false, value }
          },
        }
      },
    },
  }
}

function useDefaultFetch() {
  fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/abort')) {
      abortCalls++
      return { ok: true, status: 200, json: async () => ({ ok: true, aborted: true }) }
    }
    if (target.includes('/stream')) {
      streamCalls++
      optimizeCalls++
      // 模拟「宿主没有 /stream 这条路由」：旧插件不回退，用户只会看到空内容。
      if (streamMissing) {
        return {
          ok: false,
          status: 404,
          body: null,
          headers: { get: () => 'text/html' },
          json: async () => ({ ok: false, error: 'not found' }),
        }
      }
      if (optimizeDelay) await new Promise((r) => setTimeout(r, optimizeDelay))
      if (optimizeAborts) {
        return sseResponse([sseFrame('aborted', { error: '已取消' })])
      }
      if (optimizeFails) {
        return sseResponse([sseFrame('error', { error: '模型炸了' })])
      }
      const frames = [
        sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
        sseFrame('reasoning', { text: '先确认任务范围' }),
        sseFrame('delta', { text: optimizeText.slice(0, 8) }),
        ...(streamRevise ? [sseFrame('revise', { reason: 'trimmed', text: streamRevise })] : []),
        sseFrame('delta', { text: optimizeText }),
        sseFrame('done', {
          ok: true,
          text: optimizeText,
          provider: 'workbuddy',
          model: 'space-bunny',
          style: 'balanced',
          source: doneSource,
          adjusted: doneAdjusted,
          recovered: doneRecovered,
          reasoning: '先确认任务范围',
          usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
          elapsedMs: 1234,
        }),
      ]
      return sseResponse(frames, streamFrameDelay, streamFrameDelays)
    }
    if (target.includes('/optimize')) {
      optimizeCalls++
      if (optimizeDelay) await new Promise((r) => setTimeout(r, optimizeDelay))
      if (optimizeAborts) {
        return { ok: false, status: 499, json: async () => ({ ok: false, aborted: true, error: '已取消' }) }
      }
      if (optimizeFails) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: '模型炸了' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, text: optimizeText }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
}
useDefaultFetch()

/** 预览卡上有没有某个按钮 */
function cardButton(text) {
  return findButtonByText(currentCard, text)
}

function cardText() {
  return textOf(currentCard)
}

/** 卡片标题行（模型 · 档位 · 状态）的文字：断言状态文案时看它最干净。 */
function cardMeta() {
  const node = cardNode('dsho-dock-meta')
  return node === null ? '' : textOf(node)
}

function cardVisible() {
  return currentCard !== null && typeof currentCard === 'object' && currentCard.type !== undefined
}

/** 按 className 找节点（预览卡里的结构件） */
function cardNode(className) {
  let found = null
  walk(currentCard, (node) => {
    if (!found && node.props && node.props.className === className) found = node
  })
  return found
}

/** 找左右边缘手柄 */
function cardEdge(side) {
  let found = null
  walk(currentCard, (node) => {
    if (!found && node.props && node.props.className === 'dsho-dock-edge'
      && node.props['data-side'] === side) found = node
  })
  return found
}

/**
 * 某个 className 的节点是不是**预览卡本体**（dsho-dock）的直接子节点。
 * 用于断言「三个手柄都长在卡片外沿，而不是塞在结果框里面」。
 */
function dockHasChild(className) {
  const dock = cardNode('dsho-dock')
  if (!dock) return false
  const kids = dock.props && dock.props.children
  if (kids === undefined) return false
  let hit = false
  walk(kids, (node) => {
    if (!hit && node.props && node.props.className === className) hit = true
  })
  return hit
}

/** 读当前预览卡（外层）的宽度样式 */
function dockWidth() {
  const dock = cardNode('dsho-dock')
  return dock && dock.props.style ? dock.props.style : undefined
}

/**
 * 某个 className 的节点是不是在结果区边框（dsho-dock-frame）**里面**。
 * 用于断言「高度手柄搬到了框上方」——它应该是框的兄弟节点，而不是框的子节点。
 */
function insideFrame(className) {
  let inFrame = false
  let result = false
  function scan(el) {
    if (el === null || el === undefined || typeof el === 'boolean') return
    if (Array.isArray(el)) { el.forEach(scan); return }
    if (typeof el !== 'object') return
    const isFrame = !!(el.props && el.props.className === 'dsho-dock-frame')
    const hit = !!(el.props && el.props.className === className)
    if (hit) { result = inFrame; return }
    const kids = el.props && el.props.children
    if (kids !== undefined) {
      const prev = inFrame
      if (isFrame) inFrame = true
      scan(kids)
      inFrame = prev
    }
  }
  scan(currentCard)
  return result
}

/** 某个 className 的节点在树里的出现顺序（用于断言「手柄排在框前面 = 显示在上方」） */
function nodeOrder(className) {
  let order = 0
  let found = -1
  function scan(el) {
    if (el === null || el === undefined || typeof el === 'boolean') return
    if (Array.isArray(el)) { el.forEach(scan); return }
    if (typeof el !== 'object') return
    if (el.props && el.props.className === className && found < 0) found = order
    order += 1
    const kids = el.props && el.props.children
    if (kids !== undefined) scan(kids)
  }
  scan(currentCard)
  return found
}

/** 读记住的左右扩出量 */
function storedInsets() {
  const raw = sandbox.localStorage.getItem('dsho.preview.body-width')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

async function main() {
  console.log('\n[1] 初始态：空输入')
  mount('')
  let s = state()
  check('按钮文案为「优化」', s.label === '优化', s.label)
  check('空输入时 disabled=true', s.disabled === true, String(s.disabled))
  check('data-mode=optimize', s.mode === 'optimize', s.mode)
  check('title 提示先写内容', /先在输入框里写下/.test(s.title), s.title)
  check('aria-label=优化提示词', s.aria === '优化提示词', s.aria)
  check('预览卡不显示', cardVisible() === false, String(cardVisible()))

  console.log('\n[2] 有内容但未优化')
  mount('帮我把项目跑一下')
  s = state()
  check('按钮文案仍为「优化」', s.label === '优化', s.label)
  check('disabled=false', s.disabled === false, String(s.disabled))

  console.log('\n[3] A1：点优化 → 结果进预览卡，草稿不被覆盖')
  optimizeCalls = 0
  click()
  await tick()
  s = state()
  check('只发了 1 次请求', optimizeCalls === 1, String(optimizeCalls))
  check('草稿没有被结果覆盖', draft === '帮我把项目跑一下', draft)
  check('按钮仍在「优化」态（结果还没采用）', s.label === '优化', s.label)
  check('预览卡出现了', cardVisible() === true, String(cardVisible()))
  check('预览卡里有「替换草稿」', cardButton('替换草稿') !== null)
  check('预览卡里有「复制」', cardButton('复制') !== null)
  check('预览卡里有「重新优化」', cardButton('重新优化') !== null)
  check('预览卡里有「放弃」', cardButton('放弃') !== null)
  check('预览卡显示优化结果正文', cardText().includes('请在 DSH 工作区执行任务'), cardText())

  console.log('\n[4] A1：点「替换草稿」→ 才写回草稿，按钮变「退回」')
  cardButton('替换草稿').props.onClick()
  await tick()
  s = state()
  check('草稿被替换为优化结果', draft === optimizeText, draft)
  check('按钮文案为「退回」', s.label === '退回', s.label)
  check('data-mode=restore', s.mode === 'restore', s.mode)
  check('disabled=false（退回可点）', s.disabled === false, String(s.disabled))
  check('title 改为撤销说明', /撤销这次优化/.test(s.title), s.title)
  check('aria-label=退回优化，恢复原文', s.aria === '退回优化，恢复原文', s.aria)
  check('预览卡收起', cardVisible() === false, String(cardVisible()))

  console.log('\n[5] 点「退回」→ 恢复优化前原文')
  click()
  s = state()
  check('按钮文案回到「优化」', s.label === '优化', s.label)
  check('data-mode=optimize', s.mode === 'optimize', s.mode)
  check('草稿恢复成原文', draft === '帮我把项目跑一下', draft)
  check('恢复后 disabled=false（有内容）', s.disabled === false, String(s.disabled))

  console.log('\n[6] A2：等待期间用户改了输入 → 结果标记冲突，「替换草稿」禁用')
  optimizeDelay = 60
  optimizeCalls = 0
  mount('帮我把项目跑一下')
  click()
  await tick(10)
  check('优化进行中', optimizeCalls === 1, String(optimizeCalls))
  draft = '帮我把项目跑一下，另外看看日志'   // 用户在等待期间改输入
  render()
  await tick(120)
  const adopt = cardButton('替换草稿')
  check('预览卡仍在', cardVisible() === true, String(cardVisible()))
  check('「替换草稿」被禁用', adopt !== null && adopt.props.disabled === true,
    adopt ? String(adopt.props.disabled) : 'no button')
  check('卡上给出冲突说明', /改过输入框/.test(cardText()), cardText())
  check('用户输入未被覆盖', draft === '帮我把项目跑一下，另外看看日志', draft)
  optimizeDelay = 0

  console.log('\n[7] A2：冲突时点「复制」仍可用，结果能进剪贴板')
  clipboardText = ''
  sandbox.navigator.clipboard.writeText = async (text) => { clipboardText = text }
  const copyBtn = cardButton('复制')
  check('「复制」可点', copyBtn !== null && copyBtn.props.disabled !== true)
  copyBtn.props.onClick()
  await tick()
  check('结果进了剪贴板', clipboardText === optimizeText, clipboardText)

  console.log('\n[8] A2：冲突时点「放弃」→ 关掉卡片，草稿保持用户的内容')
  const discardBtn = cardButton('放弃')
  discardBtn.props.onClick()
  await tick()
  check('预览卡收起', cardVisible() === false, String(cardVisible()))
  check('草稿仍是用户写的', draft === '帮我把项目跑一下，另外看看日志', draft)

  console.log('\n[9] A3：优化进行中按钮变「取消」，点一下走 abort 路由')
  optimizeAborts = true
  abortCalls = 0
  optimizeDelay = 80
  mount('要取消的活儿')
  click()
  await tick(10)
  s = state()
  check('按钮文案为「取消」', s.label === '取消', s.label)
  check('data-mode=cancel', s.mode === 'cancel', s.mode)
  check('取消态按钮可点', s.disabled === false, String(s.disabled))
  check('aria-label=取消优化', s.aria === '取消优化', s.aria)
  click()   // 点「取消」
  await tick(200)
  check('发了 1 次 abort 请求', abortCalls === 1, String(abortCalls))
  s = state()
  check('取消后按钮回到「优化」', s.label === '优化', s.label)
  check('取消后草稿没被改', draft === '要取消的活儿', draft)
  let errText = ''
  walk(current, (node) => { if (node.props?.className === 'dsho-err') errText = textOf(node) })
  check('取消不弹错误提示', errText === '', errText)
  check('取消后预览卡不显示', cardVisible() === false, String(cardVisible()))
  optimizeAborts = false
  optimizeDelay = 0

  console.log('\n[10] 优化请求失败 → 保持「优化」态并报错，预览卡不显示')
  optimizeFails = true
  mount('随便写点')
  click()
  await tick()
  s = state()
  check('失败后文案仍是「优化」', s.label === '优化', s.label)
  check('失败后草稿没被改', draft === '随便写点', draft)
  errText = ''
  walk(current, (node) => { if (node.props?.className === 'dsho-err') errText = textOf(node) })
  check('显示错误提示', errText.includes('模型炸了'), errText)
  check('失败后预览卡不显示', cardVisible() === false, String(cardVisible()))
  optimizeFails = false

  console.log('\n[11] 快速连点「优化」只发一次请求')
  optimizeCalls = 0
  optimizeDelay = 50
  mount('测试连点')
  click()
  click()
  click()
  await tick(150)
  check('只发出 1 次 optimize 请求', optimizeCalls === 1, String(optimizeCalls))
  check('结果在预览卡里', cardVisible() === true, String(cardVisible()))
  optimizeDelay = 0

  console.log('\n[12] 预览卡上「重新优化」→ 用当前草稿再跑一次')
  optimizeCalls = 0
  mount('换个说法')
  click()
  await tick()
  check('第一次优化完成', optimizeCalls === 1, String(optimizeCalls))
  cardButton('重新优化').props.onClick()
  await tick()
  check('又发了一次请求', optimizeCalls === 2, String(optimizeCalls))

  console.log('\n[13] 采用结果后用户又改内容 → 「退回」失效，切回「优化」')
  mount('原文内容')
  click()
  await tick()
  cardButton('替换草稿').props.onClick()
  await tick()
  check('先处于退回态', state().mode === 'restore', state().mode)
  draft = '原文内容，我再补一句'
  render()
  s = state()
  check('用户改内容后文案回到「优化」', s.label === '优化', s.label)
  check('data-mode=optimize', s.mode === 'optimize', s.mode)
  check('用户输入未被覆盖', draft === '原文内容，我再补一句', draft)

  console.log('\n[14] 退回态下用户清空输入 → 回到「优化」且禁用')
  mount('空测试')
  click()
  await tick()
  cardButton('替换草稿').props.onClick()
  await tick()
  check('先处于退回态', state().mode === 'restore', state().mode)
  draft = ''
  render()
  s = state()
  check('清空后文案为「优化」', s.label === '优化', s.label)
  check('清空后 disabled=true', s.disabled === true, String(s.disabled))

  console.log('\n[15] 结果到手后用户又改输入 → 「替换草稿」应转为禁用，不覆盖新内容')
  mount('原来的需求')
  click()
  await tick()
  check('先有预览卡', cardVisible() === true, String(cardVisible()))
  check('此时不冲突', cardButton('替换草稿').props.disabled !== true)
  // 用户在预览卡出现之后才改了输入框
  draft = '原来的需求，我再补一句'
  render()
  await tick()
  const lateAdopt = cardButton('替换草稿')
  check('「替换草稿」被禁用', lateAdopt !== null && lateAdopt.props.disabled === true,
    lateAdopt ? String(lateAdopt.props.disabled) : 'no button')
  check('卡上给出冲突说明', /改过输入框/.test(cardText()), cardText())
  // 即便绕过禁用直接调 adopt，草稿也不能被覆盖
  lateAdopt.props.onClick()
  await tick()
  check('用户输入未被覆盖', draft === '原来的需求，我再补一句', draft)

  console.log('\n[16] 结果区：整张预览卡就是可缩放的窗口，手柄在卡片外沿且平时隐藏')
  mount('测一下结果区')
  click()
  await tick()
  const dockNode = cardNode('dsho-dock')
  check('预览卡本体存在', dockNode !== null)
  check('结果正文区存在',
    cardNode('dsho-dock-frame') !== null && cardNode('dsho-dock-body') !== null)
  const grip = cardNode('dsho-dock-grip')
  check('有高度手柄', grip !== null)
  check('高度手柄不在结果框内部（在卡片外沿）',
    grip !== null && insideFrame('dsho-dock-grip') === false,
    grip === null ? 'no grip' : String(insideFrame('dsho-dock-grip')))
  check('左右边缘手柄也在卡片外沿',
    cardEdge('left') !== null && cardEdge('right') !== null
      && insideFrame('dsho-dock-edge') === false)
  check('三个手柄都是预览卡的直接子节点',
    dockHasChild('dsho-dock-grip')
      && dockHasChild('dsho-dock-edge')
      && dockHasChild('dsho-dock-frame'))
  check('手柄标记为 separator（只改尺寸，不位移）',
    grip && grip.props.role === 'separator'
      && cardEdge('left').props.role === 'separator'
      && cardEdge('right').props.role === 'separator')
  check('手柄可用键盘微调',
    grip && grip.props.tabIndex === 0
      && cardEdge('left').props.tabIndex === 0
      && cardEdge('right').props.tabIndex === 0)
  check('手柄平时隐藏（CSS 默认 opacity:0）',
    /\.dsho-dock-edge,\.dsho-dock-grip\{opacity:0\}/.test(source))
  check('鼠标移上去 / 正在拖 / 键盘聚焦时才显现',
    /\.dsho-dock:hover \.dsho-dock-edge/.test(source)
      && /\.dsho-dock\[data-resizing="true"\] \.dsho-dock-edge/.test(source)
      && /\.dsho-dock:focus-within \.dsho-dock-edge/.test(source))
  check('未调整时卡片高度自适应（不写死 height）',
    dockWidth() === undefined || dockWidth().height === undefined,
    JSON.stringify(dockWidth()))
  check('未调整时标记 data-height-adjusted=false',
    dockNode.props['data-height-adjusted'] === 'false',
    dockNode.props['data-height-adjusted'])

  console.log('\n[17] 拖动高度手柄改整张卡片的高度：往下拖 = 变矮，往上拖 = 变高')
  domRects.set('dsho-dock', { height: 300, width: 800, top: 0, left: 200 })
  clearWindowListeners()
  cardNode('dsho-dock-grip').props.onPointerDown({ button: 0, clientY: 100, preventDefault: () => {} })
  await tick()
  check('拖动时标记 data-resizing=true（手柄这时才显现）',
    cardNode('dsho-dock').props['data-resizing'] === 'true',
    cardNode('dsho-dock').props['data-resizing'])
  const moveListener = lastMoveListener()
  check('拖动时注册了 pointermove 监听', moveListener !== undefined)
  if (moveListener) {
    moveListener.fn({ clientY: 180 })   // 往下拖 80px
    await tick()
    const style = dockWidth()
    check('往下拖 80px → 卡片高度 220px（上沿下移 = 变矮）',
      style && style.height === '220px',
      style ? JSON.stringify(style) : 'no style')
    check('标记 data-height-adjusted=true',
      cardNode('dsho-dock').props['data-height-adjusted'] === 'true',
      cardNode('dsho-dock').props['data-height-adjusted'])
    const upListener = endGesture()
    if (upListener) upListener.fn()
    await tick()
    check('松手后 data-resizing 复位',
      cardNode('dsho-dock').props['data-resizing'] === 'false',
      cardNode('dsho-dock').props['data-resizing'])
    // 再往上拖 100px
    domRects.set('dsho-dock', { height: 400, width: 800, top: 0, left: 200 })
    clearWindowListeners()
    cardNode('dsho-dock-grip').props.onPointerDown({ button: 0, clientY: 200, preventDefault: () => {} })
    const move2 = lastMoveListener()
    if (move2) move2.fn({ clientY: 100 })
    await tick()
    const style2 = dockWidth()
    check('往上拖 100px → 卡片高度 500px',
      style2 && style2.height === '500px',
      style2 ? JSON.stringify(style2) : 'no style')
    const up2 = endGesture()
    if (up2) up2.fn()
  }
  check('高度被记住（localStorage）',
    sandbox.localStorage.getItem('dsho.preview.body-height') !== null,
    String(sandbox.localStorage.getItem('dsho.preview.body-height')))

  console.log('\n[18] 方向键微调：上下各 24px，且有上下限')
  const h0 = Number(String(dockWidth().height).replace('px', ''))
  cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
  await tick()
  check('ArrowDown → 高度 -24',
    dockWidth() && dockWidth().height === `${h0 - 24}px`,
    JSON.stringify(dockWidth()))
  cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
  cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
  await tick()
  check('ArrowUp → 高度 +24',
    dockWidth() && dockWidth().height === `${h0 + 24}px`,
    JSON.stringify(dockWidth()))
  // 连续往上推，撞到上限 720
  for (let i = 0; i < 40; i++) {
    cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
  }
  await tick()
  check('高度被限制在上限 720px',
    dockWidth() && dockWidth().height === '720px',
    JSON.stringify(dockWidth()))
  // 连续往下推，撞到下限 160
  for (let i = 0; i < 60; i++) {
    cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })
  }
  await tick()
  check('高度被限制在下限 160px',
    dockWidth() && dockWidth().height === '160px',
    JSON.stringify(dockWidth()))

  console.log('\n[19] 记住的高度在新挂载时生效')
  sandbox.localStorage.setItem('dsho.preview.body-height', '300')
  mount('新会话也用上次的大小')
  click()
  await tick()
  check('新挂载时卡片高度 = 上次记住的 300px',
    dockWidth() && dockWidth().height === '300px',
    JSON.stringify(dockWidth()))
  sandbox.localStorage.removeItem('dsho.preview.body-height')

  console.log('\n[20] 结果卡片左右两侧都有独立的手柄')
  mount('测一下左右拖动')
  click()
  await tick()
  const leftEdge = cardEdge('left')
  const rightEdge = cardEdge('right')
  check('左边有边缘手柄', leftEdge !== null)
  check('右边有边缘手柄', rightEdge !== null)
  check('手柄标记为 separator（只改宽度，不位移）',
    leftEdge && leftEdge.props.role === 'separator',
    leftEdge ? String(leftEdge.props.role) : 'no edge')
  check('手柄可用键盘微调', leftEdge && leftEdge.props.tabIndex === 0,
    leftEdge ? String(leftEdge.props.tabIndex) : 'no edge')
  check('未调整宽度时卡片不加宽度样式（保持原观感）',
    dockWidth() === undefined || dockWidth().width === undefined,
    JSON.stringify(dockWidth()))

  console.log('\n[21] 拖右边缘 → 只改右侧，左侧不受影响')
  // 卡片宽 800，left=200，视口宽 1200 → 右边还有 200px 可扩
  domRects.set('dsho-dock', { height: 300, width: 800, top: 0, left: 200 })
  clearWindowListeners()
  cardEdge('right').props.onPointerDown({ button: 0, clientX: 1000, preventDefault: () => {} })
  const moveRight = lastMoveListener()
  check('拖动时注册了 pointermove 监听', moveRight !== undefined)
  if (moveRight) {
    moveRight.fn({ clientX: 1060 })   // 往外拖 60px
    await tick()
    const style = dockWidth()
    check('右侧扩出 60px',
      style && style.width === 'calc(100% + 0px + 60px)',
      style ? String(style.width) : 'no style')
    check('右侧 margin 让出 60px',
      style && style.marginRight === '-60px',
      style ? String(style.marginRight) : 'no style')
    check('左侧 margin 不变（互不影响）',
      style && style.marginLeft === '0px',
      style ? String(style.marginLeft) : 'no style')
    const up = endGesture()
    if (up) up.fn()
  }
  let insets = storedInsets()
  check('扩出量被记住（localStorage）',
    insets !== null && insets.right === 60 && insets.left === 0,
    JSON.stringify(insets))

  console.log('\n[22] 再拖左边缘 → 只改左侧，右侧保持不变')
  clearWindowListeners()
  cardEdge('left').props.onPointerDown({ button: 0, clientX: 200, preventDefault: () => {} })
  const moveLeft = lastMoveListener()
  if (moveLeft) {
    moveLeft.fn({ clientX: 160 })   // 往左拖 40px = 往左扩 40px
    await tick()
    const style = dockWidth()
    check('左侧扩出 40px',
      style && style.width === 'calc(100% + 40px + 60px)',
      style ? String(style.width) : 'no style')
    check('左侧 margin 让出 40px',
      style && style.marginLeft === '-40px',
      style ? String(style.marginLeft) : 'no style')
    check('右侧 margin 保持 -60px（右侧不被左拖影响）',
      style && style.marginRight === '-60px',
      style ? String(style.marginRight) : 'no style')
    const up = endGesture()
    if (up) up.fn()
  }
  insets = storedInsets()
  check('两侧扩出量分别记住',
    insets !== null && insets.left === 40 && insets.right === 60,
    JSON.stringify(insets))

  console.log('\n[23] 左边缘往里拖 = 收窄（负扩出量）')
  clearWindowListeners()
  cardEdge('left').props.onPointerDown({ button: 0, clientX: 160, preventDefault: () => {} })
  const moveIn = lastMoveListener()
  if (moveIn) {
    moveIn.fn({ clientX: 200 })   // 往右拖 40px = 收窄 40px
    await tick()
    const style = dockWidth()
    check('左侧收窄 40px（扩出量变 0）',
      style && style.width === 'calc(100% + 0px + 60px)',
      style ? String(style.width) : 'no style')
    const up = endGesture()
    if (up) up.fn()
  }

  console.log('\n[24] 往外拖有上限：不会拖出视口（不产生横向滚动条）')
  // 卡片 left=200，视口宽 1200 → 两侧最多各扩 200-12=188
  domRects.set('dsho-dock', { height: 300, width: 800, top: 0, left: 200 })
  clearWindowListeners()
  cardEdge('right').props.onPointerDown({ button: 0, clientX: 1000, preventDefault: () => {} })
  const moveFar = lastMoveListener()
  if (moveFar) {
    moveFar.fn({ clientX: 1400 })   // 远远超出去
    await tick()
    const style = dockWidth()
    const stored = storedInsets()
    check('右侧扩出量被夹在视口剩余空间内',
      stored !== null && stored.right <= 188,
      JSON.stringify(stored))
    check('宽度样式跟着夹后的值走',
      style && style.width === `calc(100% + ${stored.left}px + ${stored.right}px)`,
      style ? String(style.width) : 'no style')
    const up = endGesture()
    if (up) up.fn()
  }

  console.log('\n[25] 方向键微调宽度：左右各 24px，只动聚焦那侧')
  const before = storedInsets()
  cardEdge('left').props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} })
  await tick()
  let after = storedInsets()
  check('ArrowRight → 左侧 +24',
    after !== null && after.left === before.left + 24,
    JSON.stringify(after))
  check('右侧不受影响',
    after !== null && after.right === before.right,
    JSON.stringify(after))
  cardEdge('right').props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} })
  await tick()
  after = storedInsets()
  check('ArrowLeft → 右侧 -24',
    after !== null && after.right === before.right - 24,
    JSON.stringify(after))
  check('左侧保持不变',
    after !== null && after.left === before.left + 24,
    JSON.stringify(after))

  console.log('\n[26] 记住的宽度在新挂载时生效')
  const remembered = storedInsets()
  mount('新会话也用上次的宽度')
  click()
  await tick()
  const style = dockWidth()
  check('新挂载时宽度 = 上次记住的扩出量',
    style && style.width === `calc(100% + ${remembered.left}px + ${remembered.right}px)`,
    style ? String(style.width) : 'no style')
  sandbox.localStorage.removeItem('dsho.preview.body-width')

  console.log('\n[27] A4 流式：生成过程中预览卡就出现，并显示「生成中…」')
  optimizeDelay = 120
  streamCalls = 0
  mount('流式测试')
  click()
  await tick(20)
  check('走的是流式接口', streamCalls === 1, String(streamCalls))
  check('生成中预览卡已经出现', cardVisible() === true, String(cardVisible()))
  check('标题带「生成中…」', /生成中/.test(cardText()), cardText())
  check('此时「替换草稿」不可用（还没生成完）', (() => {
    const btn = cardButton('替换草稿')
    return btn !== null && btn.props.disabled === true
  })())
  await tick(200)
  optimizeDelay = 0

  console.log('\n[28] C18 用量反馈：用时、token、字数都写在预览卡上')
  check('预览卡仍在', cardVisible() === true, String(cardVisible()))
  check('显示用时（1234ms → 1.2s）', /1\.2s/.test(cardText()), cardText())
  check('显示 token 用量（50 token）', /50 token/.test(cardText()), cardText())
  check('显示字数', new RegExp(optimizeText.length + ' 字').test(cardText()), cardText())
  check('模型名写在卡上', /space-bunny/.test(cardText()), cardText())
  /*
   * 思考过程默认收起。
   *
   * 早先这里是展开显示的 —— 结果一次优化能推几百帧 reasoning（几千字），
   * 正文却只有几十字，卡片里上下两坨长文字，用户分不清哪一版是要用的。
   * 现在默认只留一行摘要，点开才看正文。判据因此改成：
   *   块还在（不是删掉）、收起时不露出正文、点一下能展开。
   */
  check('思考过程单独一块', cardNode('dsho-dock-reasoning') !== null)
  check('思考过程默认收起，不露出正文', !/先确认任务范围/.test(textOf(cardNode('dsho-dock-reasoning'))))
  check('收起时标题带字数', /思考过程 · \d+ 字/.test(textOf(cardNode('dsho-dock-reasoning'))),
    textOf(cardNode('dsho-dock-reasoning')))
  const reasoningToggle = cardNode('dsho-dock-reasoning-title')
  check('思考过程标题可点开', reasoningToggle !== null && typeof reasoningToggle.props.onClick === 'function')
  if (reasoningToggle !== null && typeof reasoningToggle.props.onClick === 'function') {
    reasoningToggle.props.onClick()
    await tick(0)
    check('展开后能看到思考正文', /先确认任务范围/.test(textOf(cardNode('dsho-dock-reasoning'))),
      textOf(cardNode('dsho-dock-reasoning')))
  }
  check('生成结束后「替换草稿」可用', (() => {
    const btn = cardButton('替换草稿')
    return btn !== null && btn.props.disabled !== true
  })())

  console.log('\n[29] A4 流式：取消时收到 aborted 帧 → 不报错、不留卡片')
  optimizeAborts = true
  mount('流式取消')
  click()
  await tick(120)
  check('取消后预览卡不显示', cardVisible() === false, String(cardVisible()))
  let streamErr = ''
  walk(current, (node) => { if (node.props?.className === 'dsho-err') streamErr = textOf(node) })
  check('取消不弹错误提示', streamErr === '', streamErr)
  optimizeAborts = false

  console.log('\n[29b] 服务端说「要换稿」时，卡片上的字换成原因，而不是结果自己变掉')
  streamRevise = '超出这一档的长度上限，正在重新收敛…'
  // 帧序：start / reasoning / delta / revise / delta / done —— 让 revise 之后多停一会，
  // 好在这一刻观察界面（真实环境里重写要跑好几秒）。
  streamFrameDelays = [0, 0, 0, 0, 300, 0]
  mount('换稿提示')
  click()
  await tick(80)
  check('换稿说明写在卡上', /正在重新收敛/.test(cardMeta()), cardMeta())
  await tick(400)
  check('换稿结束后正文是最终结果', cardText().includes(optimizeText), cardText().slice(0, 120))
  check('换稿结束后不再显示换稿说明', !/正在重新收敛/.test(cardMeta()), cardMeta())
  streamFrameDelay = 0
  streamFrameDelays = null
  streamRevise = ''

  console.log('\n[29c] 上一批事件迟到时不能覆盖新一次优化的结果')
  /*
   * 第一版还在生成时用户点了卡片上的「重新优化」。
   *
   * 于是两路流同时在跑：先发的那路可能后结束。若它的尾巴照写不误，
   * 屏幕上就会出现「新结果闪一下又被上一版顶掉」—— 同样是结果突变。
   */
  {
    let releaseFirst
    const firstGate = new Promise((resolve) => { releaseFirst = resolve })
    const slowText = '【旧】这是上一次优化的结果'
    const fastText = '【新】这是这一次优化的结果'
    let streamRound = 0
    fetchImpl = async (url) => {
      const target = String(url)
      if (target.includes('/abort')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, aborted: true }) }
      }
      if (!target.includes('/stream')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      streamRound += 1
      const round = streamRound
      if (round === 1) await firstGate
      const body = round === 1 ? slowText : fastText
      return sseResponse([
        sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
        sseFrame('delta', { text: body }),
        sseFrame('done', {
          ok: true,
          text: body,
          provider: 'workbuddy',
          model: 'space-bunny',
          style: 'balanced',
          source: 'session',
          adjusted: null,
          recovered: false,
          usage: null,
          elapsedMs: 10,
        }),
      ])
    }

    mount('迟到事件测试')
    click()          // 第一次：卡在 firstGate 上
    await tick(20)
    optimizeCalls = 0
    // 第一路还在流里，用卡片上的「重新优化」开第二路。
    cardButton('重新优化').props.onClick()
    await tick(120)
    check('第二次的结果已经显示', cardText().includes(fastText), cardText().slice(0, 120))

    releaseFirst()   // 第一次的尾巴现在才回来
    await tick(120)
    check('迟到的旧结果没有覆盖新结果', cardText().includes(fastText) && !cardText().includes(slowText),
      cardText().slice(0, 160))
    useDefaultFetch()
  }

  console.log('\n[30] C19 视口约束：窗口变矮时卡片不能顶出屏幕，也不能把子块挤出去')
  // 卡片贴在输入框上方、整条 composer 贴底定位，所以卡片下沿固定：
  // 可用高度 = 下沿到视口顶部的距离 - 余量。这里把下沿摆在 660，视口高 700。
  sandbox.window.innerHeight = 700
  domRects.set('dsho-dock', { height: 300, width: 800, top: 360, left: 200 })
  mount('视口约束')
  click()
  await tick()
  // 记住的高度 720 只受写死上限约束 → 记下来的仍然是 720
  for (let i = 0; i < 40; i++) {
    cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
  }
  await tick()
  check('窗口矮时显示高度被视口夹住（下沿 660 - 余量 16 = 644）',
    dockWidth() && dockWidth().height === '644px',
    JSON.stringify(dockWidth()))
  check('用户想要的高度仍然记住 720（窗口恢复后能长回去）',
    sandbox.localStorage.getItem('dsho.preview.body-height') === '720',
    String(sandbox.localStorage.getItem('dsho.preview.body-height')))
  // 窗口变大：卡片应该跟着长回去
  sandbox.window.innerHeight = 1200
  // 视口变高 → composer 仍然贴底，卡片下沿跟着下移到 944，可用高度变回 928。
  domRects.set('dsho-dock', { height: 644, width: 800, top: 300, left: 200 })
  const resizeListeners = windowListeners.filter((l) => l.type === 'resize')
  check('挂了 window resize 监听', resizeListeners.length > 0, String(resizeListeners.length))
  if (resizeListeners.length > 0) {
    resizeListeners[resizeListeners.length - 1].fn()
    await tick()
    check('窗口变高后卡片长回 720',
      dockWidth() && dockWidth().height === '720px',
      JSON.stringify(dockWidth()))
  }
  // 量不到视口时退回写死的上限，别把卡片压成 0
  delete sandbox.window.innerHeight
  mount('没有 innerHeight')
  click()
  await tick()
  cardNode('dsho-dock-grip').props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
  await tick()
  check('量不到视口高度时退回写死上限（不误判为很小）',
    dockWidth() && dockWidth().height === '720px',
    JSON.stringify(dockWidth()))
  sandbox.window.innerHeight = 900
  domRects.set('dsho-dock', { height: 300, width: 800, top: 0, left: 200 })
  sandbox.localStorage.removeItem('dsho.preview.body-height')
  mount('恢复')
  click()
  await tick()

  console.log('\n[31] B5 历史：每次优化留一版，可回看、可对比、可切回')
  sandbox.localStorage.removeItem('dsho.preview.history')
  mount('第一版')
  optimizeText = '第一版结果：请在 DSH 工作区执行任务并汇总结果'
  click()
  await tick()
  const hist1 = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]')
  check('优化成功后记下一版历史', hist1.length === 1, String(hist1.length))
  check('历史里存了结果正文', hist1[0] && hist1[0].result === optimizeText, hist1[0] && hist1[0].result)
  check('历史里存了原文', hist1[0] && hist1[0].source === '第一版', hist1[0] && hist1[0].source)
  check('标题行出现「历史 1」按钮', /历史 1/.test(cardText()), cardText().slice(0, 80))

  optimizeText = '第二版结果：先读文件再改，最后跑测试'
  mount('第二版')
  click()
  await tick()
  const hist2 = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]')
  check('第二次优化后有两版', hist2.length === 2, String(hist2.length))
  check('最新一版排在最前', hist2[0].result === optimizeText, hist2[0].result)
  check('标题行显示「历史 2」', /历史 2/.test(cardText()), cardText().slice(0, 80))

  console.log('\n[32] B5 历史：展开列表 → 点一版 → 正文换成那一版并挂横幅')
  const histBtn = cardNode('dsho-dock-history-btn')
  check('历史按钮存在', histBtn !== null)
  if (histBtn) {
    histBtn.props.onClick()
    await tick()
    const list = cardNode('dsho-dock-history')
    check('展开后出现历史列表', list !== null)
    const rows = []
    walk(list, (node) => { if (node.props && node.props.className === 'dsho-dock-history-row') rows.push(node) })
    check('列表里有两行', rows.length === 2, String(rows.length))
    check('行里显示结果摘要', rows[0] && /第二版结果/.test(textOf(rows[0])), rows[0] ? textOf(rows[0]) : 'no row')
    rows[1].props.onClick()
    await tick()
    // 只看正文节点：历史列表展开着，卡片整体文本里还带着另一版的摘要，不能拿它判断。
    const bodyNode = cardNode('dsho-dock-body')
    const bodyText = bodyNode ? textOf(bodyNode) : ''
    check('正文换成被点的那一版',
      /第一版结果/.test(bodyText) && !/第二版结果/.test(bodyText),
      bodyText.slice(0, 80))
    check('挂出「正在看…历史」横幅', /正在看/.test(cardText()) && /那版历史/.test(cardText()), cardText().slice(0, 120))
    check('主按钮变成「用这一版」', cardButton('用这一版') !== null)
  }

  console.log('\n[33] B5 历史：「用这一版」写回草稿，并退出历史视图')
  const useBtn = cardButton('用这一版')
  if (useBtn) {
    useBtn.props.onClick()
    await tick()
    check('草稿被写成那一版', draft === '第一版结果：请在 DSH 工作区执行任务并汇总结果', draft)
    check('退出历史视图（横幅消失）', !/正在看/.test(cardText()), cardText().slice(0, 100))
  }

  console.log('\n[34] B5 对比：选另一版 → 两栏并排，改动行标色')
  mount('对比测试')
  click()
  await tick()
  const btn2 = cardNode('dsho-dock-history-btn')
  if (btn2) {
    btn2.props.onClick()
    await tick()
    const rows2 = []
    walk(cardNode('dsho-dock-history'), (node) => {
      if (node.props && node.props.className === 'dsho-dock-history-row') rows2.push(node)
    })
    rows2[0].props.onClick()
    await tick()
    const acts = []
    walk(cardNode('dsho-dock-history'), (node) => {
      if (node.props && node.props.className === 'dsho-dock-history-act') acts.push(node)
    })
    /*
     * 对比按钮每行一个。要挑的是「内容确实不同」的那一版 ——
     * 列表里可能有两条一模一样的（同一段话跑了两遍），拿它们对比只会得到「无差异」。
     */
    const targetRow = rows2.find((row) => /第一版结果/.test(textOf(row)))
    check('列表里能找到另一版（内容不同的那条）', targetRow !== undefined)
    let compareAct
    if (targetRow) {
      walk(targetRow, (node) => {
        if (!compareAct && node.props && node.props.className === 'dsho-dock-history-act'
          && /对比/.test(textOf(node)) && !/取消/.test(textOf(node))) compareAct = node
      })
    }
    check('列表里有「对比」按钮', compareAct !== undefined)
    if (compareAct) {
      compareAct.props.onClick({ stopPropagation: () => {} })
      await tick()
      const cols = []
      walk(currentCard, (node) => { if (node.props && node.props.className === 'dsho-dock-col') cols.push(node) })
      check('出现左右两栏', cols.length === 2, String(cols.length))
      // 两版正文完全不同，每一行都该被标成「改了」。
      const changed = []
      walk(currentCard, (node) => {
        if (node.props && node.props.className === 'dsho-diff-line' && node.props['data-changed'] === 'true') changed.push(node)
      })
      check('改动的行被标出来', changed.length > 0, String(changed.length))
      const unchanged = []
      walk(currentCard, (node) => {
        if (node.props && node.props.className === 'dsho-diff-line' && node.props['data-changed'] === 'false') unchanged.push(node)
      })
      check('两版完全不同的行都算改动（没有误标成相同）', changed.length > 0 && unchanged.length === 0,
        changed.length + ' changed / ' + unchanged.length + ' same')
      check('横幅说明这是对比', /对比：左边是/.test(cardText()), cardText().slice(0, 120))
    }
  }

  console.log('\n[35] B5 历史：删除一版')
  /*
   * 上一步点「对比」会把历史浮层收起来 —— 并排两栏会被浮层盖住，这是有意的。
   * 所以要删人得先把列表重新展开，不能指望它还开着。
   */
  const reopenBtn = cardNode('dsho-dock-history-btn')
  check('浮层收起后「历史 N」按钮还在', reopenBtn !== null)
  if (reopenBtn) {
    reopenBtn.props.onClick()
    await tick()
  }
  const histBefore = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]').length
  const delActs = []
  walk(currentCard, (node) => {
    if (node.props && node.props.className === 'dsho-dock-history-act' && textOf(node) === '删除') delActs.push(node)
  })
  check('列表里有「删除」按钮', delActs.length > 0, String(delActs.length))
  if (delActs.length > 0) {
    delActs[0].props.onClick({ stopPropagation: () => {} })
    await tick()
    const after = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]').length
    check('删掉一条后少一版', after === histBefore - 1, histBefore + ' -> ' + after)
  }

  console.log('\n[36] B5 历史：新一次优化会退出历史视图，不被旧版挡住')
  mount('再跑一次')
  optimizeText = '第三版结果'
  click()
  await tick()
  check('新结果直接显示（没有横幅）', !/正在看/.test(cardText()), cardText().slice(0, 100))
  check('新结果正文可见', /第三版结果/.test(cardText()), cardText().slice(0, 80))
  sandbox.localStorage.removeItem('dsho.preview.history')

  console.log('\n[37] 对比原文：结果 vs 我原来写的那句')
  {
    sandbox.localStorage.removeItem('dsho.preview.history')
    // 原文分两行，其中一行会被原样保留 —— 才能验证「没改的不标成改动」。
    mount('步骤：读入口、接入日志器。\n验收：日志出现。')
    optimizeText = '目标：补上日志功能。\n步骤：读入口、接入日志器。\n验收：日志出现。'
    click()
    await tick()

    const btn = cardButton('对比原文')
    check('结果出来后才有「对比原文」按钮', btn !== null, btn === null ? '没有按钮' : '有')
    if (btn !== null) {
      btn.props.onClick()
      await tick()
      const cols = []
      walk(currentCard, (node) => {
        if (node.props && node.props.className === 'dsho-dock-col') cols.push(node)
      })
      check('点开变成两栏并排', cols.length === 2, String(cols.length))

      const titles = []
      walk(currentCard, (node) => {
        if (node.props && node.props.className === 'dsho-dock-col-title') titles.push(textOf(node))
      })
      check('左边是原文、右边是结果', /原文/.test(titles[0] || '') && /优化结果/.test(titles[1] || ''),
        titles.join(' | '))

      const changed = []
      const same = []
      walk(currentCard, (node) => {
        if (node.props && node.props.className === 'dsho-diff-line') {
          if (node.props['data-changed'] === 'true') changed.push(node)
          else same.push(node)
        }
      })
      check('改动行被标出来', changed.length > 0, String(changed.length) + ' changed / ' + same.length + ' same')
      // 原文那两行被原样保留在结果里，不该被标成改动。
      check('没改的短句仍算相同（原文整行被保留）', same.length > 0, String(same.length))

      // 再点一次就是收起
      const exit = cardButton('退出对比')
      check('按钮变成「退出对比」', exit !== null, exit === null ? '没有' : '有')
      if (exit !== null) {
        exit.props.onClick()
        await tick()
        const colsAfter = []
        walk(currentCard, (node) => {
          if (node.props && node.props.className === 'dsho-dock-col') colsAfter.push(node)
        })
        check('收起后回到单栏', colsAfter.length === 0, String(colsAfter.length))
        check('正文仍在', /补上日志功能/.test(cardText()), cardText().slice(0, 60))
      }
    }

    // 原文与结果完全一样时不该给这个按钮（点了也是满屏「没改动」）。
    mount('一模一样的一句话')
    optimizeText = '一模一样的一句话'
    click()
    await tick()
    check('原文与结果相同时不出现「对比原文」', cardButton('对比原文') === null, '符合预期')
    sandbox.localStorage.removeItem('dsho.preview.history')
  }

  console.log('\n[38] 历史记下「这一版经历了什么」+ 一键清空')
  {
    sandbox.localStorage.removeItem('dsho.preview.history')
    mount('帮我补日志')
    optimizeText = '目标：补日志。'
    click()
    await tick()
    const list = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]')
    check('历史里记了 adjusted 字段', list.length === 1 && 'adjusted' in (list[0].meta || {}),
      JSON.stringify(list[0] && list[0].meta))
    check('历史里记了 freeUsed 字段', list.length === 1 && 'freeUsed' in (list[0].meta || {}),
      JSON.stringify(list[0] && list[0].meta))
    check('历史里记了 recovered 字段', list.length === 1 && 'recovered' in (list[0].meta || {}),
      JSON.stringify(list[0] && list[0].meta))

    // 再跑一版「被收敛过 + 走免费通道」的，列表里应该能看出区别。
    doneAdjusted = 'trimmed'
    doneRecovered = true
    doneSource = 'free'
    mount('再补一次日志')
    optimizeText = '目标：补日志（第二版）。'
    click()
    await tick()
    doneAdjusted = null
    doneRecovered = false
    doneSource = 'session'

    const openBtn = cardButton('历史 2')
    if (openBtn !== null) openBtn.props.onClick()
    await tick()
    const tags = []
    walk(currentCard, (node) => {
      if (node.props && node.props.className === 'dsho-dock-history-tag') tags.push(textOf(node))
    })
    check('收敛过的那版标「已收敛」', tags.includes('已收敛'), tags.join(','))
    check('拉回过的那版标「已拉回」', tags.includes('已拉回'), tags.join(','))
    check('免费通道那版标「免费通道」', tags.includes('免费通道'), tags.join(','))

    const clear = []
    walk(currentCard, (node) => {
      if (node.props && node.props.className === 'dsho-dock-history-act' && textOf(node) === '清空') clear.push(node)
    })
    check('列表里有「清空」按钮', clear.length === 1, String(clear.length))
    if (clear.length === 1) {
      clear[0].props.onClick({ stopPropagation: () => {} })
      await tick()
      const after = JSON.parse(sandbox.localStorage.getItem('dsho.preview.history') || '[]')
      check('清空后历史为空', after.length === 0, String(after.length))
      check('清空后「历史 N」按钮消失', cardButton('历史 2') === null, '没有了')
    }
  }

  console.log('\n[39] 回退：宿主没有 /stream 时改走 /optimize，结果照样出来')
  {
    // 旧实现的回退分支是「把 /stream 的响应硬当结果解析」，404 时拿不到 text，
    // 用户只会看到「模型返回了空内容」。这里钉死「真的换了一条接口」。
    streamMissing = true
    const callsBefore = optimizeCalls
    mount('回退用例')
    optimizeText = '回退后拿到的结果'
    click()
    await tick(40)
    check('结果出来了（不是空内容）', /回退后拿到的结果/.test(cardText()), cardText().slice(0, 90))
    check('真的又打了一次 /optimize', optimizeCalls === callsBefore + 2,
      'calls ' + callsBefore + ' -> ' + optimizeCalls)
    streamMissing = false
  }

  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
