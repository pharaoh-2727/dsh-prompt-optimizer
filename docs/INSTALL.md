# 安装、升级与卸载

## 要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | `>= 0.2.0-rc.1`（插件在 `package.json` 的 `engines.dsh` 里声明） |
| Node.js | 宿主自带的运行时即可，不需要另装 |
| 操作系统 | 不限。开发与测试在 Windows + PowerShell 上做的 |

> 路径约定：`~/.dsh` 是你的 DSH 主目录，Windows 上默认 `%USERPROFILE%\.dsh`。
> 需要改路径时用环境变量：`DSH_HOME`、`DSH_PROFILE`（默认 `desktop`）、`DSH_PROFILE_DIR`。

---

## 方式 A：home 级补丁挂载（推荐）

不改 profile 里任何既有文件，只新建两个东西。

**1. 放插件**

```bash
git clone https://github.com/pharaoh-2727/dsh-prompt-optimizer.git
mkdir -p ~/.dsh/plugins
cp -r dsh-prompt-optimizer ~/.dsh/plugins/
```

目录结构应该是这样：

```
~/.dsh/plugins/dsh-prompt-optimizer/
├── index.js            ← 宿主半区（路由、引擎、命令、工具、服务）
├── client.js           ← 客户端半区（按钮、预览卡、快捷键）
├── cordis.patch.yml
├── package.json
├── README.md
├── LICENSE
└── docs/  dev/
```

**2. 建挂载文件**

新建 `~/.dsh/cordis.patch.yml`，内容：

```yaml
- insert:
    - id: dsh-prompt-optimizer
      name: './plugins/dsh-prompt-optimizer/index.js'
```

**3. 重启 DSH。**

### 为什么这样能挂上

`$DSH_HOME/cordis.patch.yml` 是 DSH 的 **home 级补丁层**。加载顺序：

```
各 bundle 自带 patch → profile 的 cordis.patch.yml → home 级 cordis.patch.yml → --patch 覆层
```

`name` 以 `./` 开头时会被自动锚定成 file URL，相对基准就是这个 patch 文件所在的目录 ——
所以 `./plugins/...` 正好指向插件目录。

home 级补丁**不在热重排监听范围内**，改完必须重启 DSH。

---

## 方式 B：作为 profile bundle 安装

适合要发布给别人的场合 —— 借用 pnpm 的依赖管理，升级就是改个版本号。

```bash
cd ~/.dsh/profiles/desktop
pnpm add file:"$HOME/.dsh/plugins/dsh-prompt-optimizer"
```

然后把包名 `dsh-prompt-optimizer` 加进 profile 配置里的 `dsh.profile.bundles`，重启应用。

插件自带 `cordis.patch.yml`（声明 `- id: dsh-prompt-optimizer / name: dsh-prompt-optimizer`），
会被自动挂载，不需要再写 home 级补丁。

---

## 方式 C：直接装上游原版

上游 `dsh-prompt-enhancer` 已在 npm 上，可以用「设置 → 内置插件」粘包名安装。

但它**没有 DSH 场景适配** —— 改写出来的是泛泛的措辞润色，而不是 DSH 能直接照做的提示词。
想要 DSH 口径就用方式 A 或 B。

---

## 确认装好了

1. **设置 → 优化** 里出现三档力度和模型选择 → 宿主半区活了
2. 输入框右侧出现 **✨**，会话标题旁也有一个 → 客户端半区活了
3. 按 **Alt+O** 有反应 → 快捷键挂上了
4. 在对话里敲 `/optimize 测试一下` → 命令注册成功

第 2~4 条不需要重启就能用；只有第 1 条不成立时，先看下面的排错。

---

## 升级

```bash
cd ~/.dsh/plugins/dsh-prompt-optimizer
git pull
```

方式 A 的挂载不需要重写，但要**重启 DSH**（home 级补丁不在热重排范围内）。
方式 B 则改 `package.json` 里的版本号后重跑 `pnpm add`。

改完代码后如果 DSH 里看不到变化，点应用里的「刷新」（unlag）。它会安全重建插件宿主 ——
插件用 `ctx.effect(() => registerRoute(...))` 注册路由，旧实例的路由会被自动撤销，
不会撞上 `webserver: duplicate exact route`。

---

## 卸载

1. 删除 `~/.dsh/cordis.patch.yml`（或只删其中 `- insert:` 那段）
2. 删除 `~/.dsh/plugins/dsh-prompt-optimizer/`
3. 可选：删除 `~/.dsh/prompt-optimizer/settings.json`（你的设置）
4. 重启 DSH

浏览器里还会留几条 localStorage（预览卡尺寸、历史版本），键名都以 `dsho.` 开头，
需要的话在开发者工具里手动清掉。

---

## 排错

### 设置页看不到「优化」这一节

宿主半区没加载。按顺序查：

1. `~/.dsh/cordis.patch.yml` 是否存在、YAML 缩进是否正确（`insert:` 下是列表，列表项缩进两格）
2. 路径 `./plugins/dsh-prompt-optimizer/index.js` 是否相对 patch 文件所在目录成立
3. 重启 DSH（不是刷新页面）
4. 看 DSH 日志里有没有 `dsh-prompt-optimizer` 的报错

### 按钮出现了，但点了没反应

浏览器拿到的还是旧 bundle。刷新页面（Ctrl/Cmd+R）；仍然不行就重启 DSH。

### 点优化报「取不到可用模型」

插件在「自动」模式下要找一个可用模型，依次尝试：当前会话正在用的路由 → 宿主默认模型 →
profile patch 里的 `agent-default-model`。

都拿不到时，去 **设置 → 优化** 手动选一个模型，或 **设置 → 模型** 里先选一个默认模型。

### 免费通道一直失败

- 报 `no-key`：没设 `DSH_FREE_CHANNEL_API_KEY`。设了之后要**重启 DSH** 才读得到
- 报 `auth`（401/403）：密钥无效或已作废。换一把，然后点「重新测试」（跳过缓存真去请求一次）
- 报 `rate`（429）：额度用尽，等一会儿或换端点
- 报 `timeout` / `network`：端点连不上，检查 `DSH_FREE_CHANNEL_BASE_URL`

免费通道坏了不影响主流程 —— 插件会回退到你当前对话的模型。

### 代码改了但界面没变

依次确认：文件真的覆盖到了 `~/.dsh/plugins/dsh-prompt-optimizer/`、点了「刷新」、刷新了页面。
三者都做了还不行，重启 DSH。

### 路由冲突

插件注册的路径前缀是 `/dsh-prompt-optimizer/`。热替换时它会先回收**自己**这个前缀下的历史路由，
不碰其他插件的路由。如果看到 `duplicate exact route`，通常是同一份插件被挂了两次 ——
检查 `cordis.patch.yml` 里是否有重复的 `- id: dsh-prompt-optimizer`。
