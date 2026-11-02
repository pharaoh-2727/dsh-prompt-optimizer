# 参与贡献

先说清楚一件事：这是个**只有一个作者、按自己需要改**的插件。改动可能完全按作者的判断来，不一定等你的 PR。开 issue 描述问题和场景就够了，附不附 PR 都行。

## 环境

```bash
git clone https://github.com/pharaoh-2727/dsh-prompt-optimizer.git
cd dsh-prompt-optimizer
npm run check    # 语法检查
npm test         # 8 套离线测试，约 5 秒
```

不需要 `npm install` —— 项目没有运行时依赖，也不需要构建。

## 提交前

- `npm run check` 与 `npm test` 都通过
- **别把本机绝对路径写进源码或测试**。测试用 `process.env.DSHO_PLUGIN` / `DSHO_CLIENT` / `DSHO_TMP`，缺省靠 `__dirname` 推导
- **别提交任何密钥**。`.env` 与 `settings.json` 已在 `.gitignore` 里，别绕过它
- 用户可见的行为变化，同时更新 `CHANGELOG.md` 的 `[未发布]` 一节

## 代码风格

- ESM，`node:` 前缀内置模块
- 两空格缩进、单引号、无分号
- 注释写**为什么**，不写**做什么**
- 宿主（`index.js`）与客户端（`client.js`）不共享代码 —— 两边各留一份需要的常量，比加一层共享模块更容易读

## 提 issue

请带上：

1. DSH 版本、操作系统
2. 你做什么操作时出的问题
3. 期望看到什么、实际看到什么
4. 如果是界面问题，附一张截图；如果是错误，附上完整报错文本

## 改代码的话

两条最容易踩的线：

- **六个入口只调 `optimizeText()`**。别自己拼 `ctx.llm.stream` —— 那样会绕过档位复核和免费通道回退，`dev/test-stream-parity.cjs` 会立刻红
- **改长度公式要三处同步**：`STYLE_BANDS` 常量、对应档 prompt 里的上限数字、`dev/prompts/tiers.json`。`dev/test-bands.cjs` 检查前两处

细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 许可

提交即表示同意以 MIT 许可发布你的贡献。
