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

const SCENE_MARK = 'DSH 场景约定（'
const COMMON_MARK = '公共规则（三档都适用'

function splitPrompt(prompt) {
  const sceneIdx = prompt.indexOf(SCENE_MARK)
  const commonIdx = prompt.indexOf(COMMON_MARK)
  if (sceneIdx < 0 || commonIdx < 0 || commonIdx < sceneIdx) {
    throw new Error('提示词里找不到 DSH 场景约定 / 公共规则 的分界标记')
  }
  return {
    tier: prompt.slice(0, sceneIdx).trimEnd(),
    scene: prompt.slice(sceneIdx, commonIdx).trim(),
    common: prompt.slice(commonIdx).trim(),
  }
}

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const items = mod.STYLE_ITEMS

mkdirSync(OUT, { recursive: true })

const parts = items.map((item) => ({ item, parts: splitPrompt(item.prompt) }))

// 共用段：取第一档的，写一次
const first = parts[0].parts
const sharedScene = first.scene
const sharedCommon = first.common
for (const { item, parts: p } of parts) {
  if (p.scene !== sharedScene) {
    console.warn(`注意：${item.id} 的 DSH 场景约定与 ${items[0].id} 不一致，已按 ${items[0].id} 导出共用段。`)
  }
  if (p.common !== sharedCommon) {
    console.warn(`注意：${item.id} 的公共规则与 ${items[0].id} 不一致，已按 ${items[0].id} 导出共用段。`)
  }
}

writeFileSync(join(OUT, 'shared-scene.txt'), sharedScene + '\n', 'utf8')
writeFileSync(join(OUT, 'shared-common.txt'), sharedCommon + '\n', 'utf8')
console.log(`wrote shared-scene.txt  (${sharedScene.split('\n').length} lines)`)
console.log(`wrote shared-common.txt (${sharedCommon.split('\n').length} lines)`)

for (const { item, parts: p } of parts) {
  writeFileSync(join(OUT, `${item.id}.txt`), p.tier + '\n', 'utf8')
  writeFileSync(join(OUT, `effective-${item.id}.txt`), item.prompt + '\n', 'utf8')
  console.log(`wrote ${item.id}.txt (${p.tier.split('\n').length} lines) + effective-${item.id}.txt (${item.prompt.split('\n').length} lines)`)
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
