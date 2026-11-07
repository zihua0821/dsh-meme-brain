// 体检：只读，不修复。修复由 /meme repair 执行。
//
// 输出即验收标准（见 docs/04-acceptance.md M2）：
//   library 文件数 与 索引记录数 必须相等；孤儿与缺文件都应为 0。

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  ROOT, LIBRARY, INDEX_DB, CHARACTERS, BACKUPS, listLibraryFiles, libraryUsage,
} from './store.js'
import { SCHEMA_VERSION, currentVersion, allItems, countByState } from './db.js'
import { findClusters } from './dedupe.js'

const kb = (n) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)

/** 最近一次备份文件名 */
function latestBackup() {
  if (!existsSync(BACKUPS)) return null
  const files = readdirSync(BACKUPS).filter((f) => f.endsWith('.db')).sort()
  return files.length ? files[files.length - 1] : null
}

/**
 * @param {object|null} index 打开的 SQLite；为 null 表示还没有索引
 * @returns {{lines:string[], ok:boolean, stats:object}}
 */
export function doctor(index) {
  const lines = []
  const stats = {}
  let ok = true

  lines.push(`库根目录      ${ROOT}${existsSync(ROOT) ? '' : '（尚未创建）'}`)

  const files = listLibraryFiles()
  stats.files = files.length
  stats.bytes = libraryUsage()

  if (!index) {
    lines.push('index.db      不存在（还没有索引）')
    const empty = files.length === 0
    lines.push('')
    lines.push(empty ? '结论：空库' : '结论：有图片但没有索引 → 运行 /meme rebuild')
    return { lines, ok: empty, stats }
  }

  const version = currentVersion(index)
  stats.schemaVersion = version
  const versionOk = version === SCHEMA_VERSION
  if (!versionOk) ok = false
  lines.push(`schema        v${version}${versionOk ? '（最新）' : ` ⚠ 代码期望 v${SCHEMA_VERSION}`}`)

  const rows = allItems(index)
  const states = countByState(index)
  stats.total = rows.length
  stats.states = states

  lines.push(`library 文件  ${files.length}　${kb(stats.bytes)}`)
  lines.push(`索引记录      ${rows.length}`)
  if (files.length !== rows.length) {
    ok = false
    lines.push('              ⚠ 数量不一致，运行 /meme repair')
  }

  const dbPaths = new Set(rows.map((r) => r.path))
  const diskPaths = new Set(files.map((f) => f.rel))
  const orphans = files.filter((f) => !dbPaths.has(f.rel))
  const missing = rows.filter((r) => !diskPaths.has(r.path))
  stats.orphans = orphans.length
  stats.missing = missing.length

  lines.push(`孤儿文件      ${orphans.length}${orphans.length ? '（磁盘有、索引无）' : ''}`)
  lines.push(`索引缺文件    ${missing.length}${missing.length ? '（索引有、磁盘无）' : ''}`)
  if (orphans.length || missing.length) ok = false

  if (rows.length) {
    const clusters = findClusters(rows.map((r) => ({ md5: r.md5, dhash: String(r.dhash).split(',') })))
    stats.dupGroups = clusters.length
    lines.push(`重复簇        ${clusters.length}`)
    for (const c of clusters.slice(0, 3)) {
      const names = c.members.map((m) => rows.find((r) => r.md5 === m.md5)?.name || m.md5.slice(0, 8))
      lines.push(`              · ${names.join(' ↔ ')}（最远 ${c.maxDistance}）`)
    }
    if (clusters.length > 3) lines.push(`              … 另有 ${clusters.length - 3} 组`)
  } else {
    stats.dupGroups = 0
  }

  const pending = states.incoming || 0
  stats.pending = pending

  lines.push(`characters    ${existsSync(CHARACTERS) ? '存在' : '尚未创建（M6 引入）'}`)
  lines.push(`最近备份      ${latestBackup() || '无'}`)
  lines.push('')
  lines.push(ok ? '结论：数据一致，体检通过' : '结论：存在不一致，按上面提示运行 /meme repair')
  return { lines, ok, stats }
}
