/**
 * test-dsh-compat.cjs —— 适配 dsh 0.2.2-rc.1 的那几处改动不许退回去。
 *
 * 背景（0.2.2-rc.1 的宿主契约）：
 *   1. `agent/request` 已标记 deprecated，且返回值被 prepareRequest 硬校验
 *      （provider/model 与本次 step 的 selection 不一致就抛错）。记模型的
 *      入口改用未弃用的 `agent/pre-step`。
 *   2. 宿主的 sessions 服务**没有** binding()（那只存在于浏览器侧的
 *      dsh-api-session-controller）。取会话改用 agents.get(id) / sessions.get(id)。
 *
 * 这三条任何一条退回去，在 0.2.2 上都是静默失效：不报错、结果不对。
 */
const { pathToFileURL } = require('node:url')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || path.join(__dirname, '..', 'index.js')
const SOURCE = readFileSync(PLUGIN, 'utf8')

const TMP = mkdtempSync(path.join(os.tmpdir(), 'dsho-compat-'))
process.env.DSH_HOME = TMP
stubModel(path.join(TMP, 'profile'))
mkdirSync(path.join(TMP, 'prompt-optimizer'), { recursive: true })
writeFileSync(
  path.join(TMP, 'prompt-optimizer', 'settings.json'),
  JSON.stringify({ modelMode: 'auto', provider: '', model: '', style: 'balanced', customPrompt: '', freeChannelAsked: true }),
  'utf8',
)

let loadCounter = 0

function makeCtx(options = {}) {
  const listeners = {}
  const handlers = {}
  const systems = []
  const ctx = {
    on(event, fn) {
      ;(listeners[event] ||= []).push(fn)
      return () => {}
    },
    effect(fn) { return fn() },
    webServer: {
      register(route) {
        handlers[route.path] = route.handler
        return () => {}
      },
    },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      stream: (call) => {
        systems.push(call.system)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: options.reply ?? '改写后的提示词正文，覆盖目标、步骤、产出与验收口径。' }
        })()
      },
    },
    get: () => undefined,
    agents: options.agents,
    sessions: options.sessions,
    workingDirectory: options.workingDirectory,
    inject(list, callback) {
      for (const name of (Array.isArray(list) ? list : Object.keys(list))) {
        if (ctx[name] === undefined) throw new Error('missing service ' + name)
      }
      return callback(ctx)
    },
    commands: { register() { return () => {} } },
    tools: { register() { return () => {} } },
    provide() { return async () => {} },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, listeners, handlers, systems }
}

function getJson(handler, url) {
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  return handler({ method: 'GET', url }, res).then(() => ({ code: res.code, body: JSON.parse(res.body) }))
}

function postJson(handler, url, payload) {
  const req = {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(payload), 'utf8') },
  }
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  return handler(req, res).then(() => ({ code: res.code, body: JSON.parse(res.body) }))
}

async function load() {
  loadCounter += 1
  return import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
}

