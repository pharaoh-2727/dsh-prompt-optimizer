# 架构

两个文件，一分为二：**宿主半区**（Node，`index.js`）与**客户端半区**（浏览器，`client.js`）。
它们通过五条 HTTP 路由通信，没有别的耦合。

```
浏览器                                  Node（DSH 宿主）
┌───────────────────────────┐          ┌──────────────────────────────────┐
│ client.js                 │  fetch   │ index.js                         │
│  ✨ 输入框按钮            │ ───────► │  /dsh-prompt-optimizer/stream    │
│  ✨ 会话标题按钮          │  SSE     │  /dsh-prompt-optimizer/optimize  │
│  Alt+O 快捷键             │ ◄─────── │  /dsh-prompt-optimizer/abort     │
│  预览卡 / 历史 / 对比     │          │  /dsh-prompt-optimizer/settings  │
│  设置页                   │          │  /dsh-prompt-optimizer/free-...  │
└───────────────────────────┘          │                                  │
                                       │  optimizeText()  ← 唯一的改写引擎 │
                                       │    ↑         ↑         ↑         │
                                       │  /optimize  tool    service      │
                                       └──────────────────────────────────┘
```

## 一条主线：六个入口收敛到 optimizeText()

这是整个插件最重要的一条约束：

```js
// index.js:1045
async function optimizeText({ text, sessionId, agent, signal, hooks })
  → { ok, text, provider, model, style, source, recovered, adjusted, freeChannel }
```

六个入口全部走它：

| 入口 | 注册位置 | 与引擎的关系 |
|---|---|---|
| 输入框按钮 / 标题按钮 / Alt+O | `client.js` → HTTP | 打 `/stream` |
| `/optimize <文字>` | `index.js:1748` `ctx.inject(['commands'])` | 直接调 `optimizeText()` |
| `optimize_prompt` 工具 | `index.js:1790` `ctx.inject(['tools'])` | 直接调 `optimizeText()` |
| `promptOptimizer` 服务 | `index.js:1848` `ctx.provide()` | 直接调 `optimizeText()` |

为什么必须收敛：`/stream` 曾经自己拼了一遍 `ctx.llm.stream`，绕过了档位复核和免费通道回退，
于是「客户端路径」和「命令路径」对同一输入给出不同结果。`dev/test-stream-parity.cjs` 专门钉住这一点。

## 提示词怎么组装

三档的提示词 = 档位规则 + 场景约定 + 公共规则，拼装在 `renderPrompt(item, context)` 内完成。

**场景约定带两个运行时占位符**，由 `dshScene(context)` 在每次调用时填：

| 占位符 | 值从哪来 | 拿不到时 |
|---|---|---|
| `{{workspace}}` | 宿主 `workingDirectory.get(session)` → 会话 header 的 `cwd` → `workingDirectory.defaultDirectory` | 那一行整行删掉，**不编造路径** |
| `{{environment}}` | `describeEnvironment()` 按 `process.platform` 生成 | 永远有值，不用兜底 |

早先场景约定是一段常量，第 1 条说「相对路径相对工作区根目录解析」但代码从不读工作区，
第 5 条写死「本机是 Windows，终端是 PowerShell」换台 Linux 也照说。`dev/test-scene-context.cjs` 钉住现在的行为。

`STYLE_ITEMS[i].prompt` 是 getter，返回**静态渲染**（没有会话上下文）——
设置页显示的就是它，与实际发给模型的那份同源，只差工作区那一行。

## 错误码

回执里的 `code` 是稳定契约，`error` 文案随时可改。两条路都带：

| code | HTTP | 含义 |
|---|---|---|
| `EMPTY_INPUT` | 400 | 空或全空白 |
| `TOO_LONG` | 400 | 超过 20000 字符 |
| `EMPTY_OUTPUT` | 502 | 模型没吐正文 |
| `ABORTED` | 499 | 用户取消 |
| `IN_FLIGHT` | 409 | 同一 requestId 已在跑 |
| `UNKNOWN` | 500 | 其它 |

