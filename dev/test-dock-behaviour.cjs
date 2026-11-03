/**
 * test-dock-behaviour.cjs —— 预览卡三个真实缺陷的回归测试。
 *
 * 三个缺陷都是用户在真实界面里遇到的，且都能在客户端这一层稳定复现：
 *
 *   1. 思考过程漏进结果框
 *      模型把「这一步该怎么做」写进正文（或在正文里夹带推理），
 *      那段话就原样出现在结果框里 —— 用户看到的是模型的内心独白，
 *      不是可以发给 DSH 的提示词。
 *
 *   2. 放弃之后又自己弹回来
 *      优化还在跑时点「放弃」，卡片关掉了；流跑完 done 事件一到，
 *      runOptimize 照样把 phase 写回 'ready' —— 卡片又弹出来。
 *
 *   3. 卡片跟着别的对话跑
 *      预览状态是**模块级单例**（previewStore），不区分会话。
 *      在会话 A 点优化，切到会话 B，卡片照样显示在 B 的输入框上方。
 *
 * 用和 test-preview-flow.cjs 同一套最小 React 桩 + 微型渲染器，
 * 但 fetch 桩可按用例换，因此三个场景互不干扰。
 */
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const CLIENT = process.env.DSHO_CLIENT || path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

// ── 最小 React 桩（与 test-preview-flow.cjs 同构） ────────────────────────
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
  // 组件包装器（safe()）是 class 组件，必须能用 new 构造 ——
  // 用普通 function 冒充会被 "Class constructor cannot be invoked without 'new'" 打回来。
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

let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
const windowListeners = []
const sandbox = {
  window: {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    addEventListener: (type, fn) => { windowListeners.push({ type, fn }) },
    removeEventListener: (type, fn) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.fn === fn)
      if (index >= 0) windowListeners.splice(index, 1)
    },
    innerWidth: 1200,
  },
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
let factory = null
vm.runInContext(source, sandbox, { filename: CLIENT })
if (!factory) throw new Error('client.js 没有注册 __ModuleLoader__.load')

const registered = {}
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
const Card = registered['conversation.input.dock'].component
if (!Button) throw new Error('没有注册 conversation.input.right 组件')
if (!Card) throw new Error('没有注册 conversation.input.dock 组件')

// ── 微型渲染器 ────────────────────────────────────────────────────────────
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
let currentCard = null
let currentButton = null

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
  if (typeof type === 'string') {
    const children = el.props && el.props.children
    if (children !== undefined) {
      el.props.children = Array.isArray(children) ? children.map(renderElement) : renderElement(children)
    }
    if (el.props && el.props.ref) {
      const className = el.props.className || type
      el.props.ref.current = {
        getBoundingClientRect: () => ({ height: 220, width: 800, top: 0, left: 0, bottom: 220, right: 800 }),
      }
    }
  }
  return el
}

const slotStates = new Map()
let renderCounter = 0
function renderSlotComponent(Component, slotKey, propsFor) {
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
  // 注册进来的组件外面包着 safe() 的错误边界，它是个 class —— 得走 new。
  const element = isClassComponent(Component)
    ? new Component(propsFor()).render()
    : Component(propsFor())
  const out = renderElement(element)
  const queued = effects
  effects = []
  for (const fn of queued) {
    hookStates = slot.states
    fn()
  }
  hookStates = savedHookStates
  hookIndex = savedHookIndex
  effects = savedEffects
  return out
}

/** 当前「在哪个会话」。切会话时改它，模拟用户点了另一个对话。 */
let activeSessionId = 'session-A'

function propsFor() {
  return {
    sessionId: activeSessionId,
    useInput: (selector) => selector({ draft }),
    inputActions: { setDraft: (text) => { draft = text; render() } },
  }
}

function render() {
  const my = ++renderCounter
  const buttonTree = renderSlotComponent(Button, 'conversation.input.right', propsFor)
  const cardTree = renderSlotComponent(Card, 'conversation.input.dock', propsFor)
  if (renderCounter !== my) return currentCard
  currentButton = buttonTree
  currentCard = cardTree
  return currentCard
}
scheduleRender = () => { render() }

