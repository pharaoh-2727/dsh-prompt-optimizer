#!/usr/bin/env node
/**
 * run-all.cjs —— 一键跑全部离线测试。
 *
 *   node dev/run-all.cjs
 *
 * 会自动发现本目录下的 smoke-host.cjs 与 test-*.cjs，逐个用子进程跑，
 * 收集退出码，最后汇总。不依赖任何测试框架。
 *
 * 环境是**故意收窄**的：子进程里删掉 DSH_PROFILE_DIR，让测试跑在一个
 * 没有真机 profile 的环境里。插件要的默认模型由 dev/stub-model.cjs 现场造，
 * 所以「在这台机器上绿、换台机器就红」这种情况不该再出现。
 */
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readdirSync } = require('node:fs')
const os = require('node:os')
const { join } = require('node:path')

const HERE = __dirname

// 跑的顺序：先宿主半区，再客户端与逻辑，最后是跨进程的流式一致性。
const ORDER = [
  'smoke-host.cjs',
  'test-bands.cjs',
  'test-band-ceiling.cjs',
  'test-band-correction.cjs',
  'test-band-overshoot.cjs',
  'test-input-kind.cjs',
  'test-free-channel.cjs',
  'test-restore-state.cjs',
  'test-preview-flow.cjs',
  'test-multi-entry.cjs',
  'test-stream-parity.cjs',
  'test-result-stability.cjs',
  'test-dock-behaviour.cjs',
  'test-scene-context.cjs',
  'test-brute-force.cjs',
]

function discover() {
  const all = readdirSync(HERE).filter((name) => name === 'smoke-host.cjs' || /^test-.+\.cjs$/u.test(name))
  const known = ORDER.filter((name) => all.includes(name))
  const extra = all.filter((name) => !known.includes(name)).sort()
  return [...known, ...extra]
}

function main() {
  const files = discover()
  if (files.length === 0) {
    console.error('dev/ 下没有找到任何测试文件')
    process.exit(1)
  }

  // 子进程环境：把机器相关的配置指向一个空目录，让「这台机器上有什么」不影响结果。
  // 删掉 DSH_HOME 反而更危险 —— 插件会退回真实的 ~/.dsh 去读用户设置。
  // 每套测试自己会造需要的那一小份（见 stub-model.cjs）。
  const tmpHome = mkdtempSync(join(os.tmpdir(), 'dsho-runall-'))
  const env = { ...process.env }
  env.DSH_HOME = tmpHome
  delete env.DSH_PROFILE_DIR

  const failures = []
  const startedAt = Date.now()

  for (const file of files) {
    const label = file.replace(/\.cjs$/u, '')
    process.stdout.write(`\n──────── ${label} ────────\n`)
    const result = spawnSync(process.execPath, [join(HERE, file)], {
      cwd: HERE,
      env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      failures.push(`${label}: ${result.error.message}`)
      continue
    }
    if (result.status !== 0) {
      failures.push(`${label}: exit ${result.status ?? result.signal}`)
    }
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log('')
  if (failures.length === 0) {
    console.log(`全部通过：${files.length} 套测试，用时 ${seconds}s`)
    return
  }
  console.error(`失败 ${failures.length} / ${files.length}：`)
  for (const line of failures) console.error('  - ' + line)
  process.exitCode = 1
}

main()