前置校验（空、超长）发生在开流之前，走 HTTP + JSON；生成中途失败才推 `error` 事件。
客户端把 code 挂在异常上，判断不依赖中文文案。

## 改写引擎内部

```
optimizeText(text)
  │
  ├─ 1. 校验：空 → EMPTY_INPUT；> 20000 字符 → TOO_LONG
  ├─ 2. 解析路由：resolveRoute(sessionId, agent)
  │      manual → 设置里的模型
  │      auto   → 会话实际路由 → agent.requestContext → agent.options
  │               → agentDefaultModel.currentSelection() → profile patch
  ├─ 3. 取系统提示词：systemPromptFor(settings.style)
  ├─ 4. 尝试免费通道（若 modelMode === 'free' 且配了密钥）
  │      失败 → 记下原因，继续走对话模型（不致命）
  ├─ 5. 调模型：ctx.llm.stream({ system, messages, signal })
  ├─ 6. 档位复核：bandViolation() → 超长/过短 → correctionPromptFor() 重试一次
  │      重试**始终用用户选的那一档**，不偷偷换档
  │      「过短」只对 c) 类任务判定，判据来自 classifyInput()：
  │      要碰工作区才算任务（见下节）。提问不设内容下限 ——
  │      引擎逼模型给提问补产出，模型只能编造
  ├─ 7. 失控兜底：短输入配了远超的输出 → 改用精简档重试一次
  └─ 8. 返回 { text, adjusted, freeChannel, ... }
```

### 三档的长度公式

```js
// index.js:245
const STYLE_BANDS = {
  brief:    { ratioMax: 1.15, plusChars: 10,  absMax: 1500 },
  balanced: { ratioMax: 1.6,  plusChars: 80,  absMax: 2500 },
  detailed: { ratioMax: 2.2,  plusChars: 150, absMax: 4000 },
}
// 上限 = min(absMax, max(len × ratioMax, len + plusChars))
```

这三个常量必须与四处保持一致：各档 `prompt` 里写的「长度上限」与封顶字数、`dev/prompts/tiers.json` 的 `band`、
以及 `STYLE_ITEMS` 的 `band` 文案。`dev/test-bands.cjs` 与 `dev/test-band-ceiling.cjs` 会替你检查。

### 输入分类（a / b / c）

`classifyInput()`（`index.js:663`）决定「这段输入要不要补产出」，进而决定要不要给它套内容下限。

判据不是新发明的，是提示词里写好的那条（`dev/prompts/shared-common.txt` 第 17 行）：
**要碰工作区才算 c) 类任务**，只有不需要接触工作区的纯知识问答才是 b)。

所以它找的是指向工作区的**字面信号**——路径、文件名、反引号里的命令、报错原文、
工作区名词配动作动词——而不是「句子里有没有动词」。判定顺序不能调换：

1. 工作区字面信号 → c)（带路径/命令/报错的，哪怕写成疑问句也是任务）
2. 请求词（帮我/给我/麻烦）→ c)
3. 工作区名词 + 动作动词 → c)
4. 疑问句式 → b)　**必须在第 5 条之前**：「怎么改」里的「改」是疑问的宾语
5. 有动作动词 → c)
6. 其余 → a)

早先这里是一张上百词的正则表，把 `如何|怎么|为什么|配置|插件|解释|分析` 都算任务信号，
于是**所有中文疑问句都被判成 c)**，接着被套上内容下限 —— 均衡档下 13 字的
「怎么配置 profile？」下限 47 字，而提示词自己给的正例只有 38 字：照提示词写反而判不合格。

**判不准时偏 b)**（不设下限）。这和提示词里「拿不准时按 c)」方向相反，是有意的：
模型按 c) 多写一句，用户删掉即可；引擎按 c) 会强制重试并命令模型「至少写 N 字」，模型只能编造。

`dev/test-input-kind.cjs` 用 36 条语料钉住判据，其中 b 类 11 条全是旧词表误判过的疑问句。

