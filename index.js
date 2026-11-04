/**
 * dsh-prompt-optimizer —— Host 半区（DSH 专用版）
 *
 * 两部分：
 *   1. `/optimize`：接收输入框草稿，调用模型改写成更好的提示词，返回文本。
 *   2. `/settings`：读写本插件的设置（用哪个模型、用哪档提示词）。
 *
 * 「优化」这件事有六个入口，全部收敛到同一个 optimizeText()：
 *   客户端（走 HTTP 路由）：输入框按钮 · 会话头按钮 · 快捷键 Alt+O
 *   宿主侧：`/optimize` 斜杠命令 · `optimize_prompt` 工具 · `promptOptimizer` 服务
 *
 * 为什么入口要分这么多种：按钮只活在浏览器里 —— 脚本调不到它，别的插件
 * 调不到它，模型自己也调不到它。命令给人和脚本用，工具给模型用，
 * 服务给插件用。三者共用同一条实现，所以从哪个入口进来结果都一样。
 *
 * 模型选择有三档：
 *   - auto（默认）：跟随当前对话实际使用的模型，由 `agent/request` 事件记录；
 *   - manual：用户指定的 provider/model；
 *   - free：优先走免费通道（需自备 DSH_FREE_CHANNEL_API_KEY），不可用时静默回退到当前对话的模型。
 *
 * 与通用改写器的区别：规则集里带 DSH 场景约定（@ 文件引用、工作区、
 * 可执行动作、验收口径、Windows/PowerShell 环境），改写出来的是
 * 三档力度是递进的，靠两件事区分开：
 *   - 每一档都写明自己的长度上限、允许补充的范围、明确禁止的内容；
 *   - 引擎用同一套边界复核模型的实际输出，不合边界就带着修正指令重试一次。
 * 这样「精简 → 均衡 → 详细」在长度和内容密度上都能一眼看出来。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-prompt-optimizer'

/** 需要的服务：LLM 调用 + HTTP 路由。 */
export const inject = ['llm', 'webServer']

/**
 * 注册一条 HTTP 路由。
 *
 * 宿主把路由表当作文档级契约：同一路径只能有一条，重复注册会抛
 * `webserver: duplicate exact route`。热替换插件时，旧实例可能已经把同名
 * 路由留在表里（老版本没保存撤销函数），新实例就会注册失败、被标成 stopped，
 * 于是「代码改了但永远不生效」。
 *
 * 这里只回收本插件自己的路径前缀（/dsh-prompt-optimizer/），不会碰别人的路由；
 * 正常启停时路由由 ctx.effect 的撤销函数释放，不走这段回收逻辑。
 */
