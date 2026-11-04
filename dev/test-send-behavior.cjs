/**
 * test-send-behavior.cjs —— 「发出去」的真实调用序列。
 *
 * test-send.cjs 查的是源码里有没有这个动作、顺序对不对。
 * 这个文件真的跑一遍：给一个会记录调用顺序的 inputActions 桩，
 * 看它到底先做了什么、后做了什么、发完之后卡片是不是关掉了。
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

/*
 * 取到内部函数：client.js 把动作都关在 factory 里，没导出。
 * 用同样的 module loader 把工厂跑一遍，从注册的组件里拿 ——
 * 但 sendToChat 是闭包内的，组件里也拿不到。
 *
 * 所以这里换个办法：把源码里那段函数体抠出来，在一个受控作用域里跑。
 * 这样测的是真实代码，不是复制品。
 */
function extractFn(name) {
  const start = source.indexOf('async function ' + name + '(')
  if (start < 0) return null
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

async function main() {
  const fnText = extractFn('sendToChat')
  check('抠得出 sendToChat', fnText !== null, '找不到函数')

  const calls = []
  const store = {
    state: { phase: 'ready', result: '目标：更新 README。\n产出格式：改好的章节。' },
    inputActions: {
      setDraft(text) { calls.push(['setDraft', text]) },
      submit() { calls.push(['submit']) },
    },
  }
  const discardPreview = () => { calls.push(['discard']) }

  // eslint-disable-next-line no-new-func
  const factoryFn = new Function('previewStore', 'discardPreview',
    'return (async () => { ' + fnText + '\n return sendToChat })()')
  const sendToChat = await factoryFn(store, discardPreview)
  const ok = await sendToChat()

  console.log('    调用序列: ' + calls.map((c) => c[0]).join(' → '))
  check('返回 true', ok === true, String(ok))
  check('第一步是 setDraft', calls[0] && calls[0][0] === 'setDraft', JSON.stringify(calls[0]))
  check('第二步是 submit', calls[1] && calls[1][0] === 'submit', JSON.stringify(calls[1]))
  check('第三步关卡片', calls[2] && calls[2][0] === 'discard', JSON.stringify(calls[2]))
  check('发出去的是结果，不是原文',
    calls[0] && calls[0][1] === store.state.result.trim(), JSON.stringify(calls[0] && calls[0][1]).slice(0, 60))

  // 生成中不许发
  {
    const c2 = []
    const s2 = {
      state: { phase: 'running', result: 'x' },
      inputActions: { setDraft(t) { c2.push('setDraft') }, submit() { c2.push('submit') } },
    }
    const f2 = new Function('previewStore', 'discardPreview',
      'return (async () => { ' + fnText + '\n return sendToChat })()')
    const send2 = await f2(s2, () => c2.push('discard'))
    const r2 = await send2()
    check('生成中不许发', r2 === false && c2.length === 0, 'r=' + r2 + ' calls=' + JSON.stringify(c2))
  }

  // 空结果不许发
  {
    const c3 = []
    const s3 = {
      state: { phase: 'ready', result: '   ' },
      inputActions: { setDraft() { c3.push('setDraft') }, submit() { c3.push('submit') } },
    }
    const f3 = new Function('previewStore', 'discardPreview',
      'return (async () => { ' + fnText + '\n return sendToChat })()')
    const send3 = await f3(s3, () => c3.push('discard'))
    const r3 = await send3()
    check('空结果不许发', r3 === false && c3.length === 0, 'r=' + r3 + ' calls=' + JSON.stringify(c3))
  }

  // 宿主没提供 submit 时不许发（老版本宿主）
  {
    const c4 = []
    const s4 = {
      state: { phase: 'ready', result: 'x' },
      inputActions: { setDraft() { c4.push('setDraft') } },
    }
    const f4 = new Function('previewStore', 'discardPreview',
      'return (async () => { ' + fnText + '\n return sendToChat })()')
    const send4 = await f4(s4, () => c4.push('discard'))
    const r4 = await send4()
    check('宿主没有 submit 时不发', r4 === false && c4.length === 0, 'r=' + r4 + ' calls=' + JSON.stringify(c4))
  }

  console.log('')
  if (failures > 0) {
    console.error('SEND BEHAVIOR TEST FAILED（' + failures + ' 项）')
    process.exitCode = 1
  } else {
    console.log('SEND BEHAVIOR TEST PASSED')
  }
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
