// 存储层：唯一库的字节读写。只碰文件系统，不做任何判断。
//
// 布局：~/.dsh/meme-brain/library/<md5前2>/<md5次2>/<md5>.<ext>
// 软删除：移到 ~/.dsh/meme-brain/trash/

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { homedir } from 'node:os'

// 库根目录可用环境变量覆盖，便于测试时指向临时目录
export const ROOT = process.env.DSH_MEME_BRAIN_ROOT || join(homedir(), '.dsh', 'meme-brain')
export const LIBRARY = join(ROOT, 'library')
export const TRASH = join(ROOT, 'trash')
export const INDEX_DB = join(ROOT, 'index.db')
export const CHARACTERS = join(ROOT, 'characters.json')
export const BACKUPS = join(ROOT, 'backups')

/** 建目录（幂等） */
export function ensureDirs() {
  for (const d of [LIBRARY, TRASH, BACKUPS]) mkdirSync(d, { recursive: true })
}

const EXT_OF = { jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', tiff: 'tiff', heif: 'heif' }

/** 解析出的格式 → 落盘扩展名 */
export function extFor(format) {
  return EXT_OF[String(format || '').toLowerCase()] || 'bin'
}

/** md5 + 扩展名 → 库内相对路径（两级分桶，避免单目录过大） */
export function relPathFor(md5, ext) {
  return `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.${ext}`
}

/** 相对路径 → 绝对路径 */
export function absPath(rel) {
  return join(LIBRARY, rel)
}

/** 写入图片，返回库内相对路径 */
export function writeImage(md5, ext, buf) {
  const rel = relPathFor(md5, ext)
  const abs = absPath(rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  return rel
}

export function readImage(rel) {
  return readFileSync(absPath(rel))
}

export function imageExists(rel) {
  return existsSync(absPath(rel))
}

export function imageBytes(rel) {
  try {
    return statSync(absPath(rel)).size
  } catch {
    return 0
  }
}

/** 软删除：移动到 trash/，保留原文件名 */
export function moveToTrash(rel) {
  const from = absPath(rel)
  if (!existsSync(from)) return false
  mkdirSync(TRASH, { recursive: true })
  const to = join(TRASH, rel.replace(/[\\/]/g, '_'))
  renameSync(from, to)
  return true
}

/** 递归列出库内所有图片 */
export function listLibraryFiles() {
  const out = []
  if (!existsSync(LIBRARY)) return out
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        const rel = relative(LIBRARY, abs).replace(/\\/g, '/')
        if (extname(e.name)) out.push({ rel, abs, bytes: statSync(abs).size })
      }
    }
  }
  walk(LIBRARY)
  return out
}

/** 磁盘占用（library 总体积） */
export function libraryUsage() {
  return listLibraryFiles().reduce((sum, f) => sum + f.bytes, 0)
}