function registerRoute(ctx, route) {
  try {
    const table = route.kind === 'exact' ? ctx.webServer.exact : ctx.webServer.prefixes
    if (table && typeof table.has === 'function' && typeof table.delete === 'function' && table.has(route.path)) {
      table.delete(route.path)
    }
  } catch {
    /* 宿主不暴露路由表时直接注册，让宿主自己报错 */
  }
  return ctx.webServer.register(route)
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')

/** 设置文件：跟插件放在一起，卸载时一并清理。 */
const SETTINGS_DIR = join(DSH_HOME, 'prompt-optimizer')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')

/** 待优化文本的长度上限，防止把整篇文档塞进一次改写请求。 */
const MAX_INPUT_CHARS = 20000

/**
 * 短到这个程度就没有可补的信息，原样返回。
 *
 * 见 optimizeText 里的说明：1 个字的「改」被补成 117 字套话，比不改更糟。
 */
const MIN_MEANINGFUL_CHARS = 4

/**
 * 一次优化的时间预算（毫秒）。超了就不再走补救路径。
 *
 * 线上实测：模型慢的时候首字要 50 秒，一次优化 90 秒以上；而补救路径
 * （过度扩写拉回、档位收敛/补齐）会再串一次完整模型调用，最坏串三次。
 * 用户等两分钟，看到的是「优化中」一直转。
 *
 * 补救是「更好」，不是「能看」。为它多等一分钟不值 —— 超预算就把手上的
 * 结果交出去，并在结果里标出来，别假装补救过了。
 */
const OPTIMIZE_BUDGET_MS = (() => {
  // 测试要把它调到毫秒级才测得出「超预算」，所以认一个环境变量。
  const raw = Number(process.env.DSHO_OPTIMIZE_BUDGET_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 60000
})()

/**
 * 进行中的优化任务：requestId → AbortController。
 *
 * 取消不能只靠浏览器断开连接：模型调用已经在宿主进程里跑着了，
 * 只有拿到同一个 AbortController 才能真的把它停下来。
 */
const activeJobs = new Map()

/**
 * 取消用的错误标记。
 *
 * 「用户点了取消」不是失败：调用方要能把它和真失败分开，
 * 否则界面会弹一条红色报错，说的却是一件用户自己要求的事。
 */
function abortedError() {
  const error = new Error('已取消')
  error.aborted = true
  return error
}

/**
 * DSH 场景约定：三档都带。
 *
 * 这一段是「dsh 专用版」和通用改写器的分水岭：DeepSeek Harness 不是聊天机器人，
 * 它是一个带着 read / write / edit / glob / grep / bash / web_search / subagent
 * 这些工具、能读写工作区文件的编码代理。提示词里没写清楚「改哪个文件、
 * 怎么验证、什么不能动」，代理就只能猜。所以改写时把 DSH 的约定补进去。
 */
const SCENE_TEMPLATE = [
  'DSH 场景约定（这段文字会发给 DeepSeek Harness —— 一个能读写文件、跑命令的编码代理）：',
  '本节是背景说明，帮你看懂原文里的路径、命令和交付物指什么。',
  '（能不能补新内容，由档位规则和公共规则决定；本节只管「怎么读」。）',
  '1. 工作区与文件引用：DSH 的工作目录就是当前会话的工作区。',
  '   当前会话的工作区是 {{workspace}}；',
  '   文件用 @ 开头的 token 引用，例如 @src/app.ts；相对路径相对工作区根目录解析；',
  '   路径含空格写成 @"path with space"。原文提到具体文件时，按这个格式把引用写清楚。',
  '2. 动作要可执行：DSH 有 read、write、edit、glob、grep、bash/pwsh、web_search、',
  '   web_fetch、subagent 等工具。原文要动手时，保留「先读再改」「跑命令验证」',
  '   这类能落地的说法，把「请思考一下」改成明确的动作。',
  '3. 产出形态要具体：原文说明产出时，写清是改哪个文件、生成什么脚本、给出什么结论；',
  '   原文要求交付文件时，写明位置、文件名、格式。',
  '4. 验收口径要可判定：原文含验收信息时，写成可判定的说法',
  '   （例如「node scripts/test.mjs 通过」「只改动 X 模块」），不写「写得专业」这类空话。',
  '5. 环境与边界要交代：原文涉及安装、构建、部署时，写明运行环境与工具链',
  '   （{{environment}}），',
  '   以及原文声明的不能碰的东西。',
].join('\n')

/**
 * 本机环境那一句。**读真实平台**，不写死。
 *
 * 早先这里是「【环境参数：本机是 Windows，终端是 PowerShell —— 按实际机器修改此行】」，
 * 本意是给改提示词的人看的注解，但它会被原样发给模型：换台 Linux 机器，
 * 插件照样告诉模型「本机是 Windows，终端是 PowerShell」，改写出来的命令全是错的。
 */
function describeEnvironment() {
  if (process.platform === 'win32') return '本机是 Windows，终端是 PowerShell'
  if (process.platform === 'darwin') return '本机是 macOS，终端是 bash'
  return '本机是 Linux，终端是 bash'
}

/**
 * 把场景约定渲染成要发给模型的那段文字。
 *
 * 模板里用 {{name}} 占位，值来自这次调用拿得到的真实上下文：
 *   workspace   —— 这个会话的工作区绝对路径；拿不到就整行去掉，
 *                  **不编造、也不留占位符**（宁可不说，也不能说错）。
 *   environment —— 由 describeEnvironment() 按真实平台生成，永远有值。
 *
 * @param {{workspace?: string, environment?: string}} [context]
 */
function dshScene(context) {
  const values = {
    workspace: typeof context?.workspace === 'string' ? context.workspace.trim() : '',
    environment: typeof context?.environment === 'string' && context.environment.length > 0
      ? context.environment
      : describeEnvironment(),
  }
  return SCENE_TEMPLATE
    .split('\n')
    // 值拿不到的行整行删掉：留下「当前会话的工作区是 ；」比不写更糟。
    .filter((line) => {
      const found = /\{\{(\w+)\}\}/u.exec(line)
      if (found === null) return true
      return (values[found[1]] ?? '').length > 0
    })
    .map((line) => line.replace(/\{\{(\w+)\}\}/gu, (_all, name) => values[name] ?? ''))
    .join('\n')
}

/** 静态渲染用的上下文：设置页要显示「这一档会发出去什么」，那里没有会话可问。 */
const STATIC_SCENE_CONTEXT = Object.freeze({ workspace: '', environment: '' })

/**
 * 拼出一档完整的系统提示词：档位规则 + 场景约定 + 公共规则。
 *
 * 顺序不能换：公共规则的优先级最高，放最后读；场景约定夹在中间，
 * 因为它是「解释原文里的路径和命令指什么」，不改变改写的力度。
 */
function renderPrompt(item, context) {
  return [item.tierPrompt, '', dshScene(context ?? STATIC_SCENE_CONTEXT), '', COMMON].join('\n')
}

/**
 * 三档预设提示词。
 *
 * 三档是递进的阶梯，不是「差不多的三个说法」：
 *   brief   —— 只把话说通：不加任何原文没有的内容，长度贴着原文；
 *   balanced—— 把话说透到能一次做对：必须写出产出与验收口径（默认）；
 *   detailed—— 把任务要素补全并去重：目标/输入/步骤/产出/验收，段数与长度都封顶。
 *
 * 每档都受同一条前置判断约束：
 * 先看输入是「确认/闲聊/简单提问」还是「任务要求」，只有后者才值得加码。
 * 但无论哪一类，输出都只能是「改写后的提示词」，绝不能是替用户回答问题。
 *
 * 公共约束单独写在 COMMON 里，避免三段重复。
 *
 * 为什么这条前置判断是必须的：早期版本让 detailed 无条件"补背景、拆步骤、
 * 给验收标准"，结果用户输入「ok，完成的很好」这样一句确认，
 * 被扩写成带目标/背景/步骤/约束/验收标准的整篇文档 —— 完全是噪声。
 */
const COMMON = [
  '公共规则（三档都适用，优先级高于档位规则和场景约定）：',
  '1. 输出是纯文本，直接放进 DSH 对话输入框 —— 那里按原样显示，不渲染 Markdown。',
  '   所以要分层时这样写：小标题用「目标：」「约束：」这样的冒号形式，',
  '   条目用「1. 2. 3.」或「一、二、三」，强调用词本身，需要分行就用空行。',
  '   原文里本来就有的代码片段、命令、路径、报错栈，照原样保留。',
  '2. 无论输入是什么性质，输出只能是「改写后的提示词」，绝不能是答案。',
  '   任何时候都不要替 DSH 回答话里的问题，不要给结论、建议或解释；',
  '   原文自带的例子原样保留，但不要新增原文没有的例子。',
  '   先判断输入性质，再决定改写幅度：',
  '   a) 确认 / 道谢 / 闲聊 / 简单反馈（「好的」「完成得很好」「谢谢」「就这样」）',
  '      → 一字不改地保留原句，只调整语气词和标点，输出一句话；',
  '        原句没说要做什么，就不写要做什么。',
  '        「好的，谢谢」这类已经通顺的，**连标点都不要加** —— 加个句号也是改动，',
  '        用户看不出区别，只会觉得白等了几秒。',
  '   b) 简单提问 → 改写成一句更清楚的提问，问什么就还问什么，不替它回答。',
  '      例：「同一个对话是不是不要经常换模型，这样也能省一点」',
  '      →「同一个对话里固定用同一个模型是不是更省？」',
  '   c) 任务要求（要 DSH 做某件事、产出某个东西）→ 按本档规则改写。',
  '      短任务（「别用 any」「加个超时」）也要改：把没说清的对象补上 ——',
  '      在哪儿别用 any、给谁加超时。原文已经写得够清楚、真的没有可补的，',
  '      可以原样返回，但不要为了凑字数硬加套话。',
  '   判定标准：只要需要 DSH 读写文件、跑命令或查看工作区才能推进，一律算 c)；',
  '   只有不需要接触工作区的纯知识问答才算 b)。',
  '   混合输入（既有提问又有任务）按 c) 处理，改写时保留全部真实意图。',
  '   边界例子：「怎么配置 profile？」是 b)（只问做法，没让 DSH 动手）；',
  '   「看看我的 profile 配得对不对」是 c)（要看工作区）。',
  '   带路径或文件名的**提问**仍是 b)：「src/app.ts 为什么这么慢？」',
  '   「package.json 里的 scripts 是干嘛的？」—— 是在问，不是让 DSH 动手，',
  '   照原样问清楚，不要给它补产出、步骤、验收。',
  '   拿不准时按 c)。',
  '3. 改写目标是让 DSH 更容易理解，不是让文字变长变正式。',
  '   a) 类输出一句；b) 类一到两句；c) 类也尽量短，够用即可。',
  '4. 结构要跟着内容走：原文有几分信息就写几分。',
  '   某一项在原文里没有依据时，省掉那一项，不要用「（待补充）」这类占位符撑格式。',
  '5. 只输出改写后的提示词正文本身。第一句就是改写结果，最后一句就是结尾；',
  '   「以下是优化后的提示词」这类引导语和包裹用的引号都省掉。',
  '6. 保持用户原本的语言：中文输入输出中文，英文输入输出英文。',
  '   英文输入同样要按档位规则改写 —— 该补的产出、验收、步骤一样要补，',
  '   只是换成英文写。不要只把首字母大写、或者加一个 "Goal:" 前缀就算改完；',
  '   那样等于一个字都没动。英文的结构词用 Goal / Steps / Output / Acceptance。',
  '7. 约束冲突时的取舍顺序：不新增信息 > 说清楚 > 长度上限。',
  '   为守住前两条允许适度超出长度上限，但不得为守长度而删掉原文信息。',
].join('\n')

/**
 * 三档的长度边界。
 *
 * 这是「档位差异可感知」的量化依据：提示词里写的上限，和引擎复核时用的
 * 上限，是同一套数字（见 lengthLimitFor），不会出现「提示词说 1.6 倍、
 * 引擎按 2 倍判」这种自相矛盾。
 *
 * 公式（与 prompts/ 里各档的「长度上限」一句完全一致）：
 *   上限 = max(原文长度 × ratioMax, 原文长度 + plusChars)
 *
 * ratioMax —— 原文足够长时按倍数封顶。
 * plusChars —— 原文很短时给一个固定的加字额度：原文只有几个字时，
 *              「1.15 倍」几乎等于一个字都不许加，模型连把话说明白都做不到。
 *              取两者里更大的那个，所以短输入天然有喘息空间，长输入自动按倍数收紧。
 * absMax   —— 兜底天花板，防止超长输入把输出拖到离谱的长度。
 */
const STYLE_BANDS = {
  brief: { ratioMax: 1.15, plusChars: 10, absMax: 1500 },
  // plusChars 从 60 提到 80：短问题（十几字）按 1.6 倍只能加几个字，
  // 写不下「产出 + 验收」这两句必须补的话。dev/test-band-ceiling.cjs 钉住
  // 这里与三档提示词里写的数字一致。
  balanced: { ratioMax: 1.6, plusChars: 80, absMax: 2500 },
  detailed: { ratioMax: 2.2, plusChars: 150, absMax: 4000 },
}

const STYLE_ITEMS = [
  {
    id: 'brief',
    label: '精简',
    summary: '只把话说通：不加任何原文没有的内容，长度贴着原文',
    band: '≤ max(1.15 × 原文长度, 原文长度 + 10 字)，封顶 1500 字',
    bandBadge: '≤1.15× / +10 字 / 顶 1500',
    scope: '只改语病、指代和含糊量词，不补任何新信息',
    forbid: '不新增要求、范围、产出、验收标准和背景',
    tierPrompt: [
      '你是一个给 DeepSeek Harness（DSH）写提示词的人。用户会给你一段他们准备发给 DSH 的文字。',
      '你只负责改写这段文字，不负责回答它：输出永远是改写后的提示词，不是答案。',
      '这一档叫「精简」：目标是让原文能被看懂，并且读起来像人话。',
      '这一档只做最小必要修改 —— 不补充任何原文没有的信息。',
      '',
      '先按公共规则第 2 条判断输入性质：a) 类和 b) 类只做语气与措辞的理顺，',
      '不套用下面的四类改动，也不使用场景约定里的写法要求。',
      '只有 c) 类（任务要求）才适用下面的规则。',
      '',
      '动手范围就这四处，别处一个字都不动：',
      '1. 错别字、语病、断句；',
      '2. 含糊的代词；',
      '3. 上下文支持时，把「一些」这类模糊数量写成具体数字；',
      '4. 缺失的主语或动作对象。',
      '段落数保持不变，原句顺序保持不变。',
      '',
      '示例（本档最容易做错的两件事都在这里）：',
      '原文：把这些文件里的 console.log 删掉',
      '错误输出：目标：删掉所有 console.log。步骤：1. 读文件；2. 删除。产出：改动的文件。',
      '（错在补了产出和步骤 —— 本档不补任何原文没有的内容。）',
      '正确输出：把这些文件里的 console.log 都删掉。',
      '',
      '长度上限（按字符数计，不含首尾空白）：取下面三者里最小的那个 ——',
      '原文的 1.15 倍；原文 + 10 字（原文不足 60 字时用它）；封顶 1500 字。',
      '也就是说：改完比原文更清楚，但看不出是被重写过的。',
      '原文字数超过约 1300 时，封顶先到，倍数就不再作数。',
    ].join('\n'),
  },
  {
    id: 'balanced',
    label: '均衡',
    summary: '把话说透到能一次做对：写出产出与验收口径',
    band: '≤ max(1.6 × 原文长度, 原文长度 + 80 字)，封顶 2500 字',
    bandBadge: '≤1.6× / +80 字 / 顶 2500',
    scope: '补齐含糊处，并写明交付什么、怎样算完成',
    forbid: '不新增原文没有的要求、范围、背景、依赖和数字',
    tierPrompt: [
      '你是一个给 DeepSeek Harness（DSH）写提示词的人。用户会给你一段他们准备发给 DSH 的文字。',
      '你只负责改写这段文字，不负责回答它：输出永远是改写后的提示词，不是答案。',
      '这一档叫「均衡」：目标是让 DSH 一次就能做对 —— 既看得懂原意，也知道要交付什么、怎样算完成。',
      '',
      '先按公共规则第 2 条判断输入性质：a) 类和 b) 类按公共规则改写，',
      '不套用下面的做法。只有 c) 类（任务要求）才适用下面的规则。',
      '',
      '做法（对 c) 类输入）：',
      '1. 补齐含糊之处：把指代写清楚，把模糊的范围写成具体范围；',
      '2. 明确期望产出：要做的是改哪个文件、跑哪条命令、给出哪种结论或清单；',
      '3. 明确验收口径：怎样算做完了、做对了（例如「列出改动的文件」「贴出报错原文」这种一句可判定的话）；',
      '4. 把并列、有先后关系的步骤整理成清晰的顺序或分点；',
      '5. 去掉与目标无关的枝节表述；',
      '6. 原文已经足够清晰就只做最小改动。',
      '',
      '短任务的处理：原文只有一句话时，补的是「对象」而不是「结构」——',
      '「别用 any」→「把代码里的 any 都换成具体类型」；',
      '「加个超时」→「给请求加上超时，超时后报错退出」。',
      '不要给一句话的任务硬套「目标 / 步骤 / 产出 / 验收」四段式，那会把',
      '一句清楚的指令变成一份空洞的模板。',
      '',
      '增补的边界：只把原文已经有意的东西写具体。',
      '原文提到要交付，就写清交付什么；原文没说交付，就一个字的产出都不加。',
      '判断方法：输出里每一条要求，都能在原文里找到对应的词或半句话。',
      '篇幅上仍是一段话或几句话，不扩成文档；「要专业」「要详细」这类词换成可执行的动作。',
      '',
      '示例（同一句话在两档下的差别）：',
      '原文：怎么配置 profile？',
      '错误输出：目标：给出配置 profile 的做法。步骤：1. 找配置文件；2. 写配置。产出：说明文档。',
      '（错在把提问当任务，还编了步骤和产出。）',
      '正确输出：profile 怎么配置？需要改哪个文件、填哪些项，给出可直接照着做的步骤。',
      '',
      '长度上限（按字符数计，不含首尾空白）：取下面三者里最小的那个 ——',
      '原文的 1.6 倍；原文 + 80 字（原文不足 100 字时用它）；封顶 2500 字。',
      '原文字数超过约 1600 时，封顶先到，倍数就不再作数。',
    ].join('\n'),
  },
  {
    id: 'detailed',
    label: '详细',
    summary: '把任务要素补全并去重：目标/输入/步骤/产出/验收',
    band: '≤ max(2.2 × 原文长度, 原文长度 + 150 字)，封顶 4000 字',
    bandBadge: '≤2.2× / +150 字 / 顶 4000',
    scope: '补齐目标、输入上下文、步骤、产出格式、验收标准，并去重',
    forbid: '同一件事不写两遍，不补造依赖、数量和背景',
    tierPrompt: [
      '你是一个给 DeepSeek Harness（DSH）写提示词的人。用户会给你一段他们准备发给 DSH 的文字。',
      '你只负责改写这段文字，不负责回答它：输出永远是改写后的提示词，不是答案。',
      '这一档叫「详细」：目标是让一份任务说明完整到 DSH 可以直接执行、可以自检 —— 但每一句都得有用。',
      '',
      '先按公共规则第 2 条判断输入性质。把 a) 类确认改写成长文、',
      '或者替 b) 类提问给出回答，是本档最典型的错误，必须避免；',
      'a) 类和 b) 类只按公共规则改写，不展开成完整要素。',
      '',
      '当输入是 c) 类任务要求时，按这个顺序组织，只写与本任务相关的部分：',
      '目标：这段提示词要 DSH 得到什么结果；',
      '输入上下文：需要用到的文件、现状、已经知道的信息',
      '（原文提到多少写多少，没提到就不要编）；',
      '执行步骤：有先后关系的写成有序步骤，并行的写成并列项；',
      '产出格式：要交付什么形态的东西（改哪些文件、给出什么结论、什么结构）；',
      '验收标准：怎样算做完了、怎样算做对了。',
      '某一项在原文里没有依据时，整项小节不写，不留空位，也不用占位符。',
      '',
      '去重与收紧（本档最容易被做坏的地方）：',
      '1. 同一件事写一次就够，后文换个说法重提的，删掉；',
      '2. 「要专业」「要详细」这类词换成可执行的动作；',
      '3. 约束、依赖、数量、背景都来自原文，原文没有的就省掉这一项；',
      '4. 步骤不超过 6 条，一句话只讲一件事；',
      '5. 分层用纯文本：小标题写成「目标：」「约束：」这样的冒号形式，',
      '   条目用阿拉伯数字或中文序号。',
      '',
      '示例（补全是本档的要求，但套话和重复不是）：',
      '原文：改 README 的安装章节。改完给我看 diff，确认只动了这一节。',
      '错误输出：目标：修改 README。背景：README 是项目说明文档。（后一句是空话，原文没有。）',
      '正确输出：',
      '目标：修改 @README.md 的安装章节，其他章节不动。',
      '步骤：1. 读 @README.md，确认安装章节的起止；2. 只改这一节；3. 取该文件的 diff。',
      '产出格式：贴出 diff，说明改动是否只限于安装章节。',
      '验收标准：diff 中没有安装章节之外的改动。',
      '',
      '长度上限（按字符数计，不含首尾空白）：取下面三者里最小的那个 ——',
      '原文的 2.2 倍；原文 + 150 字（原文不足 150 字时用它）；封顶 4000 字。',
      '原文字数超过约 1800 时，封顶先到，倍数就不再作数。',
      '宁可短而准，不要长而空。',
    ].join('\n'),
  },
]

/*
 * 每一档都要能直接读出「完整会发出去的那份提示词」。
 *
 * 以前 prompt 是模块顶层算好的一整段字符串，场景约定被烤死在里面 ——
 * 于是「工作区是哪个」「本机是什么系统」这两件事只能写死。
 * 现在 prompt 是**取值器**：设置页读到的是静态渲染（没有会话上下文），
 * 真正调用模型前用这次会话的上下文再渲染一遍。两者拼装顺序完全一样，
 * 所以设置页看到的就是会发出去的那份。
 */
for (const item of STYLE_ITEMS) {
  Object.defineProperty(item, 'prompt', {
    enumerable: true,
    configurable: true,
    get() {
      return renderPrompt(item, STATIC_SCENE_CONTEXT)
    },
  })
}

/** 默认设置。auto + balanced 是「不用配置也能用」的组合。 */
const DEFAULT_SETTINGS = {
  /** 'auto' 跟随当前对话 · 'manual' 固定一个 · 'free' 优先免费通道 */
  modelMode: 'auto',
  provider: '',
  model: '',
  style: 'balanced',
  customPrompt: '',
  /** 是否已经问过用户要不要用免费通道（首次安装时弹一次窗）。 */
  freeChannelAsked: false,
}

/**
 * 免费通道：一个 OpenAI 兼容端点。
 *
 * 它是「零配置」的那条路：用户不必自己选模型，开箱就能优化。
 * 但免费通道可能随时不可用（额度、网络、上游故障），所以**永远作为首选而非唯一**：
 * 调用失败或返回空时静默回退到当前对话正在用的模型，用户不会因此用不了这个按钮。
 *
 * 密钥**不进代码库**：源码里不放任何凭据，只从环境变量读。
 * 想用免费通道，装完自己设一把：DSH_FREE_CHANNEL_API_KEY=...，然后重启 DSH。
 * 没设就跳过这一路，静默回退到当前对话正在用的模型。
 */
const FREE_CHANNEL = {
  baseURL: process.env.DSH_FREE_CHANNEL_BASE_URL || 'https://api.hcnsec.cn/v1',
  apiKey: process.env.DSH_FREE_CHANNEL_API_KEY || '',
  model: process.env.DSH_FREE_CHANNEL_MODEL || 'DeepSeek-V4-Flash',
  timeoutMs: 60000,
  /**
   * 是否在使用内置密钥。
   *
   * 源码里已经不放任何凭据，所以这里恒为 false —— 免费通道只用
   * DSH_FREE_CHANNEL_API_KEY 那一把。字段保留是为了设置页的旧回退路径
   * 不必改形状：它读到 false 会显示「检查你配置的密钥」。
   */
  usingBuiltinKey: false,
}

/**
 * 免费通道的可用性状态。
 *
 * 只有确定性的失败才判定为 'unavailable'：
 *   - auth（401/403）：密钥本身无效，重试多少次都是同一个结果。填错了 key 就是这种；
 *   - 限流、超时、网络抖动、服务端 5xx：都是临时的，不置为不可用，下次照常再试。
 *
 * 判定为不可用之后就不再去撞那个端点 —— 每按一次优化都先失败一次，
 * 体验比压根没有免费通道更糟。换一把新密钥（环境变量）并重启即可恢复。
 */
let freeChannelState = { status: 'unknown', kind: null, message: null, checkedAt: 0 }

/**
 * 把一次失败归类。
 *
 * 分类的意义是决定「还能不能再试」：401 说明钥匙不对，再试一万次也是 401；
 * 超时和 5xx 下次可能就好了，所以不能因为一次失败就把免费通道判死。
 */
function classifyFreeChannelError(error) {
  const status = typeof error?.status === 'number' ? error.status : undefined
  const raw = String(error?.message ?? error)
  if (status === 401 || status === 403 || /HTTP 40[13]/u.test(raw)) return 'auth'
  if (status === 429 || /HTTP 429/u.test(raw)) return 'rate'
  if (status !== undefined && status >= 500) return 'server'
  if (/HTTP 5\d\d/u.test(raw)) return 'server'
  if (/超时/u.test(raw)) return 'timeout'
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/iu.test(raw)) return 'network'
  return 'unknown'
}

/**
 * 把失败翻译成一句用户看得懂、也知道下一步做什么的话。
 *
 * 设置页直接显示这句话，不再显示上游返回的原始 JSON —— 那串报文对用户没有意义。
 */
function freeChannelFailureMessage(kind) {
  if (kind === 'auth') {
    return '免费通道密钥无效（HTTP 401）。请检查环境变量 DSH_FREE_CHANNEL_API_KEY 是否填对了。'
  }
  if (kind === 'rate') return '免费通道额度用尽或被限流（HTTP 429），过一会儿再试即可。'
  if (kind === 'server') return '免费通道服务端暂时异常（HTTP 5xx），过一会儿再试即可。'
  if (kind === 'timeout') return '免费通道超时（60 秒没有响应），过一会儿再试即可。'
  if (kind === 'network') return '连不上免费通道端点（网络问题），过一会儿再试即可。'
  if (kind === 'empty') return '免费通道返回了空内容，过一会儿再试即可。'
  return '免费通道暂时不可用，过一会儿再试即可。'
}

const STYLE_IDS = new Set(STYLE_ITEMS.map((item) => item.id).concat('custom'))

/**
 * 每个会话最近一次实际使用的模型。
 *
 * 为什么需要它：HTTP 路由里拿不到「当前对话正在用的模型」——
 *   `agents.currentInitiator()` 只在模型调用链里有效；
 *   `sessions.binding()` 在浏览器上下文不可用；
 *   模型选择器的状态在 slot inject 里，插件读不到。
 *
 * 但有一处能拿到：**模型发起请求时会经过 `agent/request` 事件**，
 * 那里带着本次调用的完整路由。把它按会话记下来即可。
 */
const routeBySession = new Map()

/** 当前设置（内存副本，写盘后更新）。 */
let settings = { ...DEFAULT_SETTINGS }

/**
 * 最后一次优化实际调用的路由。
 *
 * 设置页把它显示出来，是用来**核实**路由的：这个值由代码记录，
 * 不是模型自述。模型说自己是谁并不可靠（很多国产模型在训练数据里
 * 见过大量 GPT 的自称，会张冠李戴），但请求发给了哪个 provider、哪个 model，
 * 只有这里记录的是真的。
 */
let lastUsed = undefined

function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return
    settings = normalizeSettings(parsed)
  } catch {
    /* 文件不存在或损坏：用默认值 */
  }
}

function normalizeSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  // 三选一：auto 跟随对话 / manual 固定模型 / free 优先免费通道。
  // 兼容旧版布尔开关：曾经用 freeChannel:true 表示免费通道。
  let modelMode = 'auto'
  if (raw.modelMode === 'manual') modelMode = 'manual'
  else if (raw.modelMode === 'free') modelMode = 'free'
  else if (raw.modelMode === 'auto') modelMode = 'auto'
  else if (raw.freeChannel === true) modelMode = 'free'

  const style = typeof raw.style === 'string' && STYLE_IDS.has(raw.style) ? raw.style : 'balanced'
  return {
    modelMode,
    provider: typeof raw.provider === 'string' ? raw.provider : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    style,
    customPrompt: typeof raw.customPrompt === 'string' ? raw.customPrompt : '',
    freeChannelAsked: raw.freeChannelAsked === true,
  }
}

function saveSettings() {
  try {
    mkdirSync(SETTINGS_DIR, { recursive: true })
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, undefined, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 从 profile 的 patch 里读默认模型（最后兜底）。 */
function modelFromPatch() {
  try {
    const text = readFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
    const idx = text.indexOf('agent-default-model')
    if (idx < 0) return undefined
    const rest = text.slice(idx, idx + 400)
    const provider = /provider:\s*["']?([\w.-]+)["']?/u.exec(rest)
    const model = /model:\s*["']?([\w.-]+)["']?/u.exec(rest)
    if (provider === null || model === null) return undefined
    return { provider: provider[1], model: model[1] }
  } catch {
    return undefined
  }
}

/**
 * 按当前设置决定用哪份系统提示词。
 *
 * @param current    设置快照
 * @param sceneContext 场景上下文
 * @param lengthHint 可选：{ source, styleId }。给了就在提示词末尾追加一句
 *                   「本次目标 N 字」，让模型第一次就落在档位区间内。
 */
function systemPromptFor(current, sceneContext, lengthHint) {
  const base = (() => {
    if (current.style === 'custom') {
      const custom = current.customPrompt.trim()
      if (custom.length > 0) return custom
      // 自定义为空时退回均衡档，避免把空字符串当系统提示发出去。
      return renderPrompt(STYLE_ITEMS.find((item) => item.id === 'balanced'), sceneContext)
    }
    const found = STYLE_ITEMS.find((item) => item.id === current.style)
    return renderPrompt(found ?? STYLE_ITEMS[1], sceneContext)
  })()
  if (!lengthHint) return base
  const hint = lengthHintFor(lengthHint.styleId, lengthHint.source, lengthHint.kind)
  return hint === null ? base : base + '\n\n' + hint
}

/**
 * 目标字数提示。
 *
 * 线上实测：18 字的任务在均衡档区间 [49, 98]，模型三次分别写了太短、太长、
 * 太短 —— 它不知道「该写多少字」，只能凭感觉猜。猜偏了引擎就重试一次，
 * 一次优化变成两次模型调用，用户多等一倍时间（实测 15 次里 11 次重试）。
 *
 * 直接把目标告诉它：取区间中点。模型不用猜，第一次就落在区间内。
 *
 * 只对任务类（c）给。提问（b）本来就不该被补长，给它设字数目标会逼它编造。
 */
function lengthHintFor(styleId, source, kind) {
  if (kind !== 'c') return null
  const limit = lengthLimitFor(styleId, source.length)
  // 复用 bandViolation 用的同一份下限公式，别在这里再抄一遍 ——
  // 抄两遍就会出现「提示里说的范围」和「复核时判的范围」对不上。
  const floor = floorFor(styleId, source.length, limit)
  const target = Math.round((floor + limit) / 2)
  return `本次目标：原文 ${source.length} 字，改写到大约 ${target} 字（可接受范围 ${floor}–${limit} 字）。
在这个范围里写得越短越好，够用即可；不要为了凑字数添加原文没有的内容。`
}

/**
 * 判定输入属于哪一类：a) 寒暄 / b) 提问 / c) 任务。
 *
 * 判据不是这里发明的，是提示词里早就写好的那条（prompts/shared-common.txt 第 17 行）：
 *   只要需要 DSH 读写文件、跑命令或查看工作区才能推进，一律算 c)；
 *   只有不需要接触工作区的纯知识问答才算 b)。
 * 所以这里找的是「指向工作区的字面信号」——路径、文件名、反引号里的命令、
 * 报错原文、工作区名词配动作动词——而不是「句子里有没有动词」。
 *
 * 为什么必须换掉旧词表：旧实现把 如何|怎么|为什么|能否|配置|插件|解释|分析
 * 都算任务信号，于是**所有中文疑问句都被判成 c)**。判成 c) 的代价不是「多补一句」：
 * 均衡/详细档会给它套上内容下限，模型只好给一句提问硬造「产出 / 验收」。
 * 「怎么配置 profile？」13 字、下限 47 字，而提示词自己给的正例只有 38 字 ——
 * 照提示词写反而被判不合格，重试后编出来的稿子长度合格，被收下还标成 expanded。
 *
 * 判定顺序是这份实现的关键，别调换：
 *   1. 工作区字面信号 → c)（带路径/命令/报错的一律是任务，哪怕写成疑问句）
 *   2. 请求词（帮我/给我/麻烦）→ c)
 *   3. 工作区名词 + 动作动词 → c)（「看看我的 profile 配得对不对」）
 *   4. 疑问句式 → b)（必须在「光有动词」之前：「怎么改」里的「改」是宾语，不是要执行的动作）
 *   5. 有动作动词 → c)
 *   6. 其余 → a)
 *
 * 判不准时这里**偏 b)**（不设内容下限）。这和提示词里「拿不准时按 c)」的方向相反，
 * 是有意的：模型按 c) 多写一句，用户删掉即可；引擎按 c) 会强制重试并命令模型
 * 「至少写 N 字」，模型只能编造。代价不对称，所以默认值必须相反。
 */

/** 指向工作区的名词。出现它 + 动作动词，就是在说仓库里的事。 */
const WS_NOUN = /(?:这个|该|本)?(?:仓库|项目|工作区|代码库|源码|目录|文件夹|工程)|(?:我的|本机的|自己的)(?:配置|设置|插件|环境)|profile|配置项|槽位|设置页|插件目录|日志文件/iu

/** 路径或带扩展名的文件名。命中即任务，不用再看别的。 */
const PATHY = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])|(?:^|[\s(（「])(?:[\w.@-]+[\\/])+[\w.@-]+|[\w@.-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|txt|yml|yaml|toml|py|rs|go|java|sh|ps1|bat|css|html)\b/iu

/** 反引号包起来的命令片段。 */
const CODE_SPAN = /`[^`\n]+`/u

/** 行首的命令。 */
const COMMANDY = /(?:^|\n)\s*(?:\$|>|PS>|npm|pnpm|yarn|node|git|curl|cd|ls|dir|cat|grep|rg|sed|awk|python|pip|cargo|go |make|docker)\b/iu

/** 贴出来的报错原文。 */
const ERROR_TEXT = /(?:报错|错误|异常|堆栈|traceback|error|exception|失败)[\s\S]{0,40}(?:[A-Za-z]*Error\b|\bat\s+\S+\s*\(|:\s*\S+\.(?:js|ts|py):\d+|0x[0-9a-f]+)/iu

/**
 * 动作动词。
 *
 * 中文没有词边界，只能按「出现在串里」判；会不会误伤疑问句，靠判定顺序挡住
 * （第 4 条疑问句式排在第 5 条前面）。
 */
const WS_VERB = /(?:看|查看|检查|读|打开|跑|运行|执行|安装|卸载|修改|修复|修掉|修好|改成|改掉|改一下|重构|整理|调试|排查|定位|提交|推送|回滚|升级|迁移|同步|扫描|统计|列出|导出|导入|解析|转换|替换|批量|搜索|找出|对比|评审|解释|换个|删掉|删除|新建|创建|生成|加上|添加|补上|补全|写个|改)/u

/**
 * 中文里「动作在句中或句尾」的说法。
 *
 * 前面的 WS_VERB 是按常见动词表匹配的，漏了这几种语序：
 *   「加一个超时」        —— 动词 + 数量 + 名词
 *   「压到 500 字以内」    —— 动词 + 到 + 数字
 *   「把 for 循环换成 while」—— 把字句 + 换成
 *   「用 TypeScript 重写」 —— 用 X + 重写
 * 它们都是要动手的事，不是闲聊。
 */
const ZH_ACTION_TAIL = /(?:加|减|删|去|换|改|调|压|扩|缩|拆|合|移|拆成|拆开|合并|换成|替换成|重写|重构|优化|简化|拆分|压缩|限制|约束|统一|对齐|统一成|包一层|套一层|抽出来|提出来|抽成|提成)/u

/**
 * 否定式与约束式要求。
 *
 * 「别用 any」「不要用 Object」「最多 500 字」「必须 TypeScript」——
 * 这些是明确的指令，判成闲聊等于让用户白点一次。
 */
const ZH_CONSTRAINT = /(?:别|不要|不准|不许|禁止|避免|尽量别|务必|必须|一定要|只能|最多|最少|不超过|不低于|不少于|控制在|限制在|保持在|统一用|统一成|一律|全都|全用)/u

/**
 * 技术栈 / 具体实现指定。
 *
 * 「用 TypeScript 重写」「用 Map 而不是 Object」——
 * 出现这些具体名词 + 任何动作意味，就是在说代码怎么写。
 */
const TECH_NOUN = /(?:TypeScript|JavaScript|Python|Rust|Go\b|Java|React|Vue|Svelte|Node|Deno|Bun|Map|Set|Object|Array|Promise|async|await|interface|type\b|class\b|function\b|enum|struct|trait|for\s*循环|while\s*循环|if\s*语句|switch|正则|regex|json|yaml|toml|sql|http|api\b|rest|graphql|docker|k8s|nginx)/iu

/** 英文的动作动词，只在开头位置认。 */
const EN_WS_VERB = /^\s*(?:please\s+)?(?:read|open|run|exec|execute|edit|write|create|build|make|fix|refactor|test|debug|install|uninstall|add|remove|delete|update|upgrade|migrate|check|review|compare|search|find|grep|patch|commit|push|revert|bump|rename|move|copy|sync|scan|list|dump|export|import|parse|convert|replace|split|merge|analyze|analyse|explain|show|print|tell me|give me|look at|look into)/iu

/** 疑问句开头。 */
const ASK_LEAD = /^\s*(?:请问|想问|问一下|问下|能否|能不能|可不可以|是不是|是否|要不要|需要不需要|怎么|如何|为什么|为啥|什么|啥|哪|谁|多少|多久|多大|几种|有没有|会不会|该不该|行不行|对不对|好不好)/iu

/** 疑问句收尾：问号，或「吗 / 呢 / 么」结尾。 */
const ASK_TAIL = /[？?]\s*$|(?:吗|呢|么)\s*[？?]?\s*$/u

/** 句中出现疑问词（「同一个对话换模型是不是更省？」）。 */
const ASK_ANY = /(?:怎么|如何|为什么|为啥|什么|啥|哪[个些里种]|多少|是否|能不能|可不可以|会不会|是不是|有没有|该不该|行不行|对不对|好不好)/u

/**
 * 请求词。放在「出现在哪儿都算」：emoji 或别的前缀不影响它的意思。
 */
const HELP_ANY = /(?:帮我|帮忙|请帮|麻烦|给我|替我|劳驾|求帮)/u

/** 英文疑问句开头。 */
const EN_ASK = /^\s*(?:how|what|why|when|where|which|who|can|could|should|would|is|are|does|do|did)\b/iu

/**
 * 延续性输入：接着上文说的。
 *
 * 这类句子单独看没有任何信息，但它**是任务** —— 用户在上一条消息的基础上
 * 要求继续、重来、或者指出哪里不对。判成 a)（闲聊）会一个字都不改，
 * 用户点了一次「优化」却什么都没发生。
 *
 * 判成 c) 至少会交给模型：模型能看到它自己的理解，比原样返回强。
 */
const CONTINUATION = /^\s*(?:继续|接着|接着做|接着来|往下|再来|再来一次|重来|重新来|重做|redo|continue|go on|next)\s*[。.!！]?\s*$|^\s*(?:这个|这里|那个|那里)?\s*(?:不对|错了|有问题|不行)\s*[。.!！]?\s*$|按(?:刚才|之前|上面|前面)的/iu

/** 是不是疑问句式。 */
function looksLikeQuestion(s) {
  return ASK_LEAD.test(s) || ASK_TAIL.test(s) || ASK_ANY.test(s) || EN_ASK.test(s)
}

/**
 * 返回 'a' | 'b' | 'c'。判不准时返回 'b'（不设内容下限），理由见上面的注释。
 */
function classifyInput(raw) {
  const s = String(raw ?? '').trim()
  if (s.length === 0) return 'a'

  // 1. 明确的请求词。「帮我」「给我」压过一切 —— 带疑问词的请求仍是请求。
  if (HELP_ANY.test(s)) return 'c'

  // 2. 延续性输入：接着上文说的，本身就是任务。
  if (CONTINUATION.test(s)) return 'c'

  // 3. 工作区名词 + 动作动词（「看看我的 profile 配得对不对」）。
  //    这一条必须排在疑问判断之前：「对不对」是疑问词，但整句是要动手的事。
  if (WS_NOUN.test(s) && (WS_VERB.test(s) || EN_WS_VERB.test(s))) return 'c'

  /*
   * 4. 疑问句式 → b)。
   *
   * 这一条必须排在「工作区字面信号」之前。早先路径排第一，于是
   * 「src/app.ts 为什么这么慢？」「package.json 里的 scripts 是干嘛的？」
   * 都被判成任务、套上内容下限 —— 用户只是在问，却被逼着补产出。
   *
   * 判断依据是句式，不是有没有路径：带路径的提问仍是提问。
   */
  if (looksLikeQuestion(s)) return 'b'

  // 5. 工作区字面信号：路径、命令、报错原文。
  if (PATHY.test(s) || CODE_SPAN.test(s) || COMMANDY.test(s) || ERROR_TEXT.test(s)) return 'c'

  // 6. 不是疑问句、又有动作动词。
  if (WS_VERB.test(s) || EN_WS_VERB.test(s)) return 'c'

  /*
   * 7. 其余几种「要动手」的说法。
   *
   * 走到这里说明既不是疑问句、也没有常见动词。但这几种仍然是任务：
   *   「加一个超时」           动词在句尾
   *   「别用 any」             否定式要求
   *   「压到 500 字以内」      约束式要求
   *   「用 TypeScript 重写」   指定技术栈
   * 判成 a) 会一个字都不改，用户点了优化什么都没发生。
   *
   * 这几条放在疑问判断**之后**：带疑问词的仍然先按提问处理，
   * 否则「能不能别用 any？」会被当成任务去改写。
   */
  if (ZH_ACTION_TAIL.test(s)) return 'c'
  if (ZH_CONSTRAINT.test(s)) return 'c'
  if (TECH_NOUN.test(s)) return 'c'

  // 7. 寒暄 / 陈述。
  return 'a'
}

/**
 * 判断改写是否"把一句话扩成了一篇文档"。
 *
 * 这是提示词之外的工程兜底：就算提示词写清楚了，模型仍可能不受控地加码。
 * 只抓最刺眼的那种失控 —— 非任务类的短输入配上了远超它的输出。
 *
 * 阈值故意放宽，因为误伤（把该展开的任务压短）比漏放更烦人：
 *   - 极短输入（≤ 60 字）输出超过 400 字且超过原文 8 倍；
 *   - 或输出超过原文 12 倍且超过 1200 字。
 */
function looksOverExpanded(source, result) {
  const s = source.trim()
  const r = result.trim().length
  if (s.length === 0 || r === 0) return false
  // 任务类输入本来就该展开，直接放行。
  if (classifyInput(s) === 'c') return false
  if (s.length <= 60 && r > 400 && r > s.length * 8) return true
  if (r > s.length * 12 && r > 1200) return true
  return false
}

/**
 * 当前档位允许的最大输出长度。
 *
 * 公式与 prompts/ 里各档的「长度上限」一句一致：
 *   上限 = max(原文长度 × 倍数, 原文长度 + 加字额度)
 *
 * 取两者里更大的那个：原文短时靠加字额度给模型喘息（否则「1.15 倍」
 * 几乎等于一个字都不许加），原文长了自动切回倍数封顶。
 */
function lengthLimitFor(styleId, sourceLength) {
  const band = STYLE_BANDS[styleId] ?? STYLE_BANDS.balanced
  const byRatio = sourceLength * band.ratioMax
  const byPlus = sourceLength + band.plusChars
  /*
   * 下限兜底：上限永远不低于原文。
   *
   * 早先只按 absMax 截顶，于是 5000 字的输入在详细档上限只有 4000 ——
   * 上限比原文还短，等于要求「把长文压成短文」。那不是优化提示词，
   * 是把用户写的东西砍掉。档位复核还会因此判它超长、逼模型删内容。
   *
   * 长输入时 absMax 只该封顶「加出来的部分」，不该把原文本身也砍掉。
   */
  return Math.max(sourceLength, Math.min(band.absMax, Math.round(Math.max(byRatio, byPlus))))
}

/**
 * 任务类输入的内容下限。
 *
 * 均衡/详细档要求写出产出与验收口径，只改措辞等于没做 —— 这时给一个下限。
 *
 * 下限取上限的一半（且至少比原文多 20 字），并保证严格小于上限：
 * 上限现在是 max(原文 × 倍数, 原文 + 加字额度)，短输入的上限本身就等于
 * 「原文 + 加字额度」，如果下限也按老公式算，两者会相等 ——
 * 短输入就会同时踩「过短」和「超长」两条线，怎么写都过不了。
 */
function floorFor(styleId, sourceLength, limit) {
  const wanted = Math.max(Math.round(limit * 0.5), sourceLength + 20)
  return Math.min(wanted, limit - 1)
}

/**
 * 复核输出有没有守住当前档位的边界。
 *
 * 返回 null 表示合格；否则返回一句给模型看的修正指令。
 *
 * 三种不合格：
 *   'too-long'   —— 超出档位上限（详细档冗余、精简档被加码都归到这里）；
 *   'too-short'  —— 任务类输入却几乎没补内容（均衡档只改措辞就落在这里）；
 *   'unchanged'  —— 任务类输入，模型把原文原样吐了回来，一个字都没改。
 *
 * 'too-short' / 'unchanged' 只对「均衡」「详细」的任务类判定：任务类输入按定义
 * 就该补出产出与验收，结果却跟原文一样或差不多长，说明模型没做事。
 *
 * 为什么要把 'unchanged' 单列：线上实测「帮我优化一下这个」跑 8 次有 2 次
 * 原样返回。只判 'too-short' 的话，重试指令说的是「几乎没有补充任何内容」，
 * 模型看到这句会以为「补点字就行」，于是补出来的还是原文换了个说法 ——
 * 或者干脆还是原文。**得直接告诉它「你什么都没改」。**
 */
function bandViolation(styleId, source, result) {
  if (styleId !== 'brief' && styleId !== 'balanced' && styleId !== 'detailed') {
    return null
  }
  const s = source.trim()
  const r = result.trim()
  if (s.length === 0 || r.length === 0) return null

  const limit = lengthLimitFor(styleId, s.length)
  if (r.length > limit) {
    return `too-long:${limit}`
  }

  if (styleId !== 'brief' && classifyInput(s) === 'c') {
    /*
     * 先判「原样返回」，再判「太短」。
     *
     * 顺序不能反：原样返回必然也满足「太短」（原文长度肯定低于下限），
     * 先判太短就永远走不到这条分支，模型收到的还是那句含糊的「没补充内容」。
     *
     * 判据用归一化后的全等，而不是严格 === ：模型常会改个标点、
     * 多一个句号、把全角换成半角，那仍然是「什么都没改」。
     */
    if (sameContent(s, r)) {
      return 'unchanged'
    }
    const floor = floorFor(styleId, s.length, limit)
    if (floor > 0 && r.length < floor) {
      return `too-short:${floor}`
    }
  }
  return null
}

/**
 * 两段文字是不是「实质相同」。
 *
 * 忽略空白与标点差异 —— 模型把「好的，谢谢」写成「好的，谢谢。」，
 * 或者把全角括号换成半角，那都不算改写。
 */
function sameContent(a, b) {
  const strip = (s) => String(s ?? '')
    .replace(/\s+/gu, '')
    .replace(/[，。！？；：、,.!?;:'"'`（）()【】\[\]「」『』《》<>—\-…~～]/gu, '')
  return strip(a) === strip(b)
}

