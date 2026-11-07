// 独立核对：不调用 src/lib，直接数文件、直接读 SQLite，作为 doctor 的第二意见。
// 用法：node scripts/verify.mjs [库根目录]

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = process.argv[2] || join(homedir(), '.dsh', 'meme-brain')
const LIB = join(ROOT, 'library')
const DB = join(ROOT, 'index.db')

if (!existsSync(LIB)) {
  console.error(`库目录不存在：${LIB}`)
  process.exit(1)
}

// ---- 1. 直接走文件系统 ----
const files = new Map() // rel → bytes
let totalBytes = 0
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) walk(abs)
    else if (e.isFile()) {
      const rel = relative(LIB, abs).replace(/\\/g, '/')
      const bytes = statSync(abs).size
      files.set(rel, bytes)
      totalBytes += bytes
    }
  }
}
walk(LIB)

// ---- 2. 直接读 SQLite（只读） ----
if (!existsSync(DB)) {
  console.error(`索引不存在：${DB}`)
  process.exit(1)
}
const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('SELECT md5, path, dhash, state, bytes FROM items').all()
const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value ?? '?'
db.close()

const dbPaths = new Set(rows.map((r) => r.path))

// ---- 3. 比对 ----
const orphan = [...files.keys()].filter((p) => !dbPaths.has(p))
const missing = rows.filter((r) => !files.has(r.path)).map((r) => r.path)

// ---- 4. 独立重算重复簇（朴素 O(n²)，不用 src/lib）----
const bitsOf = (hex) => hex.split('').flatMap((c) => {
  const n = parseInt(c, 16)
  return [(n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1]
})
const hashes = rows.map((r) => ({ md5: r.md5, frames: String(r.dhash).split(',').map(bitsOf) }))
const dupPairs = []
for (let i = 0; i < hashes.length; i++) {
  for (let j = i + 1; j < hashes.length; j++) {
    const a = hashes[i].frames
    const b = hashes[j].frames
    const n = Math.min(a.length, b.length)
    let sum = 0
    let max = 0
    for (let k = 0; k < n; k++) {
      let d = 0
      for (let x = 0; x < 64; x++) if (a[k][x] !== b[k][x]) d++
      sum += d
      max = Math.max(max, d)
    }
    if (sum / n <= 4 && max <= 8) dupPairs.push([hashes[i].md5.slice(0, 8), hashes[j].md5.slice(0, 8), max])
  }
}

// ---- 5. 报告 ----
const ok = orphan.length === 0 && missing.length === 0 && rows.length === files.size && dupPairs.length === 0
console.log(`库根目录      ${ROOT}`)
console.log(`schema        v${version}`)
console.log(`磁盘文件      ${files.size}　${(totalBytes / 1024 / 1024).toFixed(1)}MB`)
console.log(`索引记录      ${rows.length}`)
console.log(`孤儿文件      ${orphan.length}`)
console.log(`索引缺文件    ${missing.length}`)
console.log(`重复对        ${dupPairs.length}`)
if (dupPairs.length) for (const p of dupPairs) console.log(`  ${p[0]} ↔ ${p[1]}  距离 ${p[2]}`)
console.log(ok ? '\n✓ 独立核对通过：文件与索引完全一致，库中没有重复' : '\n✗ 独立核对发现问题')
process.exit(ok ? 0 : 1)
