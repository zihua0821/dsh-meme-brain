// 编排层：把「解析 → 判重 → 入库 → 索引」串起来。
//
// 这是唯一允许同时碰 store 与 db 的地方；命令与工具都只调用这里。

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { parseImage } from './parse.js'
import { frameDistance, isDuplicate } from './dhash.js'
import * as store from './store.js'
import * as db from './db.js'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

/** 递归列出目录下的图片文件 */
export function walkImages(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && IMAGE_EXT.has(extname(e.name).toLowerCase())) out.push(p)
    }
  }
  walk(dir)
  return out
}

const toFrames = (dhash) => (Array.isArray(dhash) ? dhash : String(dhash || '').split(',').filter(Boolean))

/**
 * 从一个目录导入图片。
 * 判重发生在**写入之前**（ADR-0004）：命中则不落盘，只记一条事件。
 *
 * @param {object} index 打开的 SQLite
 * @param {string} dir 源目录
 * @param {{dryRun?:boolean, source?:string}} opts
 * @returns {Promise<{scanned:number, added:number, duplicate:number, failed:Array, dryRun:boolean}>}
 */
export async function importDirectory(index, dir, opts = {}) {
  const dryRun = Boolean(opts.dryRun)
  const source = opts.source || 'import'
  const files = walkImages(dir)
  const result = { scanned: files.length, added: 0, duplicate: 0, failed: [], dryRun }

  // 已有指纹载入内存（判重只需要 md5 + dhash）
  const known = new Map()
  for (const row of db.allHashes(index)) known.set(row.md5, toFrames(row.dhash))

  for (const file of files) {
    let buf
    try {
      buf = readFileSync(file)
    } catch (error) {
      result.failed.push({ file, code: 'E_READ', message: error.message })
      continue
    }

    const md5 = createHash('md5').update(buf).digest('hex')
    if (known.has(md5)) {
      result.duplicate++ // 字节完全相同
      continue
    }

    let parsed
    try {
      parsed = await parseImage(buf)
    } catch (error) {
      result.failed.push({ file, code: error.code || 'E_PARSE', message: error.message })
      continue
    }

    // 近似判重
    let near = null
    for (const [otherMd5, otherHash] of known) {
      const d = frameDistance(parsed.dhash, otherHash)
      if (isDuplicate(d)) {
        near = { md5: otherMd5, max: d.max, avg: d.avg }
        break
      }
    }
    if (near) {
      result.duplicate++
      if (!dryRun) {
        db.addEvent(index, {
          action: 'dedupe_blocked',
          detail: JSON.stringify({ file, near: near.md5, max: near.max }),
        })
      }
      continue
    }

    if (dryRun) {
      result.added++
      known.set(md5, parsed.dhash) // 同批内也能互相判重
      continue
    }

    const ext = store.extFor(parsed.format)
    const rel = store.writeImage(md5, ext, buf)
    db.insertItem(index, {
      md5,
      path: rel,
      ext,
      bytes: parsed.bytes,
      width: parsed.width,
      height: parsed.height,
      frames: parsed.frames,
      hasAlpha: parsed.hasAlpha,
      dhash: parsed.dhash.join(','),
      state: 'stored',
      source,
    })
    db.addEvent(index, { md5, action: 'store', detail: JSON.stringify({ file, source }) })
    known.set(md5, parsed.dhash)
    result.added++
  }

  return result
}

/**
 * 从库文件重建索引。
 * 保留已有的人工/分析字段（按 md5 对齐），因此重建不会丢分析结果。
 */