/**
 * 构造一次带修正指令的重试用系统提示词。
 *
 * 复用原档位的提示词，再把「上次哪里不对、这次要改成什么样」写清楚，
 * 让模型自己收放，而不是换一档重来 —— 换档会把用户选的那一档换掉。
 */
function correctionPromptFor(styleId, source, result, violation, sceneContext) {
  const item = STYLE_ITEMS.find((entry) => entry.id === styleId)
  /*
   * 重试也要带目标字数。
   *
   * 早先这里直接 renderPrompt(item)，绕过了 systemPromptFor 的提示拼接，
   * 于是首稿有目标、重试没有 —— 模型在「补齐」时还是不知道补到多少才算够，
   * 补过头又触发一次「收敛」，来回拉锯。
   */
  const hint = lengthHintFor(styleId, source, classifyInput(source))
  const base = item === undefined
    ? systemPromptFor({ style: styleId }, sceneContext)
    : renderPrompt(item, sceneContext)
  const baseWithHint = hint === null ? base : base + '\n\n' + hint
  const [kind, bound] = violation.split(':')
  const limit = Number(bound)

  let instruction
  if (kind === 'unchanged') {
    /*
     * 「原样返回」得单独说，不能并进 too-short。
     *
     * too-short 的指令是「它几乎没有补充任何内容，本次输出至少 N 字」——
     * 模型听到这句会去补字数，可能补出一堆和原文无关的空话。
     * 这里要它做的是**改写**，不是**加长**。
     */
    instruction = [
      '上一次改写不合格：你把原文原样返回了，一个字都没有改动。',
      '用户点「优化」是希望拿到一份**改写过**的提示词，不是拿回自己刚写的话。',
      '请重新改写：保留原意，把它写得更清楚、更可执行；原文没说的不要补造。',
      '只输出改写后的正文。',
    ].join('\n')
  } else if (kind === 'too-long') {
    instruction = [
      '上一次改写不合格：它超出了本档的长度上限。',
      `本次输出总长不得超过 ${limit} 字（上次是 ${result.trim().length} 字，原文 ${source.trim().length} 字）。`,
      '请重新改写：保留原文的信息量与意图，删掉重复的表述、空话和不必要的铺垫，',
      '保留产出与验收口径这些关键句，删到上限以内。',
      '只输出改写后的正文。',
    ].join('\n')
  } else {
    instruction = [
      '上一次改写不合格：它几乎没有补充任何内容。',
      `任务类输入按本档要求必须写明「期望产出」和「验收口径」，本次输出至少 ${limit} 字。`,
      '请重新改写：把原文隐含的产出形式和「怎样算做对」写出来，',
      '但只写与本任务直接相关的内容，不要补造依赖、数量或背景。',
      '只输出改写后的正文。',
    ].join('\n')
  }

  // 分隔不用 '---'：公共规则第 1 条明令输出里不出现三个横线，
  // 系统提示自己先照做，免得模型照着学。
  return [baseWithHint, '', '下面是本次修正要求（优先于上面与本档冲突的表述）：', instruction].join('\n')
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 调一次免费通道，返回纯文本。
 *
 * 走 OpenAI 兼容的 /chat/completions，非流式：这个按钮要的是「一次替换掉输入框」，
 * 流式反而会让草稿逐字变化，体验更差。
 * 任何异常都向上抛，由调用方决定回退 —— 这里不吞错，否则没法在设置页显示原因。
 */
async function callFreeChannel(system, input, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FREE_CHANNEL.timeoutMs)
  // 用户取消时，要连带把这次 HTTP 请求也停掉。
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw abortedError()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(`${FREE_CHANNEL.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FREE_CHANNEL.apiKey}`,
      },
      body: JSON.stringify({
        model: FREE_CHANNEL.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: input },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(`免费通道 HTTP ${response.status}${detail ? '：' + detail.slice(0, 120) : ''}`)
      // 把状态码挂上去：分类要靠它，不能靠字符串匹配。
      error.status = response.status
      throw error
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === 'string' ? content.trim() : ''
  } catch (error) {
    // 超时是我们自己掐的；用户取消是用户掐的，两者都要报成"取消"而不是失败。
    if (error?.aborted === true) throw error
    if (signal?.aborted === true) throw abortedError()
    if (error?.name === 'AbortError') throw new Error(`免费通道超时（${FREE_CHANNEL.timeoutMs / 1000}s）`)
    throw error
  } finally {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 用免费通道跑一次改写，并把失败归类记下来。
 *
 * 与 callFreeChannel 的区别：这里不抛错，只返回成败 + 原因。
 * 免费通道是「有就用，没有就退」的可选路径，不该把错误冒泡给用户。
 */
async function tryFreeChannel(system, input, signal) {
  try {
    const out = await callFreeChannel(system, input, signal)
    if (out.length > 0) {
      freeChannelState = { status: 'ok', kind: null, message: null, checkedAt: Date.now() }
      return { ok: true, text: out }
    }
    freeChannelState = {
      status: 'unavailable',
      kind: 'empty',
      message: freeChannelFailureMessage('empty'),
      checkedAt: Date.now(),
    }
    return { ok: false, kind: 'empty', message: freeChannelState.message }
  } catch (error) {
    // 用户取消不算"通道坏了"：不能因此把免费通道判死。
    if (error?.aborted === true) throw error
    const kind = classifyFreeChannelError(error)
    // 只有确定性的失败才把通道判死；临时的失败保持「下次再试」。
    if (kind === 'auth') {
      freeChannelState = {
        status: 'unavailable',
        kind,
        message: freeChannelFailureMessage(kind),
        checkedAt: Date.now(),
      }
    } else {
      freeChannelState = { status: 'degraded', kind, message: null, checkedAt: Date.now() }
    }
    return { ok: false, kind, message: freeChannelFailureMessage(kind) }
  }
}

/** 从流式响应里拼出完整文本。 */
async function collectText(stream) {
  let out = ''
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    // text-delta 是增量文本块；兜底再认一次整块 text。
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text
      continue
    }
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      out += chunk.text
    }
  }
  return out
}