async function main() {
  // ── 1. 源码层面：不该再出现已弃用/不存在的 API ──────────────────────────
  if (/ctx\.sessions\?\.binding|ctx\.sessions\.binding/u.test(SOURCE)) {
    throw new Error('index.js still calls sessions.binding() — the Host sessions service has no such method')
  }
  if (/ctx\.on\(\s*['"]agent\/request['"]/u.test(SOURCE)) {
    throw new Error("index.js still registers an agent/request listener — that event is deprecated in dsh 0.2.x")
  }
  console.log('源码        : ✓ 没有 sessions.binding()，也没有 agent/request 监听')

  // ── 2. agent/pre-step 会记下本次 step 的 modelSelection ────────────────
  const a = makeCtx()
  const mod = await load()
  mod.apply(a.ctx)
  const preStep = a.listeners['agent/pre-step']?.[0]
  if (typeof preStep !== 'function') throw new Error('plugin did not listen on agent/pre-step')
  let nextCalled = false
  // 宿主侧 agent/session 的 id 一律是 `session-<uuid>`；浏览器侧 slot 给的
  // props.sessionId 是裸 uuid。这里故意用两边不同的写法，逼出键对齐问题。
  const decision = await preStep(
    { agent: { id: 'session-compat-s1', session: { id: 'session-compat-s1' } }, modelSelection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' }, turn: 1, step: 1 },
    async () => { nextCalled = true; return { kind: 'enter', messages: [] } },
  )
  if (!nextCalled) throw new Error('agent/pre-step listener swallowed next()')
  if (decision?.kind !== 'enter') throw new Error('agent/pre-step listener did not return the decision unchanged')
  const settings = await getJson(a.handlers['/dsh-prompt-optimizer/settings'], '/dsh-prompt-optimizer/settings?sessionId=compat-s1')
  if (settings.body.resolved?.source !== 'session') {
    throw new Error('pre-step did not record the route: ' + JSON.stringify(settings.body.resolved))
  }
  if (settings.body.resolved.provider !== 'workbuddy' || settings.body.resolved.model !== 'deepseek-v4.1-flash') {
    throw new Error('recorded route is wrong: ' + JSON.stringify(settings.body.resolved))
  }
  if (settings.body.sessionKnown !== true) throw new Error('sessionKnown should be true after pre-step')
  // 同一个会话，换成宿主那种带前缀的写法也必须命中。
  const prefixed = await getJson(a.handlers['/dsh-prompt-optimizer/settings'], '/dsh-prompt-optimizer/settings?sessionId=session-compat-s1')
  if (prefixed.body.resolved?.source !== 'session') {
    throw new Error('prefixed session id did not resolve: ' + JSON.stringify(prefixed.body.resolved))
  }
  // 别的会话不许蹭到这条路由。
  const other = await getJson(a.handlers['/dsh-prompt-optimizer/settings'], '/dsh-prompt-optimizer/settings?sessionId=compat-other')
  if (other.body.sessionKnown !== false) throw new Error('an unrelated session id was reported as known')
  console.log('agent/pre-step: ✓ 记下 provider/model，裸 uuid 与 session- 前缀两种写法都认')

  // ── 3. 取会话：agents.get 优先，缺了退到 sessions.get ───────────────────
  const viaAgents = makeCtx({
    agents: { get: (id) => ({ id, session: { id, header: { cwd: 'C:\\work\\from-agents' } } }) },
  })
  mod.apply(viaAgents.ctx)
  const r1 = await postJson(viaAgents.handlers['/dsh-prompt-optimizer/optimize'], '/dsh-prompt-optimizer/optimize', { text: '帮我看看这个插件的日志功能还缺什么', sessionId: 'compat-s2' })
  if (r1.body.ok !== true) throw new Error('optimize via agents.get failed: ' + r1.body.error)
  if (!viaAgents.systems[0].includes('C:\\work\\from-agents')) {
    throw new Error('workspace from agents.get(sessionId).session.header.cwd not used')
  }
  console.log('agents.get  : ✓ 会话工作区取自 agent.session.header.cwd')

  const viaSessions = makeCtx({
    agents: undefined,
    sessions: { get: (id) => ({ id, header: { cwd: 'C:\\work\\from-sessions' } }) },
  })
  mod.apply(viaSessions.ctx)
  const r2 = await postJson(viaSessions.handlers['/dsh-prompt-optimizer/optimize'], '/dsh-prompt-optimizer/optimize', { text: '帮我看看这个插件的日志功能还缺什么', sessionId: 'compat-s3' })
  if (r2.body.ok !== true) throw new Error('optimize via sessions.get failed: ' + r2.body.error)
  if (!viaSessions.systems[0].includes('C:\\work\\from-sessions')) {
    throw new Error('workspace from sessions.get(sessionId).header.cwd not used')
  }
  console.log('sessions.get: ✓ agents.get 缺失时退到 sessions.get')

  // ── 4. 宿主两个 get 都缺失时：不编造路径、也不抛 ────────────────────────
  const none = makeCtx({ agents: undefined, sessions: undefined })
  mod.apply(none.ctx)
  const r3 = await postJson(none.handlers['/dsh-prompt-optimizer/optimize'], '/dsh-prompt-optimizer/optimize', { text: '帮我看看这个插件的日志功能还缺什么', sessionId: 'compat-s4' })
  if (r3.body.ok !== true) throw new Error('optimize without any session source failed: ' + r3.body.error)
  if (none.systems[0].includes('from-agents') || none.systems[0].includes('from-sessions')) {
    throw new Error('leaked a workspace from another session')
  }
  console.log('无来源      : ✓ 不编造路径，仍能改写')

  console.log('ALL DSH COMPAT TESTS PASSED')
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exitCode = 1
})
