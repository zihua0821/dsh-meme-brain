// 把仓库里的 Aurabot 模块部署到 Aurabot 的模块目录。
//
// 为什么要这个脚本：模块必须放在 %USERPROFILE%\.dsh\plugins-data\aurabot\modules\ 下才会被加载，
// 但那样就不在 git 里了。所以仓库里这份是**源码**，装上去的那份是**部署产物**。
// 改完跑一次这个脚本，Aurabot 3 秒内自己热加载（日志里能看到「文件改了，重新加载」）。
//
// 用法：
//   node scripts/deploy-aurabot.mjs            部署全部
//   node scripts/deploy-aurabot.mjs stickers   只部署这一个

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'integrations', 'aurabot')
const DEST = join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'modules')

function sameFile(a, b) {
  if (!existsSync(b)) return false
  const sa = statSync(a)
  const sb = statSync(b)
  return sa.size === sb.size && readFileSync(a).equals(readFileSync(b))
}

if (!existsSync(SRC)) {
  console.error(`没有 ${SRC}：integration 目录不存在`)
  process.exit(1)
}

const only = process.argv[2]
const ids = readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
const targets = only ? ids.filter((id) => id === only) : ids

if (!targets.length) {
  console.error(`没有要部署的模块${only ? `（找不到 ${only}）` : ''}。现有：${ids.join('、') || '（空）'}`)
  process.exit(1)
}

let changed = 0
for (const id of targets) {
  const from = join(SRC, id, 'index.mjs')
  if (!existsSync(from)) {
    console.error(`跳过 ${id}：没有 index.mjs`)
    continue
  }
  const dir = join(DEST, id)
  const to = join(dir, 'index.mjs')
  if (sameFile(from, to)) {
    console.log(`= ${id}：已经是最新的（${to}）`)
    continue
  }
  mkdirSync(dir, { recursive: true })
  copyFileSync(from, to)
  changed += 1
  console.log(`→ ${id}：已写入 ${to}`)
}

if (changed) {
  console.log('')
  console.log('Aurabot 会在 3 秒内热加载（不用重启 DSH）。看日志确认：')
  console.log(`  ${join(homedir(), '.dsh', 'plugins-data', 'aurabot', 'logs')}\\aurabot-<今天>.log`)
  console.log('  搜「重新加载」或「已接管」')
} else {
  console.log('没有需要部署的改动。')
}
