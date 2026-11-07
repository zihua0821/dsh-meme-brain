// 库的导出与导入（打包成一个 zip，带完整标注）。
//
// 目的：293 张图 + 86 张人工标注只有磁盘这一份。导出的包要能**在另一台机器还原出同样的库**，
// 所以除了图，还要带 manifest（每张的角色/名字/标签/评分/锁定）和角色表。
//
// 导入的原则：**只补不覆盖**。
//   - 库里没有的 md5 → 写文件 + 建记录
//   - 库里已有的 md5 → 只把空字段补齐（人工标过的绝不覆盖）
// 想整体覆盖是另一件事（那是「恢复备份」，要清库），这里不做。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { listZip, readZipEntry, writeZip } from './archive.js'
import { allItems, getItem, insertItem, updateItem } from './db.js'
import { LIBRARY, BACKUPS, ROOT, absPath, ensureDirs, relPathFor } from './store.js'
import * as characterTable from './characters.js'

const MANIFEST = 'manifest.json'
const CHARS = 'characters.json'

const FIELDS = ['name', 'tags', 'character', 'char_conf', 'score', 'scene', 'target', 'appearance', 'text', 'pinned', 'source']

/** 导出目录（跟 backups/ 分开：backups 是索引快照，exports 是完整包） */
export const EXPORTS = join(ROOT, 'exports')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 导出整个库。
 * @returns {{ok: true, path: string, files: number, items: number, bytes: number}}
 */
export function exportLibrary(db) {
  ensureDirs()
  mkdirSync(EXPORTS, { recursive: true })

  const rows = allItems(db)
  const items = rows.map((r) => ({
    md5: r.md5,
    ext: r.ext,
    path: r.path,
    name: r.name,
    tags: r.tags,
    character: r.character,
    char_conf: r.char_conf,
    score: r.score,
    scene: r.scene,
    target: r.target,
    appearance: r.appearance,
    text: r.text,
    pinned: r.pinned,
    source: r.source,
    created_at: r.created_at,
    analyzed_at: r.analyzed_at,
    model: r.model,
  }))

  const manifest = {
    app: 'dsh-meme-brain',
    version: 1,
    exportedAt: Date.now(),
    count: items.length,
    characters: characterTable.list(),
    items,
  }

  const entries = [
    { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: CHARS, data: Buffer.from(JSON.stringify({ version: 1, items: Object.fromEntries(characterTable.list().map((c) => [c.name, c])) }), 'utf8') },
  ]
  let missing = 0
  for (const r of rows) {
    const file = absPath(r.path)
    if (existsSync(file)) entries.push({ name: `library/${r.md5}.${r.ext}`, file })
    else missing += 1
  }

  const out = join(EXPORTS, `meme-brain-${stamp()}.zip`)
  const r = writeZip(out, entries)
  return {
    ok: true,
    path: out,
    files: r.files,
    items: items.length,
    bytes: r.bytes,
    missing,
  }
}

/** 合并角色表：缺的补上，已有的不动 */
function mergeCharacters(list) {
  let added = 0
  for (const c of list || []) {
    if (!c || !c.name) continue
    if (characterTable.list().some((x) => x.name === c.name)) continue
    characterTable.upsert(c)
    added += 1
  }
  return added
}

const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '' || v === 0

/**
 * 从 zip 导入。
 * @param {object} db
 * @param {{from: string}} opts
 * @returns {{ok: boolean, code?: string, message?: string, added?: number, merged?: number, skipped?: number, chars?: number, missing?: number}}
 */
export function importLibrary(db, opts = {}) {
  const from = String(opts.from || '').trim()
  if (!from) return { ok: false, code: 'E_NO_PATH', message: '要导入哪个文件？' }
  if (!existsSync(from)) return { ok: false, code: 'E_NOT_FOUND', message: `文件不存在：${from}` }
  if (!statSync(from).isFile()) return { ok: false, code: 'E_NOT_FILE', message: '只支持 zip 文件' }

  let entries
  try {
    entries = listZip(from)
  } catch (error) {
    return { ok: false, code: 'E_BAD_ZIP', message: `读不了这个 zip：${error.message}` }
  }

  const manifestEntry = entries.find((e) => e.name === MANIFEST)
  if (!manifestEntry) {
    return { ok: false, code: 'E_NO_MANIFEST', message: '这个包里没有 manifest.json，不是本系统导出的备份' }
  }

  let manifest
  try {
    manifest = JSON.parse(readZipEntry(from, manifestEntry).toString('utf8'))
  } catch (error) {
    return { ok: false, code: 'E_BAD_MANIFEST', message: `manifest.json 解析失败：${error.message}` }
  }
  if (!Array.isArray(manifest.items)) {
    return { ok: false, code: 'E_BAD_MANIFEST', message: 'manifest.json 里没有 items' }
  }

  ensureDirs()
  const chars = mergeCharacters(manifest.characters)

  const byName = new Map(entries.map((e) => [e.name, e]))
  let added = 0
  let merged = 0
  let skipped = 0
  let missing = 0
  const failed = []

  for (const item of manifest.items) {
    if (!item || !item.md5) continue
    const entry = byName.get(`library/${item.md5}.${item.ext}`)
    const existing = getItem(db, item.md5)

    if (existing) {
      // 已有：只补空字段
      const patch = {}
      for (const f of FIELDS) {
        if (isEmpty(existing[f]) && !isEmpty(item[f])) patch[f] = item[f]
      }
      if (Object.keys(patch).length) {
        updateItem(db, item.md5, patch)
        merged += 1
      } else {
        skipped += 1
      }
      continue
    }

    if (!entry) {
      missing += 1
      continue
    }

    try {
      const buf = readZipEntry(from, entry)
      // 字节校验：md5 必须对得上，防止命名和内容不一致
      const real = createHash('md5').update(buf).digest('hex')
      if (real !== item.md5) {
        failed.push({ md5: item.md5, message: '包里的图和 md5 对不上' })
        continue
      }
      const rel = relPathFor(item.md5, item.ext)
      const abs = absPath(rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, buf)
      insertItem(db, {
        md5: item.md5,
        path: rel,
        ext: item.ext,
        bytes: buf.length,
        width: null,
        height: null,
        frames: 1,
        hasAlpha: false,
        dhash: '',
        name: item.name,
        tags: item.tags,
        character: item.character,
        charConf: item.char_conf,
        score: item.score,
        scene: item.scene,
        target: item.target,
        appearance: item.appearance,
        text: item.text,
        pinned: item.pinned ? 1 : 0,
        source: item.source || 'import',
        analyzedAt: item.analyzed_at,
        model: item.model,
      })
      added += 1
    } catch (error) {
      failed.push({ md5: item.md5, message: error.message })
    }
  }

  return { ok: true, added, merged, skipped, missing, chars, failed }
}