/**
 * 把预览卡恢复到「什么都没有」的状态。
 *
 * previewStore 是模块级单例，mount() 只清 hook 状态，清不掉它 ——
 * 上一个用例结束时卡片还停在 ready，下一个用例点「优化」就会走成
 * 「采用上一份结果」，而不是发起新的优化。所以每个用例开头先放弃一次。
 */
function resetCard() {
  activeSessionId = 'session-A'
  render()
  if (cardVisible()) {
    const discard = cardButton('放弃')
    if (discard !== null) discard.props.onClick()
  }
  render()
}

function mount(initialDraft) {
  resetCard()
  slotStates.clear()
  draft = initialDraft
  render()
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 0 : ms))

// ── 断言 ──────────────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); return }
  failures++
  console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''))
}

function cardNode(className) {
  let found = null
  walk(currentCard, (node) => {
    if (!found && node.props && node.props.className === className) found = node
  })
  return found
}
function cardVisible() {
  return currentCard !== null && typeof currentCard === 'object' && currentCard.type !== undefined
}
function cardText() { return textOf(currentCard) }
function cardButton(text) { return findButtonByText(currentCard, text) }

/** 找任意可点元素（button 或带 onClick 的节点），用于展开/收起这类轻交互。 */
function findToggle(root) {
  let found = null
  walk(root, (node) => {
    if (found) return
    if (node.props && typeof node.props.onClick === 'function') found = node
  })
  return found
}

// ── SSE 桩 ────────────────────────────────────────────────────────────────
function sseFrame(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
}
function sseResponse(frames, delay) {
  let index = 0
  const body = {
    getReader() {
      return {
        async read() {
          if (delay) await tick(delay)
          if (index >= frames.length) return { done: true, value: undefined }
          // 直接给字符串：客户端那边 TextDecoder 不在沙箱里，
          // 它按 String(chunk.value) 兜底，给字符串正好走这条。
          return { done: false, value: frames[index++] }
        },
      }
    },
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body,
  }
}

