/**
 * stub-model.cjs —— 测试用的「默认模型」桩。
 *
 * 为什么需要它：插件在「自动」模式下要找一个可用模型，兜底链的最后一环是
 * 读 profile 的 cordis.patch.yml（其中的 agent-default-model）。离线测试跑在
 * 一个空环境里，既没有真实的 DSH profile，也不该依赖某台机器上的配置。
 *
 * 做法：往临时目录写一份最小 patch，把 DSH_PROFILE_DIR 指过去。插件的兜底链
 * 走的仍是它真实的那条路径，**源码里不需要为测试留任何后门**。
 */
const fs = require('node:fs')
const path = require('node:path')

function stubModel(dir, provider = 'test-provider', model = 'test-model') {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    [
      '# 测试桩：只放插件兜底链要找的那一段',
      '- id: agent-default-model',
      '  config:',
      '    provider: ' + provider,
      '    model: ' + model,
      '',
    ].join('\n'),
    'utf8',
  )
  process.env.DSH_PROFILE_DIR = dir
  return { provider, model }
}

module.exports = { stubModel }