**封顶必须写进提示词。** 三档的倍数上限在长输入上会超过 `absMax`（例如原文 3960 字，
详细档 2.2 倍算出 8712 字，实际封顶只有 4000）。提示词若不写封顶，模型会照着倍数写，
然后被判超长反复重试。

## HTTP 路由

五条路由全部经 `ctx.effect(() => registerRoute(ctx, route))` 注册 —— fiber 停止时撤销函数自动执行，
路由从宿主表里摘掉。不这么做的话，热替换时新实例会撞上 `webserver: duplicate exact route`，
插件被标成 stopped，表现为「代码改了但怎么刷新都不生效」。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-prompt-optimizer/settings` | 设置、力度预设、可用模型列表、当前解析路由、上次实际调用 |
| POST / PUT | `/dsh-prompt-optimizer/settings` | 保存设置 |
| GET | `/dsh-prompt-optimizer/free-channel/test` | 免费通道探测；`?force=1` 跳过缓存 |
| POST | `/dsh-prompt-optimizer/stream` | 流式改写（SSE） |
| POST | `/dsh-prompt-optimizer/optimize` | 一次性改写（流式不可用时的退路） |
| POST | `/dsh-prompt-optimizer/abort` | 取消，body `{ requestId }` |

### 流式怎么做的

`/stream` 用 `text/event-stream` 响应。宿主的 webServer 把 node 的 `req`/`res` 直接交给插件 handler，
而且对 `text/event-stream` **不做 gzip 压缩**，所以长连接不会被缓冲住。

- 推的正文是**当前累计文本**（不是增量），客户端整段替换即可
- 模型一秒能吐几十块 token，全推会给界面疯狂重绘，所以攒 40ms 再推一次，最后一定补推一次完整的
- 事件：`start` / `reasoning` / `delta` / `revise` / `done`（带 `usage`、`elapsedMs`、`reasoning`）/ `error` / `aborted`
- 中途取消收到 `aborted` 而非 `error`，客户端据此静默收场

### 思考过程与正文是两条通道

实测一次优化能推 350–710 帧 `reasoning`（几百到几千字），而正文只有十几到一百多字。
所以客户端对思考做了三件事（见 `client.js` 的 `stripReasoning()` 与预览卡）：

1. **正文里剥掉混进来的思考**。不是所有模型都规规矩矩只走 `reasoning` 通道，
   有的把「这一步该怎么做」一起塞进正文。剥的判据很保守：只认**与 reasoning 整行相同、
   且长度 ≥ 8 字**的行 —— 提示词里出现和思考相似的词很正常，删错比留着更糟。
   剥在**状态层**（流式 `onText`、收尾 `set`、`pushHistory`），不只是渲染层：
   「复制」和「替换草稿」拿的是 `previewStore.state.result`，只剥渲染会漏。
2. **思考块默认收起**，只留一行「思考过程 · N 字」，点标题展开。
   展开着摆的话，卡片里是「一大坨草稿纸 + 一小段结果」，用户分不清哪一版是要用的。
3. **预览卡只显示在发起它的会话里**。`previewStore` 是模块级单例，一个标签页只有一份；
   界面里却能同时开着好几个对话，不按 `ownerSessionId` 过滤就会串到别的对话去。

另外：用户点「放弃」时 `phase` 被打回 `idle`，但 `requestId` 不变 —— 所以收尾时
用「phase 还是不是 running」判断这次结果是否已被用户关掉，而不是用 `requestId`。

**只有第一次尝试是逐字流的。** 后面两次补救 —— 过度扩写拉回、档位收敛/补齐 ——
是整段换稿，所以它们开工前先推一条 `revise`（`{reason, text}`），说明"为什么要重写"；
`optimizeText` 收尾时再补推一帧最终正文。两条合起来保证一件事：

> 界面收到的**最后一帧 `delta` 永远等于 `done.text`**，客户端不会在 `done` 里凭空空降一份新结果。

`revise` 的 `reason` 取值 `trimmed` / `expanded` / `recovered`，`text` 是一句给人看的话
（例："超出这一档的长度上限，正在重新收敛…"）。客户端把它显示在预览卡的标题行上，
替代原来的"生成中…"，于是"结果换掉了"这件事有了交代。

### 取消怎么做的

每次改写分配一个 `requestId`，对应的 `AbortController` 放进 `activeJobs` 表。

- `ctx.llm.stream({ ..., signal })` 收到这个 signal —— DSH 的 llm 服务会把 signal 一路传到适配器，
  中断时返回 `reason.kind === 'aborted'` 的结束块，**底层网络请求是真断开的**
- 免费通道走 `fetch`，`callFreeChannel` 额外挂了 abort 监听，把取消同步转给内部超时控制器
- `/abort` 按 `requestId` 找 controller 并 `abort()`；同一个 `requestId` 重复提交时返回 409

## 客户端半区

`client.js` 是一个 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 模块，
在浏览器里注册这些贡献点：

| 槽位 / 能力 | 注册位置 | 内容 |
|---|---|---|
| `conversation.input.right` | `client.js:3567` | 输入框右侧的 ✨ 按钮 |
| `conversation.input.dock` | `client.js:3575` | 预览卡槽位 |
| `conversation.session.header.actions` | `client.js:3583` | 会话标题旁的 ✨（order 5） |
| `settings.section` | `client.js:3596` | 设置页「优化」一节 |
| `shell.overlay` | `client.js:3603` | 全局浮层 |
| `document` keydown | `client.js:3591` `ctx.effect(() => installShortcut(ctx))` | Alt+O |
| `ctx.commandUi.decorate` | `client.js:2041` | 裸 `/optimize` 跑在草稿上 |

### 为什么 Alt+O 自己挂 document

宿主有 `ctx.shortcuts.register()`，但 Web 端的 `isWebBindingAllowed` 只放行「三个以上修饰键」
或 `primary+alt/shift` 这类组合 —— 纯 Alt+O 会被判成 unsupported 直接抛错。
所以自己挂 `document` 的 keydown，用 `ctx.effect` 管生命周期（插件停止时自动摘掉）。

### 为什么浏览器端命令要「宿主 + 装饰」

`ctx.commands.register()` 注册的是**宿主命令**；客户端同名 `register` 会抛
`ui-commands: contribution /x collides with a host command`。
唯一合法的组合是：宿主注册命令（让 `/optimize 文字` 能跑），客户端用 `commandUi.decorate`
接管**裸调用**（让它能读输入框草稿，这是命令 handler 拿不到的）。

## 状态放在哪

| 状态 | 位置 | 说明 |
|---|---|---|
| 设置（档位、模型、自定义提示词） | `~/.dsh/prompt-optimizer/settings.json` | 宿主读写，跨会话有效 |
| 会话实际路由 | 内存 `routeBySession` Map | 由 `agent/request` 事件填充，`agent/disposed` 时清理 |
| 进行中的请求 | 内存 `activeJobs` Map | `requestId → AbortController` |
| 预览卡尺寸 | localStorage `dsho.preview.body-height` / `body-width` | 只在本浏览器有效 |
| 历史版本 | localStorage `dsho.preview.history` | 最多 20 条，写不进去时自动砍半 |
| 免费通道失败缓存 | 内存 | `auth` 判定为死之后不再反复请求 |

## 目录

```
.
├── index.js            宿主半区（~2000 行）
├── client.js           客户端半区（~3800 行）
├── cordis.patch.yml    bundle patch：声明插件的 id 与包名
├── package.json        版本、exports、dsh 元数据
├── dev/
│   ├── run-all.cjs         一键跑全部测试
│   ├── stub-model.cjs      测试用的默认模型桩
│   ├── smoke-host.cjs      宿主半区冒烟
│   ├── test-*.cjs          14 套行为测试
│   ├── dump-prompts.mjs    index.js → prompts/*.txt
│   ├── apply-prompts.mjs   prompts/*.txt → index.js
│   └── prompts/            三档提示词的可编辑源文件
└── docs/               本目录
```
