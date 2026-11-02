/**
 * 把三档提示词拆成「共用段」和「各档专属段」导出，方便按档位单独改。
 *
 * 产出（默认 dev/prompts/）：
 *   shared-scene.txt      DSH 场景约定（三档共用）
 *   shared-common.txt     公共规则（三档共用）
 *   brief.txt             精简档专属规则
 *   balanced.txt          均衡档专属规则
 *   detailed.txt          详细档专属规则
 *   effective-*.txt       三档拼起来的完整生效版（只读参考）
 *   tiers.json            三档元信息
 *
 * 写回用 apply-prompts.mjs。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN = join(HERE, '..', 'index.js')
const OUT = process.argv[2] || join(HERE, 'prompts')

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const items = mod.STYLE_ITEMS

mkdirSync(OUT, { recursive: true })

/*
 * 三段内容都**直接问插件要**，不再从拼好的提示词里按标记切。
 *
 * 早先是从 item.prompt 里 indexOf('DSH 场景约定（') 切开；那只在场景约定
 * 是一段写死的常量时成立。现在场景约定带 {{workspace}} / {{environment}}
 * 两个运行时占位符，切出来的会是**填好值的成品**，写回文件就把本机路径
 * 烤进仓库了。所以改成读模板本身。
 */
const sharedScene = mod.SCENE_TEMPLATE
const sharedCommon = mod.COMMON

writeFileSync(join(OUT, 'shared-scene.txt'), sharedScene + '\n', 'utf8')
writeFileSync(join(OUT, 'shared-common.txt'), sharedCommon + '\n', 'utf8')
console.log(`wrote shared-scene.txt  (${sharedScene.split('\n').length} lines, 含运行时占位符)`)
console.log(`wrote shared-common.txt (${sharedCommon.split('\n').length} lines)`)

for (const item of items) {
  const tier = item.tierPrompt
  writeFileSync(join(OUT, `${item.id}.txt`), tier + '\n', 'utf8')
  // effective-* 是「这一档会发出去什么」的参考全文，用静态渲染（没有会话上下文），
  // 因此里面的工作区那一行是空的 —— 与设置页显示的内容完全一致。
  writeFileSync(join(OUT, `effective-${item.id}.txt`), item.prompt + '\n', 'utf8')
  console.log(`wrote ${item.id}.txt (${tier.split('\n').length} lines) + effective-${item.id}.txt (${item.prompt.split('\n').length} lines)`)
}

// tiers.json 是三档的元数据（供选择器/加载器读取）。
// 写成合法的 JSON 数组 —— 之前这里把多个对象直接拼在一起，那不是合法 JSON。
// band / scope / forbid / bandBadge 都从 index.js 现读，所以这份文件始终与代码一致。
const meta = items.map((item) => ({
  id: item.id,
  label: item.label,
  summary: item.summary,
  band: item.band,
  bandBadge: item.bandBadge ?? null,
  scope: item.scope,
  forbid: item.forbid,
  tierFile: `${item.id}.txt`,
  effectiveFile: `effective-${item.id}.txt`,
}))
writeFileSync(join(OUT, 'tiers.json'), JSON.stringify(meta, undefined, 2) + '\n', 'utf8')
console.log('wrote tiers.json')