const OPTIMIZED = '请在 DSH 工作区执行任务，并贴出改动的文件清单。'

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[1] 思考过程不许漏进结果框')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 真实服务器抓到过：reasoning 事件 39 帧、正文 31 字，reasoning 内容是
  // "This is b) type — a simple question. ... Output one sentence."
  // 那段话一旦被并进正文，用户拿到的就不是提示词，是模型的草稿纸。
  {
    const reasoning = 'This is b) type — a simple question. Rewrite as one clear question. Output one sentence.'
    fetchImpl = async (url) => {
      if (String(url).includes('/stream')) {
        return sseResponse([
          sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
          sseFrame('reasoning', { text: reasoning }),
          sseFrame('delta', { text: OPTIMIZED }),
          sseFrame('done', {
            ok: true, text: OPTIMIZED, provider: 'workbuddy', model: 'space-bunny',
            style: 'balanced', source: 'session', adjusted: null, recovered: false,
            reasoning, usage: null, elapsedMs: 900,
          }),
        ])
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    mount('怎么配置 profile？')
    const buttons = []
    walk(currentButton, (node) => { if (node.type === 'button') buttons.push(textOf(node) || '(icon)') })
    console.log('    [debug] 按钮：', JSON.stringify(buttons))
    let clicked = false
    walk(currentButton, (node) => {
      if (node.type === 'button' && !clicked) { clicked = true; node.props.onClick() }
    })
    await tick(30)
    console.log('    [debug] 点击后卡片可见 =', cardVisible())

    const body = cardNode('dsho-dock-body')
    const bodyText = body === null ? '' : textOf(body)
    check('结果框里没有思考过程',
      !bodyText.includes('This is b) type') && !bodyText.includes('Output one sentence'),
      bodyText.slice(0, 120))
    check('结果框里就是改写后的提示词', bodyText.includes('请在 DSH 工作区执行任务'), bodyText.slice(0, 120))

    // 思考过程仍应单独可见 —— 它不是要删掉，是不能混进正文。
    const reasoningNode = cardNode('dsho-dock-reasoning')
    check('思考过程仍单独显示', reasoningNode !== null)
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[2] 点了「放弃」之后，优化完成不许再弹回来')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 流是慢慢来的：先 delta 让卡片出现，用户此时点「放弃」，
  // 之后 done 才到。旧实现里 runOptimize 收尾无条件写 phase:'ready'，
  // 卡片于是又弹出来 —— 用户已经明确关掉了。
  {
    fetchImpl = async (url) => {
      if (String(url).includes('/stream')) {
        return sseResponse([
          sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
          sseFrame('delta', { text: OPTIMIZED }),
          sseFrame('done', {
            ok: true, text: OPTIMIZED, provider: 'workbuddy', model: 'space-bunny',
            style: 'balanced', source: 'session', adjusted: null, recovered: false,
            reasoning: '', usage: null, elapsedMs: 900,
          }),
        ], 25)
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    mount('帮我把项目跑一下')
    let clicked = false
    walk(currentButton, (node) => {
      if (node.type === 'button' && !clicked) { clicked = true; node.props.onClick() }
    })
    // 等第一帧 delta 到达，卡片出现
    await tick(60)
    check('优化进行中卡片已出现', cardVisible() === true, String(cardVisible()))

    const discard = cardButton('放弃')
    check('有「放弃」按钮', discard !== null)
    if (discard !== null) discard.props.onClick()
    await tick(0)
    check('点放弃后卡片收起', cardVisible() === false, String(cardVisible()))

    // 等流跑完，done 到达
    await tick(200)
    check('优化完成后卡片没有自己弹回来', cardVisible() === false, String(cardVisible()))
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[3] 预览卡只留在发起它的那个会话')
  // ══════════════════════════════════════════════════════════════════════
  //
  // previewStore 是模块级单例，不记会话。在 A 里点优化，切到 B，
  // B 的输入框上方照样挂着 A 的结果 —— 用户会以为那是 B 的结果。
  {
    fetchImpl = async (url) => {
      if (String(url).includes('/stream')) {
        return sseResponse([
          sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
          sseFrame('delta', { text: OPTIMIZED }),
          sseFrame('done', {
            ok: true, text: OPTIMIZED, provider: 'workbuddy', model: 'space-bunny',
            style: 'balanced', source: 'session', adjusted: null, recovered: false,
            reasoning: '', usage: null, elapsedMs: 900,
          }),
        ])
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }

    activeSessionId = 'session-A'
    mount('帮我把项目跑一下')
    let clicked = false
    walk(currentButton, (node) => {
      if (node.type === 'button' && !clicked) { clicked = true; node.props.onClick() }
    })
    await tick(30)
    check('会话 A 里卡片出现', cardVisible() === true, String(cardVisible()))

    // 用户切到另一个对话
    activeSessionId = 'session-B'
    draft = ''
    render()
    await tick(0)
    check('切到会话 B 后卡片不再显示', cardVisible() === false, String(cardVisible()))

    // 切回 A，卡片应该还在（结果没丢）
    activeSessionId = 'session-A'
    render()
    await tick(0)
    check('切回会话 A 卡片还在', cardVisible() === true, String(cardVisible()))
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[4] 模型把思考写进正文通道时，结果框也要把它剥掉')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 真实环境里不是所有模型都规规矩矩只走 reasoning 通道：有的把「这一步该
  // 怎么写」混进正文一起吐出来。用户看到的就是模型的草稿纸躺在结果框里。
  // 客户端不能指望上游分得干净 —— 结果框里只该有能直接发给 DSH 的提示词。
  {
    const thinking = '这是 b) 类简单提问，只需改写成一句更清楚的提问，不回答。原文已经是清楚的提问。'
    const prompt = 'profile 怎么配置？需要改哪个文件、填哪些项，给出可直接照着做的步骤。'
    fetchImpl = async (url) => {
      if (String(url).includes('/stream')) {
        return sseResponse([
          sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
          sseFrame('reasoning', { text: thinking }),
          // 正文通道里把思考又吐了一遍，然后才给真正的提示词。
          sseFrame('delta', { text: thinking + '\n\n' + prompt }),
          sseFrame('done', {
            ok: true, text: thinking + '\n\n' + prompt,
            provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session',
            adjusted: null, recovered: false, reasoning: thinking, usage: null, elapsedMs: 900,
          }),
        ])
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    mount('怎么配置 profile？')
    let clicked = false
    walk(currentButton, (node) => {
      if (node.type === 'button' && !clicked) { clicked = true; node.props.onClick() }
    })
    await tick(30)

    const body = cardNode('dsho-dock-body')
    const bodyText = body === null ? '' : textOf(body)
    check('结果框里没有思考那一段', !bodyText.includes('这是 b) 类简单提问'), bodyText.slice(0, 120))
    check('结果框里保留真正的提示词', bodyText.includes('需要改哪个文件'), bodyText.slice(0, 120))

    // 「替换草稿」和「复制」拿的都是 state.result —— 那里也必须已经剥干净，
    // 否则用户把结果写回输入框，草稿里又带着草稿纸。
    const adopt = cardButton('替换草稿')
    if (adopt !== null) {
      adopt.props.onClick()
      await tick(0)
      check('写回草稿的是干净正文', !draft.includes('这是 b) 类简单提问'), draft.slice(0, 120))
      // 判据用「和输入框里原来那句不一样」，而不是拿正文片段去猜：
      // adopt 之后卡片会收起，draft 是被 adoptPreview 写进去的那一份。
      // adoptPreview 在冲突时会拒绝写回。这里 mount 的草稿就是 source，
      // 按理不该冲突 —— 真冲突了要把判据打出来，否则只会看到「draft 没变」。
      check('写回草稿的是优化结果（不是原文）', draft.trim() !== '怎么配置 profile？',
        'draft=' + JSON.stringify(draft) + ' conflict=' + String(cardNode('dsho-dock-warn') !== null))
      check('写回草稿的确实是提示词', draft.includes('需要改哪个文件') || draft.includes('profile'), draft.slice(0, 120))
    } else {
      check('有「替换草稿」按钮', false)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[5] 思考过程默认收起，不会被当成第二版结果')
  // ══════════════════════════════════════════════════════════════════════
  //
  // 思考块和结果框长得很像，又都摆在卡片里。长思考（实测有 500+ 帧）会把
  // 卡片撑成上下两坨正文，用户分不清哪一版才是要用的。
  // 默认收起成一行摘要，要看再展开。
  {
    const thinking = '先判断这是哪一类输入。这是 b) 类提问，只需要把问题问清楚。'
    fetchImpl = async (url) => {
      if (String(url).includes('/stream')) {
        return sseResponse([
          sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
          sseFrame('reasoning', { text: thinking }),
          sseFrame('delta', { text: OPTIMIZED }),
          sseFrame('done', {
            ok: true, text: OPTIMIZED, provider: 'workbuddy', model: 'space-bunny',
            style: 'balanced', source: 'session', adjusted: null, recovered: false,
            reasoning: thinking, usage: null, elapsedMs: 900,
          }),
        ])
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    mount('怎么配置 profile？')
    let clicked = false
    walk(currentButton, (node) => {
      if (node.type === 'button' && !clicked) { clicked = true; node.props.onClick() }
    })
    await tick(30)

    const reasoningNode = cardNode('dsho-dock-reasoning')
    check('思考块还在（不是删掉）', reasoningNode !== null)
    const reasoningText = reasoningNode === null ? '' : textOf(reasoningNode)
    check('默认收起：不显示思考正文', !reasoningText.includes('这是 b) 类提问'), reasoningText.slice(0, 120))
    check('收起时给出摘要（带字数）', /思考过程/.test(reasoningText) && /字/.test(reasoningText), reasoningText.slice(0, 120))

    // 点一下能展开
    const toggle = findButtonByText(reasoningNode, textOf(reasoningNode))
      || (reasoningNode && findToggle(reasoningNode))
    if (toggle !== null && toggle !== undefined) {
      toggle.props.onClick()
      await tick(0)
      const expanded = cardNode('dsho-dock-reasoning')
      check('展开后能看到思考正文', textOf(expanded).includes('这是 b) 类提问'), textOf(expanded).slice(0, 120))
    } else {
      check('思考块上有展开入口', false, '找不到可点的按钮')
    }
  }

  console.log('')
  if (failures > 0) {
    console.error('DOCK BEHAVIOUR TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
    return
  }
  console.log('DOCK BEHAVIOUR TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
