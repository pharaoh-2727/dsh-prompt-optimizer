# 开发

## 环境

只需要 Node（DSH 自带的就行）。项目**没有**运行时依赖，也**没有**构建步骤 ——
`index.js` 与 `client.js` 就是最终产物，改动后 `node --check` 通过即可。

```bash
npm run check     # 两个入口文件的语法检查
npm test          # 12 套离线测试，约 6 秒
```

## 测试

`npm test` 跑的是 `dev/run-all.cjs`，它自动发现 `dev/` 下的 `smoke-host.cjs` 与所有 `test-*.cjs`。

| 测试 | 覆盖什么 |
|---|---|
| `smoke-host.cjs` | 模块能 import、路由注册正确、`agent/request` 记路由、设置路由回得合理、命令/工具/服务返回同一份文本 |
| `test-bands.cjs` | 三档长度公式与源码常量一致、三档上限严格递增、每档 prompt 写明了上限 |
| `test-band-correction.cjs` | 超长 → 带修正指令重试（`adjusted='trimmed'`）；过短 → 补写重试（`'expanded'`）；一次到位不重试 |
| `test-free-channel.cjs` | 401 归类为 auth 且不再撞端点、`?force=1` 会真请求、没密钥时 `no-key` 且不发请求、回退到对话模型 |
| `test-stream-parity.cjs` | `/stream` 与 `/optimize` 对同一输入给出相同 text / adjusted / 调用次数；`/stream` 仍推 start/delta/done |
| `test-restore-state.cjs` | 「优化 / 退回」两态状态机 |
| `test-preview-flow.cjs` | 预览卡确认、编辑竞态保护、取消、历史与对比、浮层收起 |
| `test-multi-entry.cjs` | 会话头按钮、Alt+O、裸 `/optimize` 装饰、卸载时快捷键摘掉 |
| `test-result-stability.cjs` | 末次 `delta` 等于 `done.text`；换稿前必有 `revise` 并说明原因；一次写对时不重试 |
| `test-band-ceiling.cjs` | 提示词写的封顶字数与 `STYLE_BANDS.absMax` 一致；`band` 文案也带封顶值 |
| `test-scene-context.cjs` | 场景约定随会话工作区与 `process.platform` 渲染；拿不到工作区时不编造、不留占位符 |
| `test-brute-force.cjs` | 暴力测试：三档 × 13 类输入 × 五个入口，错误路径、异常路径、错误码一致性（210 项） |

### 测试怎么在没有 DSH 的情况下跑

- **宿主半区**：手写一个假的 `ctx`（`on` / `effect` / `webServer.register` / `llm.stream` / `inject` / `provide`），
  然后动态 `import()` 插件并调 `apply(ctx)`。`llm.stream` 是脚本化的 async generator，
  想吐什么就吐什么。
- **客户端半区**：`client.js` 整体喂给 `vm` 沙箱，配一个最小 React 桩（`useState`/`useEffect`/... 七个钩子 + 一个微型渲染器），
  直接渲染 `OptimizeButton` 与 `PreviewCard`，用假 `document` 发事件。

### 测试必须能在别人机器上跑

历史上有两套测试写死了本机绝对路径，还依赖真实 DSH profile 里的默认模型 —— 换台机器就红。

现在：

- 路径全部走 `process.env.DSHO_PLUGIN` / `DSHO_CLIENT`，缺省用 `path.join(__dirname, '..', ...)` 推导
- 临时目录走 `os.tmpdir()`，可用 `DSHO_TMP` 覆盖
- `run-all.cjs` 把 `DSH_HOME` 指向一个空临时目录、并**删掉** `DSH_PROFILE_DIR`；
  需要的默认模型与设置由各测试自己造（`dev/stub-model.cjs` 写一份最小 `cordis.patch.yml`）——
  走的是插件真实的兜底链，源码里没有为测试留后门

**改测试时请守住这条**：新测试不能假设「这台机器上有什么」。判断标准很简单 ——
把 `DSH_HOME` 换成别的空目录、再删掉 `DSH_PROFILE_DIR`，你的测试还该是绿的。

有 CI（`.github/workflows/test.yml`）在 ubuntu 的 Node 20 / 22 上跑同一套 `npm test` ——
「本机绿、CI 红」会当场暴露。这条不是摆设：0.1.0 第一次推送时 `smoke-host` 就是红的，
因为它读真机设置断言档位。

### 加一条新测试