/**
 * 流式推送的节流间隔。
 *
 * 模型是按 token 吐字的，一秒能来几十块。全部推给界面会疯狂重绘，
 * 所以攒一小会儿再推一次；最后一定补推一次完整的。
 */
const STREAM_PUSH_INTERVAL_MS = 40

/**
 * SSE 响应头。
 *
 * 宿主对 text/event-stream 不做 gzip（见 dsh-host-webserver 的
 * compressionMiddleware 过滤器），所以长连接不会被缓冲住。
 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

/** 推一条 SSE 事件。客户端已经断开时写入会抛错，忽略即可。 */
/**
 * 把一次失败翻成「回执里能带出去的错误码」。
 *
 * 为什么需要它：早先错误回执里只有一段中文，调用方（客户端、别的插件、
 * 写测试的人）只能拿字符串去猜发生了什么。文案一改，判断就跟着坏。
 * 错误码是稳定契约：文案可以换，码不能。
 *
 * @param {unknown} error
 * @returns {string} EMPTY_INPUT / TOO_LONG / EMPTY_OUTPUT / ABORTED / UNKNOWN
 */
function errorCodeOf(error) {
  const code = error === null || error === undefined ? undefined : error.code
  if (code === 'EMPTY_INPUT' || code === 'TOO_LONG' || code === 'EMPTY_OUTPUT') return code
  // 取消不是错误，但也要能被认出来：客户端据此静默收场，不弹红框。
  if (error !== null && error !== undefined && (error.aborted === true || error.name === 'AbortError')) return 'ABORTED'
  return 'UNKNOWN'
}

/** 错误码 → HTTP 状态码。输入类错误是用户的问题（400），模型没吐东西是上游的问题（502）。 */
function httpStatusOf(code) {
  if (code === 'EMPTY_INPUT' || code === 'TOO_LONG') return 400
  if (code === 'EMPTY_OUTPUT') return 502
  if (code === 'ABORTED') return 499
  return 500
}
function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    /* 客户端走了 */
  }
}

/**
 * 消费一次模型流：边收边把进度推给 hooks，同时收下完整文本与 token 用量。
 *
 * hooks.onText 收到的是**当前累计文本**（不是增量），客户端直接替换就行，
 * 不用自己拼 —— 少一处容易出错的地方。
 *
 * @param {AsyncIterable} stream 模型流
 * @param {{onText: Function, onReasoning: Function}} hooks 回调
 * @returns {Promise<{text: string, reasoning: string, usage: object|null}>}
 */
async function consumeStream(stream, hooks) {
  let text = ''
  let reasoning = ''
  let usage = null
  let lastPushAt = 0
  const push = (force) => {
    const now = Date.now()
    if (!force && now - lastPushAt < STREAM_PUSH_INTERVAL_MS) return
    lastPushAt = now
    hooks.onText(text)
  }
  for await (const chunk of stream) {
    if (chunk === null || chunk === undefined) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      push(false)
      continue
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      // 思考过程：模型不给就没有，给了就在预览卡里单独显示。
      reasoning += chunk.text
      hooks.onReasoning(reasoning)
      continue
    }
    if (chunk.type === 'usage' && chunk.usage !== undefined && chunk.usage !== null) {
      usage = chunk.usage
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'aborted') throw abortedError()
      if (kind === 'error') {
        throw new Error(chunk.reason?.failure?.message || '模型调用失败')
      }
      continue
    }
    if (chunk.type === 'text' && typeof chunk.text === 'string') {
      text += chunk.text
      push(false)
    }
  }
  push(true)
  return { text, reasoning, usage }
}

loadSettings()

