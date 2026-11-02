/**
 * 把 prompts/ 里改过的提示词写回 index.js。
 *
 * 工作流：
 *   1. node dump-prompts.mjs            ← 从 index.js 提取三档提示词
 *   2. 手改 prompts/brief.txt 等文件
 *   3. node apply-prompts.mjs            ← 把改后的内容写回 index.js
 *   4. node --check ../index.js → 复制到线上目录 → unlag 刷新
 *
 * 文件分工（这是关键）：
 *   prompts/brief.txt      精简档**专属**规则
 *   prompts/balanced.txt   均衡档专属规则
 *   prompts/detailed.txt   详细档专属规则
 *   prompts/shared-scene.txt    DSH 场景约定（三档共用）
 *   prompts/shared-common.txt   公共规则（三档共用）
 *   prompts/effective-*.txt     三档拼起来的完整生效版（只读参考）
 *
 * 共用段单独放一个文件，是为了让「改一个档位」和「改三档共用规则」互不干扰：
 * 改档位文件只影响那一档；改 shared-* 则三档一起变。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const PLUGIN = join(ROOT, 'index.js')
const PROMPTS_DIR = process.argv[2] || join(HERE, 'prompts')

/** 生成 index.js 里那种单引号风格的数组字面量。 */
function quoteLines(text, indent) {
  return text.split('\n').map((line) => {
    const escaped = line.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
    return `${indent}'${escaped}'`
  })
}

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const items = mod.STYLE_ITEMS

let source = readFileSync(PLUGIN, 'utf8')
const notes = []

/* ---------- 1. 共用段：shared-scene.txt / shared-common.txt ---------- */
//
// 场景约定的常量名是 SCENE_TEMPLATE（模板，带 {{workspace}} / {{environment}} 占位符），
// 不是成品文字 —— 成品由 dshScene(context) 在每次调用时渲染。
// 这里写回的必须是**模板**，否则本机路径会被烤进仓库。
for (const [file, constName] of [
  ['shared-scene.txt', 'SCENE_TEMPLATE'],
  ['shared-common.txt', 'COMMON'],
]) {
  const path = join(PROMPTS_DIR, file)
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/\s+$/u, '')
  } catch {
    notes.push(`缺少 ${file}，跳过（共用段保持原样）`)
    continue
  }
  const start = source.indexOf(`const ${constName} = [`)
  const end = source.indexOf("].join('\\n')", start)
  if (start < 0 || end < 0) {
    notes.push(`在 index.js 里找不到 ${constName} 常量，跳过`)
    continue
  }
  const block = `const ${constName} = [\n${quoteLines(text, '  ').join(',\n')},\n].join('\\n')`
  source = source.slice(0, start) + block + source.slice(end + "].join('\\n')".length)
  console.log(`[${constName}] 已写回 ${text.split('\n').length} 行（${file}）`)
}

/* ---------- 2. 各档专属规则 ---------- */
for (const item of items) {
  const path = join(PROMPTS_DIR, `${item.id}.txt`)
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/\s+$/u, '')
  } catch {
    notes.push(`缺少 ${item.id}.txt，跳过该档`)
    continue
  }
  const idAt = source.indexOf(`id: '${item.id}',`)
  if (idAt < 0) {
    notes.push(`在 index.js 里找不到 id: '${item.id}'，跳过`)
    continue
  }
  const promptAt = source.indexOf('tierPrompt: [', idAt)
  const endAt = source.indexOf("].join('\\n'),", promptAt)
  if (promptAt < 0 || endAt < 0) {
    notes.push(`找不到 ${item.id} 的 tierPrompt 数组边界，跳过`)
    continue
  }
  // 只写回「本档专属规则」。场景约定与公共规则不在这里 ——
  // 它们由 renderPrompt() 在读取时拼上去，所以不会在每档里各存一份副本。
  const block = `tierPrompt: [\n${quoteLines(text, '      ').join(',\n')},\n    ].join('\\n'),`
  source = source.slice(0, promptAt) + block + source.slice(endAt + "].join('\\n'),".length)
  console.log(`[${item.id}] 已写回 ${text.split('\n').length} 行专属规则`)
}

writeFileSync(PLUGIN, source, 'utf8')
console.log(`\n已更新 ${PLUGIN}`)
for (const note of notes) console.log('注意：' + note)
