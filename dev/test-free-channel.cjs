/**
 * test-free-channel.cjs —— 验证「免费通道密钥失效」的两条路径：
 *
 * 场景一（设了一把假密钥，端点返回 401）：
 *   1. 失败被归类成 'auth'，界面拿到的是一句人能看懂的话，而不是原始 JSON 报文；
 *   2. 判定为密钥无效后，不再反复去撞那个端点（第二次探测走缓存）；
 *   3. 用户手动点「重新测试」仍然会真去试一次（?force=1）；
 *   4. 优化请求不再白跑一趟免费通道，直接回退到对话模型。
 *
 * 场景二（没设密钥）：
 *   5. 探测直接回 'no-key'，根本不发请求；
 *   6. 优化照样成功，回退原因说清楚缺哪个环境变量。
 *
 * 源码里不内置任何凭据，所以场景一必须自己设一把假密钥 —— 否则走的就是场景二。
 * 用临时 DSH_HOME：插件在 import 时就会读 settings.json，
 * 真实目录里的设置不该被这个测试改动。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PLUGIN = process.env.DSHO_PLUGIN || path.join(__dirname, '..', 'index.js')

// 源码里没有内置密钥了：给一把假的，才能测「真去请求一次」那条分支。
process.env.DSH_FREE_CHANNEL_API_KEY = 'sk-test-dummy-key-not-real'

const { stubModel } = require('./stub-model.cjs')

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-free-'))
process.env.DSH_HOME = tmpHome

// 免费通道挂了要回退到「对话模型」—— 回退路径也得能解析出一个模型，
// 否则这里测的就变成「取不到可用模型」了。
stubModel(path.join(tmpHome, 'profile'))
fs.mkdirSync(path.join(tmpHome, 'prompt-optimizer'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'prompt-optimizer', 'settings.json'),
  JSON.stringify({ modelMode: 'free', provider: '', model: '', style: 'balanced', customPrompt: '', freeChannelAsked: true }),
  'utf8',
)

const realFetch = globalThis.fetch
let fetchCalls = 0
let nextStatus = 401

function stubFetch(status, body) {
  globalThis.fetch = async () => {
    fetchCalls += 1
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return body },
      async json() { return JSON.parse(body) },
    }
  }
}

function makeReq(method, url, bodyText) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() { yield Buffer.from(bodyText ?? '', 'utf8') },
  }
}

function makeRes() {
  return { writeHead(code) { this.code = code }, end(body) { this.body = body } }
}

async function main() {
  stubFetch(401, '{"error":{"code":"","message":"Invalid token","type":"new_api_error"}}')

  // 带版本号动态 import，确保拿到的是刚改过的模块。
  const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())

  const routes = {}
  const listeners = {}
  const ctx = {
    on(event, fn) { (listeners[event] ||= []).push(fn) },
    effect(fn) { return fn() },
    webServer: {
      register(route) { routes[route.path] = route.handler; return () => { delete routes[route.path] } },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: '对话模型改写出来的正文' }
      })(),
    },
    get: () => undefined,
    sessions: undefined,
    agents: undefined,
    // C17 之后 host 半区会挂可选入口（commands / tools / provide）；
    // 这两个用例只关心改写逻辑，给空桩即可。
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  mod.apply(ctx)

  const test = routes['/dsh-prompt-optimizer/free-channel/test']
  const optimize = routes['/dsh-prompt-optimizer/optimize']
  if (test === undefined || optimize === undefined) throw new Error('routes missing')

  // ── 1. 首次探测：真去请求一次，失败被归类为 auth ──────────────────────
  const res1 = makeRes()
  await test(makeReq('GET', '/dsh-prompt-optimizer/free-channel/test'), res1)
  const d1 = JSON.parse(res1.body)
  console.log('probe #1    :', JSON.stringify(d1))
  if (d1.ok !== false) throw new Error('probe should fail')
  if (d1.kind !== 'auth') throw new Error('expected kind=auth, got ' + d1.kind)
  if (d1.cached !== false) throw new Error('first probe must not be cached')
  if (typeof d1.error !== 'string' || d1.error.includes('Invalid token')) {
    throw new Error('error message should be human readable, got: ' + d1.error)
  }
  if (!d1.error.includes('DSH_FREE_CHANNEL_API_KEY')) throw new Error('auth message should point at the env var: ' + d1.error)
  if (fetchCalls !== 1) throw new Error('first probe should hit the endpoint exactly once, calls=' + fetchCalls)

  // ── 2. 再次探测：走缓存，不再撞端点 ───────────────────────────────────
  const res2 = makeRes()
  await test(makeReq('GET', '/dsh-prompt-optimizer/free-channel/test'), res2)
  const d2 = JSON.parse(res2.body)
  console.log('probe #2    :', JSON.stringify(d2))
  if (d2.cached !== true) throw new Error('second probe should be cached')
  if (fetchCalls !== 1) throw new Error('cached probe must not hit the endpoint, calls=' + fetchCalls)

  // ── 3. 手动重测：强制真去请求一次 ─────────────────────────────────────
  const res3 = makeRes()
  await test(makeReq('GET', '/dsh-prompt-optimizer/free-channel/test?force=1'), res3)
  const d3 = JSON.parse(res3.body)
  console.log('probe force :', JSON.stringify(d3))
  if (d3.cached !== false) throw new Error('forced probe must not be cached')
  if (fetchCalls !== 2) throw new Error('forced probe should hit the endpoint, calls=' + fetchCalls)

  // ── 4. 优化：不再白跑免费通道，直接回退到对话模型 ─────────────────────
  const res4 = makeRes()
  await optimize(
    makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: '帮我跑一下测试脚本', sessionId: 's1' })),
    res4,
  )
  const d4 = JSON.parse(res4.body)
  console.log('optimize    :', JSON.stringify({ ok: d4.ok, provider: d4.provider, model: d4.model, freeChannel: d4.freeChannel }))
  if (d4.ok !== true) throw new Error('optimize should fall back and succeed: ' + d4.error)
  if (d4.text !== '对话模型改写出来的正文') throw new Error('unexpected fallback text: ' + d4.text)
  if (fetchCalls !== 2) throw new Error('optimize must not retry the dead free channel, calls=' + fetchCalls)
  if (d4.freeChannel.used !== false) throw new Error('free channel should not be reported as used')
  if (typeof d4.freeChannel.error !== 'string' || !d4.freeChannel.error.includes('DSH_FREE_CHANNEL_API_KEY')) {
    throw new Error('fallback should explain why: ' + d4.freeChannel.error)
  }

  // ── 5. settings 路由带上免费通道状态 ────────────────────────────────
  const res5 = makeRes()
  await routes['/dsh-prompt-optimizer/settings'](
    { method: 'GET', url: '/dsh-prompt-optimizer/settings?sessionId=s1' },
    res5,
  )
  const d5 = JSON.parse(res5.body)
  console.log('freeChannel :', JSON.stringify(d5.freeChannel))
  // 源码不再内置密钥，这个字段恒为 false —— 它是给设置页旧回退路径留的形状。
  if (d5.freeChannel.usingBuiltinKey !== false) throw new Error('usingBuiltinKey should be false (no builtin key any more)')
  if (d5.freeChannel.status !== 'unavailable') throw new Error('status should be unavailable, got ' + d5.freeChannel.status)
  if (d5.freeChannel.kind !== 'auth') throw new Error('kind should be auth')
  if (typeof d5.freeChannel.message !== 'string') throw new Error('message missing')

  // ── 6. 分类：临时的错误不能把通道判死 ────────────────────────────────
  // 换一个新模块实例（独立状态），用 429 跑一遍。
  globalThis.fetch = async () => {
    fetchCalls += 1
    return {
      ok: false, status: 429, async text() { return '{"error":"rate limited"}' }, async json() { return {} },
    }
  }
  fetchCalls = 0
  const mod2 = await import(pathToFileURL(PLUGIN).href + '?v=' + (Date.now() + 1))
  const routes2 = {}
  mod2.apply({
    on() {}, effect(fn) { return fn() },
    webServer: { register(route) { routes2[route.path] = route.handler; return () => {} } },
    llm: { listProviders: () => [], listModels: async () => [], stream: () => (async function* () { yield { type: 'text', text: 'x' } })() },
    get: () => undefined,
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  })
  const res6 = makeRes()
  await routes2['/dsh-prompt-optimizer/free-channel/test'](makeReq('GET', '/dsh-prompt-optimizer/free-channel/test'), res6)
  const d6 = JSON.parse(res6.body)
  console.log('probe 429   :', JSON.stringify(d6))
  if (d6.kind !== 'rate') throw new Error('429 should be classified as rate, got ' + d6.kind)
  if (d6.cached !== false) throw new Error('429 must not be cached as unavailable')

  // 429 之后再探测一次：应当真的又去请求（临时的，值得重试）
  fetchCalls = 0
  const res7 = makeRes()
  await routes2['/dsh-prompt-optimizer/free-channel/test'](makeReq('GET', '/dsh-prompt-optimizer/free-channel/test'), res7)
  const d7 = JSON.parse(res7.body)
  if (d7.cached !== false) throw new Error('429 should not be cached; transient failures must stay retryable')
  if (fetchCalls !== 1) throw new Error('transient failure should be retried, calls=' + fetchCalls)
  console.log('transient   : 429 stays retryable ✓')

  // ── 7. 没配密钥：不发请求，直接说缺哪个环境变量 ──────────────────────
  // 源码不内置凭据，所以这是最默认的状态。换一个新模块实例，把环境变量摘掉。
  delete process.env.DSH_FREE_CHANNEL_API_KEY
  stubFetch(200, '{"choices":[{"message":{"content":"没关系，不该走到这里"}}]}')
  fetchCalls = 0
  const mod3 = await import(pathToFileURL(PLUGIN).href + '?v=' + (Date.now() + 2))
  const routes3 = {}
  mod3.apply({
    on() {}, effect(fn) { return fn() },
    webServer: { register(route) { routes3[route.path] = route.handler; return () => {} } },
    llm: {
      listProviders: () => [], listModels: async () => [],
      stream: () => (async function* () { yield { type: 'text-delta', index: 0, text: '对话模型改写出来的正文' } })(),
    },
    get: () => undefined,
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  })
  const res8 = makeRes()
  await routes3['/dsh-prompt-optimizer/free-channel/test'](makeReq('GET', '/dsh-prompt-optimizer/free-channel/test'), res8)
  const d8 = JSON.parse(res8.body)
  console.log('probe no-key:', JSON.stringify(d8))
  if (d8.kind !== 'no-key') throw new Error('missing key should be classified as no-key, got ' + d8.kind)
  if (!d8.error.includes('DSH_FREE_CHANNEL_API_KEY')) throw new Error('no-key message should name the env var: ' + d8.error)
  if (d8.canRetry !== true) throw new Error('no-key must stay retryable (user can set the key and retry)')
  if (fetchCalls !== 0) throw new Error('no-key probe must not hit the endpoint, calls=' + fetchCalls)

  const res9 = makeRes()
  await routes3['/dsh-prompt-optimizer/optimize'](
    makeReq('POST', '/dsh-prompt-optimizer/optimize', JSON.stringify({ text: '帮我跑一下测试脚本', sessionId: 's1' })),
    res9,
  )
  const d9 = JSON.parse(res9.body)
  console.log('opt no-key  :', JSON.stringify({ ok: d9.ok, provider: d9.provider, freeChannel: d9.freeChannel }))
  if (d9.ok !== true) throw new Error('optimize must still work without a free-channel key: ' + d9.error)
  if (d9.freeChannel.used !== false) throw new Error('free channel must not report as used')
  if (!String(d9.freeChannel.error).includes('DSH_FREE_CHANNEL_API_KEY')) {
    throw new Error('fallback should name the env var: ' + d9.freeChannel.error)
  }
  if (fetchCalls !== 0) throw new Error('no-key optimize must not hit the endpoint, calls=' + fetchCalls)
  console.log('no-key path : 不发请求、照常回退 ✓')

  globalThis.fetch = realFetch
  fs.rmSync(tmpHome, { recursive: true, force: true })

  console.log('\nFREE CHANNEL TEST PASSED')
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1) })
