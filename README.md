# dsh-prompt-optimizer

**DeepSeek Harness 专用提示词优化插件。** 写完一段话按一下 ✨，让模型把它改写成 DSH 能直接照做的提示词 —— 带动作、带产出、带验收标准。

- 六个入口同一份实现：输入框按钮、会话标题旁 ✨、**Alt+O**、斜杠命令 `/optimize`、给模型的工具 `optimize_prompt`、给插件的服务 `promptOptimizer`
- 流式生成（换稿时先说清原因）、预览卡确认（不直接盖掉你的草稿）、历史版本与逐行对比
- 三档力度：**精简 / 均衡 / 详细**，每档有独立的长度上限与禁令
- 零配置可用：默认跟随当前对话正在用的模型

> 这是 [`dsh-prompt-enhancer`](https://github.com/MCJF28/dsh-prompt-enhancer)（MIT）的 DSH 场景适配版。架构、交互、配置与上游一致，差异只有一处：改写规则里的「场景约定」换成了 DeepSeek Harness 的真实用法（`@` 文件引用、工作区、工具面、可判定的验收口径）。详见 [CHANGELOG](CHANGELOG.md)。

---

## 快速开始

**要求**：DSH `>= 0.2.0-rc.1`。Node 用宿主自带的那份运行时即可，不需要另装。

### 安装

```bash
git clone https://github.com/pharaoh-2727/dsh-prompt-optimizer.git
cp -r dsh-prompt-optimizer ~/.dsh/plugins/
```

建一个 home 级补丁文件 `~/.dsh/cordis.patch.yml`（Windows 上是 `%USERPROFILE%\.dsh\cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-prompt-optimizer
      name: './plugins/dsh-prompt-optimizer/index.js'
```

**重启 DSH。** 打开设置 → 优化，能看到三档选择就装好了。装法 A/B/C 的完整说明见 [docs/INSTALL.md](docs/INSTALL.md)。

### 用起来

1. 在输入框写下你想说的话（可以很随意）
2. 按 **Alt+O**，或点输入框右侧的 **✨**
3. 结果进**预览卡**，不覆盖你的草稿 —— 点「替换草稿」才写回，点「复制」只拿走
4. 想换个措辞再来一版：点「重新优化」；想比一比：点「历史 N」看之前几版

完整功能（流式、缩放、历史对比、编辑冲突、取消）见 [docs/USAGE.md](docs/USAGE.md)。

---

## 三档力度

在「设置 → 优化」里选。每档的长度上限、允许补充什么、明确禁止什么各不相同。

| 档位 | 长度上限 | 会做什么 |
|---|---|---|
| **精简** | ≤ max(1.15 × 原文, 原文 + 10 字) | 只改语病、指代、含糊量词、补主语；**不新增任何要求** |
| **均衡**（默认） | ≤ max(1.6 × 原文, 原文 + 80 字) | 补齐含糊处，写明交付什么、怎样算完成 |
| **详细** | ≤ max(2.2 × 原文, 原文 + 150 字) | 补齐目标 / 上下文 / 步骤 / 产出格式 / 验收标准，步骤 ≤ 6 条 |

上限公式统一是 **max(原文 × 倍数, 原文 + 加字额度)**：短输入靠加字额度给模型喘息空间，长输入自动切回倍数封顶。

**优化器只做改写，绝不答题。** 你写的是任务要求、简单提问还是闲聊，输出永远是「改写后的提示词」，不是对它的回答。

---

## 模型

「设置 → 优化」里三选一：

| 选项 | 说明 |
|---|---|
| **自动**（默认，推荐） | 跟随当前对话正在用的模型，**永远可用**，零配置 |
| **免费通道** | 走一个 OpenAI 兼容端点，不消耗对话额度；**密钥要你自己配**，不配就跳过 |
| **手动** | 固定用一个模型，从完整模型列表里选 |

### 免费通道（可选）

源码里**不放任何凭据** —— 密钥一旦提交进代码库就等于永久公开。要用就自己设环境变量：

```bash
DSH_FREE_CHANNEL_API_KEY=sk-...                      # 必填
DSH_FREE_CHANNEL_BASE_URL=https://your-endpoint/v1   # 可选，默认 https://api.hcnsec.cn/v1
DSH_FREE_CHANNEL_MODEL=your-model                    # 可选，默认 DeepSeek-V4-Flash
```

不配也没关系：插件会直接跳过这条路径，用你当前对话的模型跑完，功能不受影响。

失败会被分门别类：`auth`（401/403，判定通道已死，不再反复撞）、`rate`（429，可重试）、`server`/`timeout`/`network`（可重试）。界面上给的是一句人话加一个出路，不是上游的原始 JSON。

---

## 开发

```bash
npm run check        # 两个入口文件的语法检查
npm test             # 12 套离线测试（约 6 秒）
```

测试不依赖 DSH 在跑：宿主半区用假 `ctx`，客户端半区用最小 React 桩 + 微型渲染器直接跑 `client.js`。跑测试时 `DSH_PROFILE_DIR` 会被清掉，需要的默认模型由 `dev/stub-model.cjs` 现场造 —— 所以同一份测试在别人的机器上也该是绿的。

改提示词：提示词拆成 `dev/prompts/` 下 5 个纯文本文件，改完用 `npm run prompts:apply` 写回 `index.js`。细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

---

## 文档

| 文件 | 内容 |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | 每个界面元素的用法、快捷键、边界情况 |
| [docs/INSTALL.md](docs/INSTALL.md) | 三种装法、卸载、升级、排错 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 代码骨架：六个入口如何收敛、路由、流式、取消 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 本地开发、测试、改提示词、发版流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [docs/releases/](docs/releases/) | 每个版本的发布说明（与 GitHub Release 正文同一份） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交与 PR 约定 |

---

## 许可

MIT。上游 `dsh-prompt-enhancer` 版权归 MCJF28；DSH 场景适配部分见 [LICENSE](LICENSE)。