export async function rebuild(index, opts = {}) {
  const preserve = new Map()
  for (const row of db.allItems(index)) {
    preserve.set(row.md5, {
      name: row.name, tags: row.tags, text: row.text, character: row.character,
      char_conf: row.char_conf, score: row.score, scene: row.scene,
      analyzed_at: row.analyzed_at, model: row.model, pinned: row.pinned,
    })
  }

  index.exec('DELETE FROM items')

  const files = store.listLibraryFiles()
  const result = { scanned: files.length, added: 0, failed: [] }
  for (const f of files) {
    const md5 = f.rel.split('/').pop().replace(/\.[^.]+$/, '')
    let parsed
    try {
      parsed = await parseImage(store.readImage(f.rel))
    } catch (error) {
      result.failed.push({ file: f.rel, code: error.code || 'E_PARSE', message: error.message })
      continue
    }
    const keep = preserve.get(md5) || {}
    db.insertItem(index, {
      md5,
      path: f.rel,
      ext: (f.rel.match(/\.([^.]+)$/) || [, 'bin'])[1],
      bytes: f.bytes,
      width: parsed.width,
      height: parsed.height,
      frames: parsed.frames,
      hasAlpha: parsed.hasAlpha,
      dhash: parsed.dhash.join(','),
      state: 'stored',
      source: opts.source || 'rebuild',
      ...keep,
    })
    result.added++
  }
  db.addEvent(index, { action: 'rebuild', detail: JSON.stringify({ scanned: result.scanned, added: result.added }) })
  return result
}

/**
 * 从源目录的 index.json 回填名字与标签（按 md5 对齐）。
 * 默认只填空字段；force=true 时覆盖。
 * @returns {Promise<{available:number, matched:number, updated:number}>}
 */
export async function backfillMeta(index, dir, { force = false } = {}) {
  const metaFile = join(dir, 'index.json')
  if (!existsSync(metaFile)) {
    throw new Error(`源目录下没有 index.json，无法回填：${metaFile}`)
  }
  const source = JSON.parse(readFileSync(metaFile, 'utf8'))
  const items = Array.isArray(source.items) ? source.items : []
  const byMd5 = new Map(items.map((it) => [String(it.md5 || '').toLowerCase(), it]))

  let matched = 0
  let updated = 0
  for (const row of db.allItems(index)) {
    const src = byMd5.get(row.md5)
    if (!src) continue
    matched++
    const patch = {}
    if (src.name && (force || !row.name)) patch.name = String(src.name).slice(0, 60)
    const tags = Array.isArray(src.tags) ? src.tags.join(',') : String(src.tags || '')
    if (tags && (force || !row.tags)) patch.tags = tags.slice(0, 200)
    if (Object.keys(patch).length) {
      db.updateItem(index, row.md5, patch)
      updated++
    }
  }
  db.addEvent(index, { action: 'backfill', detail: JSON.stringify({ dir, matched, updated, force }) })
  return { available: items.length, matched, updated }
}

/**
 * 修复不一致：补录孤儿文件 / 清理失效记录。
 */
export async function repair(index, { orphans = true, missing = true } = {}) {
  const known = new Map(db.allHashes(index).map((r) => [r.path, r]))
  const files = store.listLibraryFiles()
  const onDisk = new Set(files.map((f) => f.rel))
  const out = { adopted: 0, purged: 0, failed: [] }

  if (orphans) {
    for (const f of files) {
      if (known.has(f.rel)) continue
      const md5 = f.rel.split('/').pop().replace(/\.[^.]+$/, '')
      try {
        const parsed = await parseImage(store.readImage(f.rel))
        db.insertItem(index, {
          md5, path: f.rel, ext: (f.rel.match(/\.([^.]+)$/) || [, 'bin'])[1],
          bytes: f.bytes, width: parsed.width, height: parsed.height,
          frames: parsed.frames, hasAlpha: parsed.hasAlpha,
          dhash: parsed.dhash.join(','), state: 'stored', source: 'repair',
        })
        db.addEvent(index, { md5, action: 'adopt_orphan', detail: f.rel })
        out.adopted++
      } catch (error) {
        out.failed.push({ file: f.rel, code: error.code || 'E_PARSE', message: error.message })
      }
    }
  }

  if (missing) {
    for (const row of db.allItems(index)) {
      if (onDisk.has(row.path)) continue
      db.deleteItem(index, row.md5)
      db.addEvent(index, { md5: row.md5, action: 'purge_missing', detail: row.path })
      out.purged++
    }
  }

  return out
}
