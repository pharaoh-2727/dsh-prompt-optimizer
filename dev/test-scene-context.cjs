/**
 * test-scene-context.cjs —— 「DSH 场景约定」必须跟着真实会话上下文走，不能写死。
 *
 * 背景：插件和上游 dsh-prompt-enhancer 的唯一差异就是那五条场景约定。
 * 但早先它是一段常量：第 1 条说「相对路径相对工作区根目录解析」，代码却从不读工作区；
 * 第 5 条写死「本机是 Windows，终端是 PowerShell」，换台 Linux 也一样说。
 *
 * 这条测试钉住三件事：
 *   1. 拿得到会话工作区时，系统提示里必须出现**这个**路径；
 *   2. 无论拿得到拿不到，系统提示里都不能残留 【环境参数】 这类给改提示词的人看的占位符；
 *   3. 环境那句要跟着 process.platform 走。
 *
 * 三档都跑 —— 场景约定是三档共用的，只要有一档拼错就会漏。
 */
const { pathToFileURL } = require('node:url')
const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const { stubModel } = require('./stub-model.cjs')

const PLUGIN = process.env.DSHO_PLUGIN || join(__dirname, '..', 'index.js')
const TMP = process.env.DSHO_TMP || join(os.tmpdir(), 'dsho-scene-home')

const PLACEHOLDER = '【环境参数'

let loadCounter = 0

/** 用一份指定档位的设置加载一份全新的插件实例（模块顶层会读设置）。 */
async function loadPlugin(style) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(join(TMP, 'prompt-optimizer'), { recursive: true })
  stubModel(join(TMP, 'profile'))
  writeFileSync(
    join(TMP, 'prompt-optimizer', 'settings.json'),
    JSON.stringify({
      modelMode: 'auto',
      provider: '',
      model: '',
      style,
      customPrompt: '',
      freeChannelAsked: true,
    }, null, 2),
    'utf8',
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = TMP
  try {
    loadCounter += 1
    return await import(pathToFileURL(PLUGIN).href + '?v=' + loadCounter)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/**
 * 假 ctx。sessions.binding(sessionId) 按需返回带 cwd 的会话，
 * 模拟宿主在真实环境里能提供的那一份信息。
 */
function makeCtx(sessionCwd) {
  const calls = []
  const handlers = {}
  const ctx = {
    calls,
    on() { return () => {} },
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
      stream: (options) => {
        calls.push({ system: options.system })
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '改写后的提示词正文' }
        })()
      },
    },
    get: () => undefined,
    sessions: sessionCwd === undefined
      ? undefined
      : {
        binding: (sessionId) => ({
          session: { id: sessionId, header: { cwd: sessionCwd } },
        }),
      },
    agents: undefined,
    inject() {},
    provide() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  }
  return { ctx, handlers, calls }
}

function makeReq(payload) {
  return {
    method: 'POST',
    url: '/dsh-prompt-optimizer/optimize',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload), 'utf8')
    },
  }
}

async function optimize(handlers, payload) {
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handlers['/dsh-prompt-optimizer/optimize'](makeReq(payload), res)
  return { code: res.code, body: JSON.parse(res.body) }
}

const TEXT = '帮我看看这个插件的日志功能还缺什么'

function expectedEnvironment() {
  if (process.platform === 'win32') return { name: 'Windows', shell: 'PowerShell' }
  if (process.platform === 'darwin') return { name: 'macOS', shell: 'bash' }
  return { name: 'Linux', shell: 'bash' }
}

async function runFor(style) {
  const mod = await loadPlugin(style)

  // ── 1. 有工作区：系统提示里要出现这个路径 ────────────────────────────
  const withCwd = makeCtx('C:\\work\\demo-project')
  mod.apply(withCwd.ctx)
  const ok = await optimize(withCwd.handlers, { text: TEXT, sessionId: 'scene-session-1' })
  if (ok.body.ok !== true) throw new Error('[' + style + '] optimize failed: ' + ok.body.error)
  const system = withCwd.calls[0].system
  if (!system.includes('C:\\work\\demo-project')) {
    throw new Error('[' + style + '] system prompt does not carry the session workspace')
  }
  console.log('  ' + style + ' · 有工作区  : ✓ 提示里带上了会话工作区')

  // ── 2. 任何情况下都不能残留占位符 ────────────────────────────────────
  if (system.includes(PLACEHOLDER)) {
    throw new Error('[' + style + '] placeholder leaked into system prompt: ' + PLACEHOLDER)
  }

  // ── 3. 环境那句跟着 process.platform 走 ─────────────────────────────
  const env = expectedEnvironment()
  if (!system.includes(env.name) || !system.includes(env.shell)) {
    throw new Error('[' + style + '] environment not rendered for ' + process.platform)
  }
  console.log('  ' + style + ' · 环境行    : ✓ ' + env.name + ' / ' + env.shell)

  // ── 4. 拿不到工作区时：不编造路径，也不报错，占位符同样不能漏 ─────────
  const noCwd = makeCtx(undefined)
  mod.apply(noCwd.ctx)
  const bare = await optimize(noCwd.handlers, { text: TEXT, sessionId: 'scene-session-2' })
  if (bare.body.ok !== true) throw new Error('[' + style + '] optimize without session failed: ' + bare.body.error)
  const bareSystem = noCwd.calls[0].system
  if (bareSystem.includes(PLACEHOLDER)) {
    throw new Error('[' + style + '] placeholder leaked without session')
  }
  if (bareSystem.includes('C:\\work\\demo-project')) {
    throw new Error('[' + style + '] leaked the previous session workspace')
  }
  if (!bareSystem.includes('DSH 场景约定')) {
    throw new Error('[' + style + '] scene block disappeared when session unknown')
  }
  console.log('  ' + style + ' · 无工作区  : ✓ 不编造路径，场景约定仍在')
}

async function main() {
  const mod0 = await loadPlugin('balanced')
  // 导出面自检：三档的静态提示词里不能残留占位符（设置页会直接显示这份文本）。
  for (const item of mod0.STYLE_ITEMS) {
    if (item.prompt.includes(PLACEHOLDER)) {
      throw new Error('style ' + item.id + ' prompt still shows the editing placeholder')
    }
  }
  console.log('静态提示词  : ✓ 三档都不含占位符')

  for (const style of ['brief', 'balanced', 'detailed']) {
    await runFor(style)
  }

  console.log('ALL SCENE CONTEXT TESTS PASSED')
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exitCode = 1
})