在 `dev/` 下新建 `test-<名字>.cjs`，用 `process.exitCode = 1` 表示失败，`run-all.cjs` 会自动带上它。
想固定执行顺序就把它加进 `run-all.cjs` 顶部的 `ORDER` 数组。

## 改提示词

三档提示词的**可编辑源**在 `dev/prompts/`，成品在 `index.js` 的 `STYLE_ITEMS` 里。
两边靠两个工具同步：

```bash
npm run prompts:dump     # index.js → dev/prompts/*.txt
# 手改 dev/prompts/*.txt
npm run prompts:apply    # dev/prompts/*.txt → index.js
```

文件分工：

| 文件 | 作用 | 影响哪几档 |
|---|---|---|
| `brief.txt` | 精简档专属规则 | 只有精简 |
| `balanced.txt` | 均衡档专属规则 | 只有均衡 |
| `detailed.txt` | 详细档专属规则 | 只有详细 |
| `shared-scene.txt` | DSH 场景约定 | 三档一起 |
| `shared-common.txt` | 公共规则（优先级最高） | 三档一起 |

组装顺序固定：**档位文件 + 场景约定 + 公共规则**。优先级链：**公共规则 > 档位规则 > 场景约定**。
`effective-*.txt` 是拼好的成品，只读参考。

`apply-prompts.mjs` 写回时保留原有的单引号风格，所以「不改内容直接写回」是逐字节相同的 ——
可以用它做往返校验：`apply` 后再 `dump`，两者应该完全一致。

**注意**：改了长度公式要三处同步 —— `STYLE_BANDS` 常量、对应档 `prompt` 里写的上限数字、
`dev/prompts/tiers.json` 的 `band` 字段。`test-bands.cjs` 会检查前两处。

## 代码约定

- **ESM**，`node:` 前缀内置模块，两空格缩进，单引号，无分号
- 注释写**为什么**，不写**做什么** —— 代码本身已经说明做什么了
- 宿主与客户端**不共享代码**：两边各留一份需要的常量，比引入一层共享模块更容易读
- 新增用户可见的行为，同时更新 `docs/USAGE.md` 与 `CHANGELOG.md`

## 加一个新入口（检查清单）

六个入口已收敛到 `optimizeText()`。若要再加一个：

1. 在 `index.js` 的 `apply(ctx)` 里用 `ctx.inject(['服务名'], ...)` 挂载（**可选依赖**，
   服务缺失时插件其余部分要照常工作）
2. 只调 `optimizeText()`，不要自己拼 `ctx.llm.stream`
3. 把错误码映射成合适的回执（`EMPTY_INPUT` / `TOO_LONG` / `EMPTY_OUTPUT`）
4. 补一条测试，断言「同一个输入从新旧两个入口得到相同结果」
5. 更新 `README.md` 的入口表、`docs/USAGE.md`、`docs/ARCHITECTURE.md`

## 发版

```bash
npm run check && npm test
# 1. 改 package.json 的 version
# 2. CHANGELOG.md：[未发布] 收成 [X.Y.Z]，补上日期
# 3. 写 docs/releases/vX.Y.Z.md（就是 GitHub Release 的正文）
git add -A && git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z && git push origin master --tags
gh release create vX.Y.Z --title "vX.Y.Z —— 一句话说清这版是什么" --notes-file docs/releases/vX.Y.Z.md
```

发布说明**写在仓库里**（`docs/releases/vX.Y.Z.md`），不用 `--generate-notes` 自动生成。
理由：自动生成的只有提交标题，读者看不到「症状是什么、为什么这么修、怎么判断修好了」——
而这三样恰好是这个插件每次发版最该说清的。文件与 Release 正文是同一份，改哪边都不算数，
以仓库里的那份为准。

版本号走 [语义化](https://semver.org/lang/zh-CN/)：`0.x` 阶段允许不兼容改动，但要在 CHANGELOG 里写清。

插件自身**不读** `package.json` 的版本号 —— 它由 npm / DSH 的 bundle 机制读取。
如果哪天要在运行时报告版本，再加 `ctx.provide('promptOptimizer', { version: ... })` 里的字段；
现有的 `version: 1` 是**接口版本**，与包版本不是一回事。

## 提交前自查

- [ ] `npm run check` 通过
- [ ] `npm test` 全绿（12 套）
- [ ] 没有把本机绝对路径写进源码或测试
- [ ] 没有提交任何密钥（`.env`、`settings.json` 已在 `.gitignore` 里）
- [ ] 用户可见的变化已经写进 `CHANGELOG.md`