export function apply(ctx) {
  /**
   * 记录每个会话实际使用的模型（供 auto 档使用）。
   *
   * `agent/request` 是 waterfall：必须 return next()，否则截断整条请求链。
   */
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id
    if (sessionId !== undefined
      && typeof config?.provider === 'string'
      && typeof config?.model === 'string') {
      routeBySession.set(String(sessionId), { provider: config.provider, model: config.model })
    }
    return config
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId !== undefined) routeBySession.delete(String(sessionId))
  })

  /** 列出所有可选模型，供手动选择。取不到就返回空列表，不阻塞设置页。 */
  async function listAllModels() {
    const out = []
    let providers = []
    try {
      providers = ctx.llm.listProviders()
    } catch {
      return out
    }
    // 并行取每个 provider 的模型清单；单个失败不影响整体。
    const groups = await Promise.all(providers.map(async (info) => {
      try {
        const models = await ctx.llm.listModels(info.id)
        return models.map((model) => ({
          provider: info.id,
          providerName: info.name,
          model: model.id,
          name: model.name ?? model.id,
        }))
      } catch {
        return []
      }
    }))
    for (const group of groups) out.push(...group)
    return out
  }

  /** 解析实际要用的模型：manual 用设置里的，auto 按会话/兜底链取。 */
  function resolveRoute(sessionId, agent) {
    const current = settings
    if (current.modelMode === 'manual'
      && current.provider.length > 0
      && current.model.length > 0) {
      return { provider: current.provider, model: current.model, source: 'manual' }
    }

    // auto：优先用这个会话实际在跑的模型。
    if (sessionId.length > 0) {
      const remembered = routeBySession.get(sessionId)
      if (remembered !== undefined) return { ...remembered, source: 'session' }
    }

    try {
      const rc = agent?.session?.requestContext?.()
      if (rc !== undefined && typeof rc.provider === 'string' && typeof rc.model === 'string') {
        return { provider: rc.provider, model: rc.model, source: 'session' }
      }
    } catch {
      /* 忽略 */
    }
    try {
      const opts = agent?.options
      if (opts !== undefined && typeof opts.provider === 'string' && typeof opts.model === 'string') {
        return { provider: opts.provider, model: opts.model, source: 'session' }
      }
    } catch {
      /* 忽略 */
    }
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection !== undefined
        && typeof selection.provider === 'string'
        && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, source: 'default' }
      }
    } catch {
      /* 忽略 */
    }
    const fromPatch = modelFromPatch()
    return fromPatch === undefined ? undefined : { ...fromPatch, source: 'config' }
  }

  // ── 优化核心 ────────────────────────────────────────────────────────────

  /**
   * 跑一次完整优化，返回与 /optimize 路由同构的回执。
   *
   * 为什么抽成一个函数：优化现在有六个入口（客户端三个走 HTTP 路由，
   * 宿主侧三个走这里）。它们必须产出同一份结果 —— 同一段话从按钮跑
   * 和从斜杠命令跑，档位复核、过度扩写兜底、免费通道回退都该一模一样。
   * 这些逻辑只留这一份，改一处六处都生效。
   *
   * @param {{text: string, sessionId?: string, agent?: object, signal?: AbortSignal,
   *          hooks?: {onStart?: Function, onText?: Function, onReasoning?: Function,
   *                   onRevise?: Function}}} options
   *   hooks 只给**第一次尝试**做逐字推送；后面两次补救（过度扩写拉回、
   *   档位收敛/补齐）是整段换稿，所以先推一条 onRevise 说明原因，
   *   收尾再补推一帧最终正文 —— 界面上的最后一帧永远等于返回的正文。
   * @returns {Promise<object>} 与 /optimize 路由返回体同构的结果
   */
  async function optimizeText(options) {
    const text = typeof options?.text === 'string' ? options.text.trim() : ''
    if (text.length === 0) {
      const error = new Error('输入为空，没有可优化的内容')
      error.code = 'EMPTY_INPUT'
      throw error
    }
    if (text.length > MAX_INPUT_CHARS) {
      const error = new Error(`内容过长（${text.length} 字符），请精简到 ${MAX_INPUT_CHARS} 以内`)
      error.code = 'TOO_LONG'
      throw error
    }

    /*
     * 短到没有信息可补的输入：原样返回，不调模型。
     *
     * 「改」只有 1 个字。线上实测它被补成 117 字的空话 ——
     * 「目标：执行"改"所指向的变更操作，使相应对象发生预期变化。
     *   产出格式：交付变更后的产物，形态为修改后的文件……」
     * 原文没有任何可补的信息，模型只能造套话；而档位下限又会逼它把套话写够长。
     * 这不是优化，是把用户的一句话换成一段谁都能说的话。
     *
     * 阈值取 4 个字：「改」「重来」「继续」这类都归到这里；
     * 「跑测试」（3 字）也归到这里 —— 它同样补不出东西。
     * 但「帮我写个登录页」（7 字）照常送模型，它真的有信息可补。
     */
    if (text.length < MIN_MEANINGFUL_CHARS) {
      return {
        ok: true,
        text,
        provider: 'none',
        model: 'none',
        style: settings.style,
        source: 'passthrough',
        recovered: false,
        adjusted: null,
        reasoning: null,
        usage: null,
        elapsedMs: 0,
        freeChannel: { enabled: false, used: false, error: null },
      }
    }

    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
    const startedAt = Date.now()
    // 设置快照：一次优化跑到一半时用户去设置页换档，不该中途换提示词。
    const current = settings
    // 没有外部 signal 时给一个永不中止的：调用方不必自己造一个。
    const abort = options?.signal ?? new AbortController().signal

    /*
     * 界面看到的字，和最终返回的字，必须是同一份。
     *
     * 只有第一次尝试是「边写边推」的；后面两次补救（过度扩写拉回、档位
     * 收敛/补齐）是静默整段换稿。于是用户会看到：字长到一半停住，等几秒，
     * 然后整段变成另一份完全不同的正文 —— 看起来就是「优化结果自己变成了
     * 另一个优化结果」，而且没有任何解释。
     *
     * 这里把两者钉死，做两件事：
     *   1. 每次补救开始前推一条 onRevise，说明「为什么要重写」；
     *   2. 收尾时若最终正文还没被推过，补推一帧 —— 客户端收到的最后一帧
     *      永远等于返回的正文，不会出现「done 里凭空空降一份新结果」。
     */
    /** 界面最后看到的那一帧正文；收尾时拿它和最终正文比对。 */
    let lastStreamed = null
    /** 真正产出最终正文的那一轮（重试换了路由时，回执要跟它走）。 */
    let finalRoute = null
    // 包一层 hooks：既转发给调用方，也把「最后推出去的那帧」记下来。
    const rawHooks = options?.hooks
    const liveHooks = rawHooks === undefined || rawHooks === null
      ? undefined
      : {
        onStart: (info) => rawHooks.onStart?.(info),
        onText: (value) => {
          lastStreamed = typeof value === 'string' ? value : ''
          rawHooks.onText?.(value)
        },
        onReasoning: (value) => rawHooks.onReasoning?.(value),
        onRevise: (info) => rawHooks.onRevise?.(info),
      }

    let agent = options?.agent
    if (agent === undefined && sessionId.length > 0) {
      try {
        agent = ctx.sessions?.binding?.(sessionId)?.agent
      } catch {
        /* 忽略 */
      }
    }
    if (agent === undefined) {
      try {
        agent = ctx.agents?.currentInitiator?.()
      } catch {
        /* 忽略 */
      }
    }

    /*
     * 这次改写的场景上下文：会话工作区 + 本机环境。
     *
     * 为什么要在每次调用时现算、而不是启动时算一次：
     *   - 工作区是**会话级**的，用户可以在一个 DSH 里开两个会话指向两个项目；
     *   - 用户在会话里换过目录（workingDirectory.set）之后，下一个请求就该跟着变。
     * 拿不到就不给值 —— dshScene() 会把那一行整行删掉，绝不编造路径。
     */
    const sceneContext = { workspace: workspaceOf(agent, sessionId), environment: '' }

    /** 取这个会话的工作区绝对路径；拿不到返回空串。 */
    function workspaceOf(liveAgent, liveSessionId) {
      const session = sessionOf(liveAgent, liveSessionId)

      // 1. 宿主 workingDirectory 服务：它管着「会话当前目录」，
      //    用户在会话里换过目录之后以它为准，header 里记的只是原始目录。
      if (session !== undefined) {
        try {
          const dir = ctx.workingDirectory?.get?.(session)
          if (typeof dir === 'string' && dir.length > 0) return dir
        } catch {
          /* 忽略 */
        }
      }

      // 2. 会话 header 里记着的原始目录（重启后仍在，最可靠）。
      try {
        const header = session?.header ?? session?.meta
        if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd
      } catch {
        /* 忽略 */
      }

      // 3. 兜底：部署级默认目录。它代表「这台机器默认在哪儿干活」，
      //    与会话无关，但比不说强 —— 说错了会让模型去改错目录，
      //    所以只在上面两条都拿不到时才用。
      try {
        const dir = ctx.workingDirectory?.defaultDirectory
        if (typeof dir === 'string' && dir.length > 0) return dir
      } catch {
        /* 忽略 */
      }
      return ''
    }

    /** 拿到会话对象：优先用调用方给的 agent，其次问宿主要这个 sessionId 的绑定。 */
    function sessionOf(liveAgent, liveSessionId) {
      try {
        const fromAgent = liveAgent?.session
        if (fromAgent !== undefined && fromAgent !== null) return fromAgent
      } catch {
        /* 忽略 */
      }
      try {
        const binding = liveSessionId.length > 0 ? ctx.sessions?.binding?.(liveSessionId) : undefined
        return binding?.session
      } catch {
        /* 忽略 */
      }
    }

    /**
     * 尝试一次改写。
     *
     * 顺序：免费通道（若用户开启）→ 当前对话的模型。
     * 免费通道失败不报错、不打断，只把原因记下来给设置页显示，
     * 然后照常用会话模型跑完 —— 用户按下按钮就该拿到结果。
     */
    const enhanceOnce = async (system, input, hooks) => {
      let freeError
      // 先按「即将走哪条路」报一次路由，界面能立刻显示模型名。
      // 免费通道失败回退时下面还会再报一次，后报的覆盖先报的 ——
      // 客户端 onStart 只是写 meta，覆盖一次没有副作用。
      if (current.modelMode === 'free'
        && !(freeChannelState.status === 'unavailable' && freeChannelState.kind === 'auth')) {
        hooks?.onStart?.({
          provider: 'free-channel',
          model: FREE_CHANNEL.model,
          style: current.style,
          source: 'free',
        })
      }
      if (current.modelMode === 'free') {
        // 已知密钥无效就不再白跑一趟：
        // 直接走对话模型，结果一样，只是省掉一次必然失败的请求。
        if (freeChannelState.status === 'unavailable' && freeChannelState.kind === 'auth') {
          freeError = freeChannelState.message
        } else if (FREE_CHANNEL.apiKey.length === 0) {
          // 源码里不带凭据：没设 DSH_FREE_CHANNEL_API_KEY 就跳过这一路，直接走对话模型。
          // 不算错误，只是这条可选路径不可用。
          freeError = '未配置免费通道密钥（设置环境变量 DSH_FREE_CHANNEL_API_KEY 后重启 DSH）'
        } else {
          const free = await tryFreeChannel(system, input, abort)
          if (free.ok === true) return { text: free.text, usedFree: true }
          freeError = free.message
        }
      }

      const route = resolveRoute(sessionId, agent)
      if (route === undefined) {
        throw new Error(freeError
          ? `免费通道不可用（${freeError}），且取不到当前对话的模型`
          : '取不到可用模型。请到「设置 → 优化」选择模型，或先在「设置 → 模型」里选一个。')
      }

      hooks?.onStart?.({
        provider: route.provider,
        model: route.model,
        style: current.style,
        source: route.source,
      })

      // signal 传进去，用户点「取消」时这次模型调用会真的停下来。
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        /*
         * 按「思考 + 正文」两部分来定，不是只按正文估。
         *
         * 线上实测：思考 5773 字（outputTokens 3391），正文 52 字 —— 而这里
         * 原本只给 4096。思考花掉 3391 就只剩 700 给正文，思考再长一点正文
         * 就是空串，用户看到「优化完成」却什么都没有。
         *
         * 正文最长是 4000 字（详细档封顶），按中文约 1 字 1 token 估；
         * 思考留 6000；再加 2000 余量。
         */
        maxTokens: 12000,
        signal: abort,
      })
      // 有 hooks 就用 consumeStream：同一路流，一边收一边把累计正文推给界面。
      // 没有 hooks（/optimize、命令、工具、重试）就用 collectText 静默收完。
      const streamed = hooks !== undefined && hooks !== null
        ? await consumeStream(stream, hooks)
        : { text: await collectText(stream), reasoning: '', usage: null }
      const collected = streamed.text.trim()
      // 取消发生在流中间时，宿主会把流收成空文本而不是抛错。
      // 这里主动认出来，别让上层把它当成「模型没返回内容」。
      if (collected.length === 0 && abort.aborted === true) {
        throw abortedError()
      }
      return {
        text: collected,
        usedFree: false,
        freeError,
        route,
        reasoning: streamed.reasoning ?? '',
        usage: streamed.usage ?? null,
      }
    }

    /*
     * 把「这次该写多长」直接告诉模型。
     *
     * 不告诉的话它只能猜：线上实测同一个输入三次，分别写出太短、太长、太短，
     * 每次都触发一轮重试，一次优化变成两次模型调用。见 lengthHintFor 的说明。
     */
    const first = await enhanceOnce(
      systemPromptFor(current, sceneContext, {
        source: text,
        styleId: current.style,
        kind: classifyInput(text),
      }),
      text,
      liveHooks,
    )
    let optimized = first.text
    let usedFree = first.usedFree
    if (optimized.length === 0) {
      const error = new Error('模型没有返回内容，请重试')
      error.code = 'EMPTY_OUTPUT'
      throw error
    }

    /*
     * 时间预算：已经花掉多少，还剩多少给补救路径。
     *
     * 补救是锦上添花。模型慢的时候（首字 50 秒那种），把补救也做完就是
     * 两分钟起步。宁可交一份没补救过但能看的结果，也别让用户干等。
     */
    const spentMs = Date.now() - startedAt
    const budgetLeft = OPTIMIZE_BUDGET_MS - spentMs
    /*
     * 还剩多少才算「够再补救一次」：拿第一稿的耗时当估算。
     * 只判 budgetLeft > 0 是不够的 —— 剩 300ms 时放行，重试又要 600ms，
     * 用户照样等满。剩余时间连一次同等耗时的调用都不够，就别开始。
     */
    const budgetEnough = budgetLeft > spentMs

    // 工程兜底：提示词改好了，但仍不排除模型把一句话扩成文档。
    // 判据 —— 短输入配上了远超它的输出：这说明改写方向跑偏了。
    // 此时改用最克制的「精简」档重试一次；取更短的结果，避免把噪声交给用户。
    let recovered = false
    if (!budgetEnough) {
      // 预算不够再补救一次，一条都不走。
    } else if (looksOverExpanded(text, optimized)) {
      // 先说清楚要重写，界面才不会「字停住了、然后整段变掉」。
      liveHooks?.onRevise?.({
        reason: 'recovered',
        text: '生成时把一句话扩成了文档，正在拉回克制写法…',
      })
      const briefPrompt = renderPrompt(STYLE_ITEMS.find((item) => item.id === 'brief'), sceneContext)
      const retry = await enhanceOnce(briefPrompt, text)
      if (retry.text.length > 0 && retry.text.length < optimized.length) {
        optimized = retry.text
        recovered = true
        usedFree = retry.usedFree
        finalRoute = retry
      }
    }

    // 档位复核：输出必须守住当前档位的长度与内容下限。
    //   - 超长（详细档冗余、精简档被加码）→ 带着「删到上限内」的指令重试；
    //   - 过短（均衡/详细档只改了措辞）→ 带着「补出产出与验收」的指令重试。
    // 重试仍用当前档位，不换档 —— 用户选的就是这一档。
    let adjusted = null
    const activeStyle = current.style
    const violation = bandViolation(activeStyle, text, optimized)
    // 预算不够就不复核了：见 OPTIMIZE_BUDGET_MS 的说明。
    if (violation !== null && activeStyle !== 'custom' && budgetEnough) {
      liveHooks?.onRevise?.({
        reason: violation.startsWith('too-long')
          ? 'trimmed'
          : (violation === 'unchanged' ? 'unchanged' : 'expanded'),
        text: violation.startsWith('too-long')
          ? '超出这一档的长度上限，正在重新收敛…'
          : (violation === 'unchanged'
            ? '模型原样返回了，正在重新改写…'
            : '这一档要求补出产出与验收，正在补齐…'),
      })
      const corrected = await enhanceOnce(
        correctionPromptFor(activeStyle, text, optimized, violation, sceneContext),
        text,
      )
      if (corrected.text.length > 0) {
        const stillBad = bandViolation(activeStyle, text, corrected.text)
        /*
         * 只接受**真的往合格方向走**的结果。
         *
         * 判据按「这一稿本身落在哪」分，不是按「比上一稿长还是短」：
         *
         *   重试稿合格（stillBad === null）  → 收下
         *   仍超长、但比上一稿短             → 收下（同一方向上确实在收敛）
         *   从超长变成过短                   → **不收**
         *   从过短变成超长                   → **不收**
         *
         * 后两条是这次补的。早先只看「比上一稿短」就收，于是首稿超长、
         * 重试删过头变成过短时，也被记成 trimmed —— 用户拿到的是被删空的原稿，
         * 还标着「已按档位上限收敛」。**越过整个区间不是收敛。**
         *
         * 上一条（过短 → 超长）是上一版为「13 字提问被补成 93 字」补的，这里一并留下。
         */
        const overshoot = stillBad !== null && stillBad.startsWith('too-long')
        const undershoot = stillBad !== null && stillBad.startsWith('too-short')
        const better = stillBad === null
          || (violation.startsWith('too-long')
            && !undershoot
            && corrected.text.length < optimized.length)
          || (violation.startsWith('too-short')
            && !overshoot
            && corrected.text.length > optimized.length)
        if (better) {
          optimized = corrected.text
          usedFree = corrected.usedFree
          finalRoute = corrected
          adjusted = violation.startsWith('too-long') ? 'trimmed' : 'expanded'
        }
      }
    }

    /*
     * 收尾补推一帧：补救换过稿时，最后一帧 delta 还停在旧稿上。
     * 补推之后，界面按顺序收到「旧稿 → revise → 新稿」，最后一帧就是最终稿。
     */
    if (liveHooks !== undefined && liveHooks !== null && optimized !== lastStreamed) {
      liveHooks.onText(optimized)
      lastStreamed = optimized
    }

    // 回执里的 provider/model 必须来自**真正产出这份正文**的那一轮：
    // 补救可能换了路由或走了免费通道，仍报第一次的就会误导读设置页的人。
    const finalRouteInfo = finalRoute ?? first
    const provider = usedFree ? 'free-channel' : (finalRouteInfo.route?.provider ?? 'unknown')
    const model = usedFree ? FREE_CHANNEL.model : (finalRouteInfo.route?.model ?? 'unknown')
    const source = usedFree ? 'free' : (finalRouteInfo.route?.source ?? 'session')

    // 记录本次真实使用的路由，供设置页核实。
    lastUsed = {
      provider,
      model,
      source,
      style: activeStyle,
      freeError: first.freeError,
      at: Date.now(),
    }

    /*
     * 模型两次都原样返回时，如实标出来。
     *
     * 用户点「优化」等了几秒，拿回自己的原话 —— 界面必须说明白「这次没改成」，
     * 而不是让他以为这就是优化结果。判据用 sameContent，只差标点也算没改。
     */
    const unchanged = classifyInput(text) === 'c' && sameContent(text, optimized)

    return {
      ok: true,
      text: optimized,
      provider,
      model,
      style: activeStyle,
      source,
      recovered,
      adjusted,
      unchanged,
      // 思考过程与用量只来自第一次尝试：重试用的是另一段对话，混进来会更乱。
      reasoning: first.reasoning.length > 0 ? first.reasoning : null,
      usage: first.usage,
      elapsedMs: Date.now() - startedAt,
      freeChannel: {
        enabled: current.modelMode === 'free',
        used: usedFree,
        error: first.freeError ?? null,
      },
    }
  }

  /** 把优化回执拼成一段给人看的文字（斜杠命令用）。 */
  function describeResult(result) {
    const lines = [
      result.text,
      '',
      '---',
      `档位：${result.style} · 模型：${result.provider}/${result.model}`,
    ]
    if (result.adjusted === 'trimmed') lines.push('已按档位上限收敛')
    else if (result.adjusted === 'expanded') lines.push('已补齐到档位下限')
    if (result.recovered === true) lines.push('已从过度扩写中拉回')
    return lines.join('\n')
  }

  // ── 设置读写 ────────────────────────────────────────────────────────────

  // 路由必须在插件停止时被撤销：webServer.register 返回的撤销函数要交给
  // ctx.effect 收集，否则插件被替换/停止后旧路由还留在表里，
  // 新实例再注册同一条路径会抛 "webserver: duplicate exact route"，
  // 导致新代码永远加载不上（这正是 host 半区热替换失败的原因）。
  ctx.effect(() => registerRoute(ctx, {
    kind: 'exact',
    path: '/dsh-prompt-optimizer/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = JSON.parse((await readBody(req)) || '{}')
          settings = normalizeSettings({ ...settings, ...body })
          const saved = saveSettings()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, saved, settings, styles: STYLE_ITEMS }))
          return
        }

        const models = await listAllModels()

        // 设置页带上当前会话 id 时，就能算出「自动模式此刻会真正调用哪个模型」。
        // 这个值由代码推导（读 agent/request 记录与配置），**不是模型自述**，
        // 因此可以用来核实路由，而不受模型"自称 GPT"这类训练数据错觉的影响。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const knownSession = sessionId.length > 0 && routeBySession.has(sessionId)

        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: true,
          settings,
          styles: STYLE_ITEMS,
          models,
          resolved: resolveRoute(sessionId, undefined),
          hasSession: sessionId.length > 0,
          sessionKnown: knownSession,
          lastUsed,
          // 免费通道的展示信息（不返回 API Key）
          freeChannel: {
            model: FREE_CHANNEL.model,
            baseURL: FREE_CHANNEL.baseURL,
            // 密钥是用户自己配的。源码里不再内置任何凭据，
            // 这个字段恒为 false，保留只为界面旧回退路径的形状不变。
            usingBuiltinKey: FREE_CHANNEL.usingBuiltinKey,
            // 'ok' | 'degraded'（临时故障）| 'unavailable'（密钥无效等确定性问题）| 'unknown'
            status: freeChannelState.status,
            kind: freeChannelState.kind,
            message: freeChannelState.message,
          },
        }))
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    },
  }))

  // ── 免费通道连通性测试 ──────────────────────────────────────────────────
  //
  // 发一句 "Hi"，看能不能收到回应。设置页每次打开会先跑一次，
  // 用户也可以点「重新测试」手动触发 —— 这样"免费通道到底通不通"是可见的，
  // 而不是等按下优化按钮才发现。
  //
  // 判定为「密钥无效」后不再自动重试：那个端点每次都会返回同一个 401，
  // 反复去撞只会拖慢每次打开设置页。用户手动点「重新测试」仍然会真去试一次。
  ctx.effect(() => registerRoute(ctx, {
    kind: 'exact',
    path: '/dsh-prompt-optimizer/free-channel/test',
    handler: async (req, res) => {
      const started = Date.now()
      const forced = req?.url !== undefined
        && new URL(req.url, 'http://localhost').searchParams.get('force') === '1'
      // 源码不带凭据：没设环境变量就没什么可测的，直接说清楚要配哪个变量。
      if (FREE_CHANNEL.apiKey.length === 0) {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: false,
          ms: Date.now() - started,
          model: FREE_CHANNEL.model,
          error: '未配置免费通道密钥：设置环境变量 DSH_FREE_CHANNEL_API_KEY 后重启 DSH',
          kind: 'no-key',
          cached: false,
          canRetry: true,
        }))
        return
      }
      // 已判定不可用（多半是密钥无效）且不是用户强制重试 → 直接回缓存结论，不去撞端点。
      if (!forced && freeChannelState.status === 'unavailable' && freeChannelState.kind === 'auth') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: false,
          ms: Date.now() - started,
          model: FREE_CHANNEL.model,
          error: freeChannelState.message,
          kind: freeChannelState.kind,
          cached: true,
          canRetry: true,
        }))
        return
      }
      const result = await tryFreeChannel(
        '你是一个连通性测试助手。用一句话回复即可，不要展开。',
        'Hi',
      )
      const elapsed = Date.now() - started
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({
        ok: result.ok === true,
        ms: elapsed,
        reply: result.ok === true ? result.text.slice(0, 120) : undefined,
        model: FREE_CHANNEL.model,
        error: result.ok === true ? null : result.message,
        kind: result.ok === true ? null : result.kind,
        cached: false,
        canRetry: true,
      }))
    },
  }))

  // ── 优化 ────────────────────────────────────────────────────────────────

  ctx.effect(() => registerRoute(ctx, {
    kind: 'exact',
    path: '/dsh-prompt-optimizer/optimize',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '只支持 POST' }))
          return
        }

        const parsed = JSON.parse((await readBody(req)) || '{}')
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
        if (text.length === 0) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'EMPTY_INPUT', error: '输入为空，没有可优化的内容' }))
          return
        }
        if (text.length > MAX_INPUT_CHARS) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: false,
            code: 'TOO_LONG',
            error: `内容过长（${text.length} 字符），请精简到 ${MAX_INPUT_CHARS} 以内`,
          }))
          return
        }

        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        // requestId 是客户端给的：取消时凭它找到同一个任务。
        const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''

        // 同一个 requestId 只允许一个任务在跑：重复点不会发出两次请求。
        if (requestId.length > 0 && activeJobs.has(requestId)) {
          res.writeHead(409, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '这个优化请求已经在跑了' }))
          return
        }

        const controller = new AbortController()
        if (requestId.length > 0) activeJobs.set(requestId, controller)
        const done = () => {
          if (requestId.length > 0) activeJobs.delete(requestId)
        }
        try {
          // 路由只负责 HTTP 语义（状态码、取消、requestId 回收），
          // 改写本身全在 optimizeText() 里 —— 斜杠命令、工具、服务共用同一份。
          const result = await optimizeText({ text, sessionId, signal: controller.signal })
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(result))
        } catch (error) {
          // 用户点了取消：这不是失败，别弹红色报错。
          if (controller.signal.aborted === true || error?.aborted === true) {
            res.writeHead(499, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, aborted: true, code: 'ABORTED', error: '已取消' }))
            return
          }
          // 回执里必须带错误码：只有中文文案的话，调用方一改文案就判断不了了。
          const errorCode = errorCodeOf(error)
          const status = httpStatusOf(errorCode)
          res.writeHead(status, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: false,
            code: errorCode,
            error: status === 500
              ? `优化失败：${String(error?.message ?? error)}`
              : String(error?.message ?? error),
          }))
        } finally {
          // 任务结束就把 requestId 从表里摘掉，否则取消会找不到它。
          done()
        }
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: false,
          code: errorCodeOf(error),
          error: `优化失败：${String(error?.message ?? error)}`,
        }))
      }
    },
  }))

  // ── 流式优化 ────────────────────────────────────────────────────────────
  //
  // 与 /optimize 做同一件事，区别是边收边推：
  //   event: start    —— 拿到路由信息（provider/model/档位）
  //   event: delta    —— 累积到的正文（客户端整段替换，不用自己拼）
  //   event: reasoning—— 模型的思考过程（模型不给就没有这一条）
  //   event: revise   —— 要整段换稿了，附带原因（收敛 / 补齐 / 拉回）
  //   event: done     —— 最终结果 + 用量 + 用时
  //   event: error    —— 出错了
  // 这样用户点下按钮就能看见字在长，而不是对着一个空转的按钮等。
  ctx.effect(() => registerRoute(ctx, {
    kind: 'exact',
    path: '/dsh-prompt-optimizer/stream',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '只支持 POST' }))
          return
        }

        const parsed = JSON.parse((await readBody(req)) || '{}')
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
        if (text.length === 0) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'EMPTY_INPUT', error: '输入为空，没有可优化的内容' }))
          return
        }
        if (text.length > MAX_INPUT_CHARS) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: false,
            code: 'TOO_LONG',
            error: `内容过长（${text.length} 字符），请精简到 ${MAX_INPUT_CHARS} 以内`,
          }))
          return
        }

        const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
        const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''
        if (requestId.length > 0 && activeJobs.has(requestId)) {
          res.writeHead(409, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'IN_FLIGHT', error: '这个优化请求已经在跑了' }))
          return
        }

        const controller = new AbortController()
        if (requestId.length > 0) activeJobs.set(requestId, controller)
        const done = () => {
          if (requestId.length > 0) activeJobs.delete(requestId)
        }
        // 响应头一发出去就不能再改状态码，所以校验都在写头之前做完。
        // 路由是否可用交给 optimizeText 判断：它会在流里回报错误事件，
        // 这样「取不到模型」和「模型跑挂了」走同一条通道，客户端只需处理一种。
        res.writeHead(200, SSE_HEADERS)

        try {
          // 关键：这里调的是**同一个** optimizeText，不是另抄一份流式实现。
          // 六个入口（按钮 / 会话头 / Alt+O / 斜杠命令 / 工具 / 服务）必须
          // 产出同一份结果 —— 档位复核、过度扩写兜底、免费通道回退都在它里面。
          // 早先这里自己拼了一遍 ctx.llm.stream，于是客户端走的主路径
          // 反而绕过了全部保护，成了「explain 档位有时不生效」的根因。
          const result = await optimizeText({
            text,
            sessionId,
            signal: controller.signal,
            hooks: {
              onStart: (info) => writeEvent(res, 'start', info),
              onText: (value) => writeEvent(res, 'delta', { text: value }),
              onReasoning: (value) => writeEvent(res, 'reasoning', { text: value }),
              // 换稿前先报一声：客户端据此把「生成中…」换成具体原因，
              // 用户就不会觉得结果是自己变掉的。
              onRevise: (info) => writeEvent(res, 'revise', info),
            },
          })
          writeEvent(res, 'done', result)
          res.end()
        } catch (error) {
          if (controller.signal.aborted === true || error?.aborted === true) {
            writeEvent(res, 'aborted', { error: '已取消' })
          } else {
            // 错误码同样要带出去：流式入口是客户端的主路径，
            // 只靠中文文案判断失败原因不可维护。
            writeEvent(res, 'error', {
              code: errorCodeOf(error),
              error: `优化失败：${String(error?.message ?? error)}`,
            })
          }
          res.end()
        } finally {
          done()
        }
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: false,
          error: `优化失败：${String(error?.message ?? error)}`,
        }))
      }
    },
  }))

  // ── 取消 ────────────────────────────────────────────────────────────────
  // 客户端在按钮上点「取消」时打这个接口：凭 requestId 找到同一个任务并中止。
  ctx.effect(() => registerRoute(ctx, {
    kind: 'exact',
    path: '/dsh-prompt-optimizer/abort',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '只支持 POST' }))
          return
        }

        const parsed = JSON.parse((await readBody(req)) || '{}')
        const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : ''
        if (requestId.length === 0) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '缺少 requestId' }))
          return
        }

        const controller = activeJobs.get(requestId)
        if (!controller) {
          // 任务已经结束或从没跑起来：不算失败，告诉客户端「已经不在跑了」。
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, aborted: false }))
          return
        }

        controller.abort()
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, aborted: true }))
      } catch (error) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({
          ok: false,
          error: `取消失败：${String(error?.message ?? error)}`,
        }))
      }
    },
  }))

  // ── 其他入口 ────────────────────────────────────────────────────────────
  //
  // 优化这件事现在有六个入口，全部收敛到上面的 optimizeText()：
  //   客户端：输入框按钮 / 会话头按钮 / Alt+O（这三个走 HTTP 路由）
  //   宿主侧：/optimize 斜杠命令、optimize_prompt 工具、promptOptimizer 服务
  //
  // 为什么宿主侧也要有：按钮只活在浏览器里。脚本调不到它，别的插件调不到它，
  // 模型自己也调不到它。命令给人和脚本用，工具给模型用，服务给插件用 ——
  // 三者共用同一条实现，所以从哪个入口进来结果都一样。

  /**
   * 斜杠命令 `/optimize <文字>`。
   *
   * 结果作为命令回执显示在对话里，不往输入框写：宿主半区拿不到输入框
   * （那是客户端状态）。想让结果进输入框，用按钮或 Alt+O —— 它们在客户端。
   *
   * 用 ctx.inject 而不是写进 inject 数组：命令服务是可选的。
   * 没有它（无 UI 的演示主干、ACP 自动化）时插件其余部分照常工作。
   */
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      definitionId: 'dsh-prompt-optimizer/optimize',
      name: 'optimize',
      description: '把一段话改写成 DeepSeek Harness 能直接照做的提示词',
      input: { hint: '[要改写的文字]' },
      handler: async (invocation) => {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        if (raw.length === 0) {
          return {
            kind: 'error',
            text: '用法：/optimize <要改写的文字>。'
              + '也可以直接在输入框里写内容，再按 Alt+O 或点「优化」按钮 —— 那两条路会把结果放回输入框。',
          }
        }
        try {
          const result = await optimizeText({
            text: raw,
            agent: invocation?.agent,
            signal: invocation?.signal,
          })
          return { kind: 'success', text: describeResult(result) }
        } catch (error) {
          if (error?.aborted === true || invocation?.signal?.aborted === true) {
            return { kind: 'error', text: '已取消' }
          }
          return { kind: 'error', text: `优化失败：${String(error?.message ?? error)}` }
        }
      },
    }), 'dsh-prompt-optimizer: /optimize command')
  })

  /**
   * 工具 `optimize_prompt`。
   *
   * 和命令的区别：命令由人敲，工具由模型调。模型看见用户写得很含糊时，
   * 可以主动问一句「要不要我把它改写得更具体」，然后调这个工具。
   *
   * 手写 definition 而不是 import defineTool：dsh-tools 只在 asar 里，
   * 没被提升到 profile 的 node_modules，插件目录 import 不到。
   * 所以 parameters 必须是**原始 JSON Schema**（defineTool 的 DSL 在这里不会被编译）。
   */
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'optimize_prompt',
      description: '把一段文字改写成 DeepSeek Harness（DSH）能直接照做的提示词：'
        + '补出产出形式、验收口径和必要的约束，但不改变用户的原意。'
        + '只在用户明确要求「把这句话写清楚/写具体/改写一下」时调用；'
        + '它只改写文字，不执行文字里要求的任务。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要改写的原文，最多 20000 字',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '改写后的提示词正文' },
            style: { type: 'string', description: '实际使用的档位：brief / balanced / detailed / custom' },
            provider: { type: 'string', description: '实际调用的 provider' },
            model: { type: 'string', description: '实际调用的模型' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const result = await optimizeText({
          text: typeof args?.text === 'string' ? args.text : '',
          agent: exec?.agent,
          signal: exec?.signal,
        })
        return {
          text: result.text,
          style: result.style,
          provider: result.provider,
          model: result.model,
        }
      },
    }), 'dsh-prompt-optimizer: optimize_prompt tool')
  })

  /**
   * 服务 `promptOptimizer`。
   *
   * 为什么还要一个服务：工具只能被模型调用，而别的插件需要的是
   * 「我在自己的代码里调一次优化」。服务把这件事变成一次函数调用。
   *
   * 注册失败只记一条日志：服务名冲突不该让整个插件停摆，
   * 按钮和命令不依赖它。
   */
  try {
    ctx.provide('promptOptimizer', {
      /** 接口版本：别的插件可以据此判断字段有没有变。 */
      version: 1,
      /** 三档风格（不含提示词正文 —— 那是实现细节）。 */
      styles: () => STYLE_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        summary: item.summary,
        band: item.band,
        bandBadge: item.bandBadge,
        scope: item.scope,
        forbid: item.forbid,
      })),
      /** 当前设置的只读快照。 */
      settings: () => ({ ...settings }),
      /** 优化一段文字，参数与 optimizeText 一致。 */
      optimize: (text, options) => optimizeText({ ...options, text }),
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-prompt-optimizer: 注册 promptOptimizer 服务失败（${String(error?.message ?? error)}）`)
  }
}

export {
  STYLE_ITEMS,
  DEFAULT_SETTINGS,
  // 提示词工具链要用的：模板（带占位符）、公共规则、渲染器。
  // dev/dump-prompts.mjs 导出它们，dev/apply-prompts.mjs 写回它们。
  SCENE_TEMPLATE,
  COMMON,
  STATIC_SCENE_CONTEXT,
  renderPrompt,
  dshScene,
  describeEnvironment,
  // 输入分类（a 寒暄 / b 提问 / c 任务）。导出是给 dev/test-input-kind.cjs 用的：
  // 判据的回归测试要能直接钉住分类结果，而不是隔着「重试了几次」去猜。
  classifyInput,
}
