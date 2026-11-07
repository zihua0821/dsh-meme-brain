// 用本项目的解析/判重跑一遍真实图库，输出格式统计与重复簇。
// 用途：M1 验收、以及每次改算法后的回归对比。
//
// 用法：node scripts/scan-library.mjs <图片目录>

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { parseImage, ParseError } from '../src/lib/parse.js'
import { findClusters } from '../src/lib/dedupe.js'

const EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return out
}

const root = process.argv[2]
if (!root) {
  console.error('用法：node scripts/scan-library.mjs <图片目录>')
  process.exit(1)
}

const files = walk(root)
const items = []
const failures = []
const formats = {}
let totalBytes = 0
const t0 = Date.now()

for (const f of files) {
  const buf = readFileSync(f)
  totalBytes += buf.length
  try {
    const r = await parseImage(buf)
    formats[r.format] = (formats[r.format] || 0) + 1
    items.push({
      md5: createHash('md5').update(buf).digest('hex'),
      file: relative(root, f),
      dhash: r.dhash,
      frames: r.frames,
      bytes: r.bytes,
    })
  } catch (error) {
    failures.push({ file: relative(root, f), code: error instanceof ParseError ? error.code : 'E_UNKNOWN', message: error.message })
  }
}

const elapsed = Date.now() - t0
const clusters = findClusters(items)

console.log(`目录       ${root}`)
console.log(`文件数     ${files.length}（解析成功 ${items.length}，失败 ${failures.length}）`)
console.log(`总体积     ${(totalBytes / 1024 / 1024).toFixed(1)}MB，用时 ${elapsed}ms，平均 ${(elapsed / Math.max(1, files.length)).toFixed(1)}ms/张`)
console.log(`格式       ${Object.entries(formats).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
if (failures.length) {
  console.log('\n失败：')
  for (const f of failures) console.log(`  ${f.code}  ${f.file}  ${f.message.slice(0, 80)}`)
}
console.log(`\n重复簇     ${clusters.length}`)
for (const c of clusters) {
  console.log(`  [${c.members.length} 张，最远距离 ${c.maxDistance}]`)
  for (const m of c.members) console.log(`    ${m.md5.slice(0, 8)}  ${(m.bytes / 1024).toFixed(0).padStart(5)}KB  ${m.file}`)
}
