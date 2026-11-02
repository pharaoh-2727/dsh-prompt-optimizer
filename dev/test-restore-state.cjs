/**
 * dsh-prompt-optimizer —— 「优化 / 退回」状态机回归测试（新流程语义）
 *
 * 新流程（A 组改造后）：
 *   点「优化」 → 结果落到输入框上方的预览卡，**草稿不被覆盖**；
 *   点预览卡里的「替换草稿」→ 才写回草稿，按钮进入「退回」态；
 *   点「退回」→ 恢复优化前原文。
 *
 * 本机没有可用的 react 包，所以用最小 React 桩 + 微型渲染器，
 * 直接把 client.js 里的 OptimizeButton 与 PreviewCard 跑起来。
 *
 * hook 状态跨渲染持久（与 React 一致），每个用例开头用 mount() 重置。
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
let stateVersion = 0

function makeReact() {
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
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } },
  console,
  fetch: (...args) => fetchImpl(...args),
  setTimeout, clearTimeout,
  navigator: { clipboard: { writeText: async () => {} } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: CLIENT })
if (!factory) throw new Error('client.js 没有注册 __ModuleLoader__.load')

const registered = {}
const ctx = {
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
  return el
}

/**
 * 渲染一个组件，单独给它一套 hook 槽位。
 * 两个槽位的组件是彼此独立的实例，hook 状态不能混在一起。
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
  const cardTree = renderSlotComponent(Card, 'conversation.input.dock')
  if (renderCounter !== my) return current
  current = buttonTree
  currentCard = cardTree
  return current
}

/** 全新挂载：清空 hook 状态，模拟用户重新打开页面。 */
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
function cardButton(text) { return findButtonByText(currentCard, text) }
function cardVisible() {
  return currentCard !== null && typeof currentCard === 'object' && currentCard.type !== undefined
}
function errorText() {
  let out = ''
  walk(current, (node) => { if (node.props?.className === 'dsho-err') out = textOf(node) })
  return out
}

// 可控的 optimize / abort 响应
let optimizeText = '【优化后】请在 DSH 工作区执行任务并汇总结果'
let optimizeDelay = 0
let optimizeCalls = 0
let optimizeFails = false
let abortCalls = 0

// ── SSE 响应桩 ──────────────────────────────────────────────────────────
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

function useDefaultFetch() {
  fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/abort')) {
      abortCalls++
      return { ok: true, status: 200, json: async () => ({ ok: true, aborted: true }) }
    }
    if (target.includes('/stream')) {
      optimizeCalls++
      if (optimizeDelay) await new Promise((r) => setTimeout(r, optimizeDelay))
      if (optimizeFails) {
        return sseResponse([sseFrame('error', { error: '模型炸了' })])
      }
      return sseResponse([
        sseFrame('start', { provider: 'workbuddy', model: 'space-bunny', style: 'balanced', source: 'session' }),
        sseFrame('delta', { text: optimizeText }),
        sseFrame('done', {
          ok: true,
          text: optimizeText,
          provider: 'workbuddy',
          model: 'space-bunny',
          style: 'balanced',
          source: 'session',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          elapsedMs: 500,
        }),
      ])
    }
    if (target.includes('/optimize')) {
      optimizeCalls++
      if (optimizeDelay) await new Promise((r) => setTimeout(r, optimizeDelay))
      if (optimizeFails) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: '模型炸了' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, text: optimizeText }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
}
useDefaultFetch()

/** 走完「优化 → 采用」两步，落到退回态。 */
async function optimizeAndAdopt() {
  click()
  await tick()
  const adopt = cardButton('替换草稿')
  if (!adopt) throw new Error('预览卡上没有「替换草稿」按钮')
  adopt.props.onClick()
  await tick()
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

  console.log('\n[3] 点「优化」→ 结果进预览卡，草稿不被覆盖')
  optimizeCalls = 0
  click()
  await tick()
  check('只发了 1 次请求', optimizeCalls === 1, String(optimizeCalls))
  check('草稿没有被结果覆盖', draft === '帮我把项目跑一下', draft)
  check('按钮仍在「优化」态（结果还没采用）', state().label === '优化', state().label)
  check('预览卡出现了', cardVisible() === true, String(cardVisible()))

  console.log('\n[4] 点「替换草稿」→ 写回草稿，按钮变「退回」')
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

  console.log('\n[6] 「退回」连点两次：第二次是重新优化，不是二次退回')
  mount('帮我把项目跑一下')
  await optimizeAndAdopt()
  check('优化并采用后处于退回态', state().mode === 'restore', state().mode)
  click()                       // 第一次：退回
  const afterFirst = draft
  check('第一次退回恢复原文', afterFirst === '帮我把项目跑一下', afterFirst)
  optimizeCalls = 0
  click()                       // 第二次：重新优化（结果进预览卡，不直接盖草稿）
  await tick()
  check('第二次触发的是重新优化', optimizeCalls === 1, String(optimizeCalls))
  check('草稿没有被自动覆盖', draft === '帮我把项目跑一下', draft)
  check('状态仍合法', ['optimize', 'restore'].includes(state().mode), state().mode)

  console.log('\n[7] 采用结果后用户再次输入 → 切回「优化」')
  mount('帮我把项目跑一下')
  await optimizeAndAdopt()
  check('先处于退回态', state().mode === 'restore', state().mode)
  draft = '帮我把项目跑一下，另外看看日志'   // 用户追加输入
  render()
  s = state()
  check('用户改内容后文案回到「优化」', s.label === '优化', s.label)
  check('data-mode=optimize', s.mode === 'optimize', s.mode)
  check('用户输入未被覆盖', draft === '帮我把项目跑一下，另外看看日志', draft)

  console.log('\n[8] 采用结果后用户把内容改回原文 → 也应切回「优化」')
  mount('帮我把项目跑一下')
  await optimizeAndAdopt()
  check('先处于退回态', state().mode === 'restore', state().mode)
  draft = '帮我把项目跑一下'   // 用户手动重打原文
  render()
  s = state()
  check('回到原文后不再显示「退回」', s.label === '优化', s.label)
  check('data-mode=optimize', s.mode === 'optimize', s.mode)

  console.log('\n[9] 优化请求失败 → 保持「优化」态并报错')
  optimizeFails = true
  mount('随便写点')
  click()
  await tick()
  s = state()
  check('失败后文案仍是「优化」', s.label === '优化', s.label)
  check('失败后草稿没被改', draft === '随便写点', draft)
  check('显示错误提示', errorText().includes('模型炸了'), errorText())
  check('失败后预览卡不显示', cardVisible() === false, String(cardVisible()))
  optimizeFails = false

  console.log('\n[10] 快速连点「优化」只发一次请求')
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

  console.log('\n[11] 退回态下用户清空输入 → 回到「优化」且禁用')
  mount('空测试')
  await optimizeAndAdopt()
  check('先处于退回态', state().mode === 'restore', state().mode)
  draft = ''
  render()
  s = state()
  check('清空后文案为「优化」', s.label === '优化', s.label)
  check('清空后 disabled=true', s.disabled === true, String(s.disabled))

  console.log('\n[12] 空输入点「退回」不报错（退回态下按钮始终可点）')
  mount('空测试2')
  await optimizeAndAdopt()
  check('处于退回态', state().mode === 'restore', state().mode)
  draft = ''
  render()
  click()
  await tick()
  check('退回后不抛异常、状态回到 optimize', state().mode === 'optimize', state().mode)

  console.log('\n' + (failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
