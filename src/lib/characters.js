// 角色表：全局、纯文本、可手改。
//
// 设计（ADR-0011/0012 的延伸）：
//   - 一个条目可以是「角色」（大肥鱼/doro）也可以是「梗/模板」（龙图）；
//   - look 是给模型做闭集判断用的外观特征，不是给人看的简介；
//   - analyz 注入时按 kind 打标签，让模型知道「龙图」是模板不是具体角色。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { ROOT } from './store.js'

export const CHARACTERS_FILE = join(ROOT, 'characters.json')

const EMPTY = { version: 1, items: {} }

/** 最近一次读取失败的原因（体检用；正常时为 null） */
export let lastLoadError = null

/** 读取角色表；文件不存在时返回空表 */
export function load() {
  if (!existsSync(CHARACTERS_FILE)) {
    lastLoadError = null
    return { ...EMPTY, items: {} }
  }
  try {
    // 去掉 BOM：Windows 编辑器（PowerShell 5.1 的 Set-Content 等）会写 \uFEFF，
    // JSON.parse 遇到它会直接抛错，进而被当成"空表"静默丢弃全部数据。
    const text = readFileSync(CHARACTERS_FILE, 'utf8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object') throw new Error('顶层不是对象')
    lastLoadError = null
    return { version: Number(raw.version) || 1, items: raw.items && typeof raw.items === 'object' ? raw.items : {} }
  } catch (error) {
    lastLoadError = `${error.message}（文件：${CHARACTERS_FILE}）`
    return { ...EMPTY, items: {} }
  }
}

/** 原子写入：先写临时文件再改名，避免写一半断电留下坏 JSON */
export function save(db) {
  mkdirSync(dirname(CHARACTERS_FILE), { recursive: true })
  const tmp = `${CHARACTERS_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
  renameSync(tmp, CHARACTERS_FILE)
}

/** 列表（按名字排序） */
export function list() {
  const db = load()
  return Object.entries(db.items)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/**
 * 新增或更新一个条目。
 * @param {{name:string, look?:string, aka?:string[], from?:string, kind?:string}} entry
 */
export function upsert(entry) {
  const name = String(entry?.name || '').trim()
  if (!name) throw new Error('角色名不能为空')
  const db = load()
  const prev = db.items[name] || {}
  db.items[name] = {
    kind: entry.kind || prev.kind || 'character',
    look: entry.look !== undefined ? String(entry.look).trim() : prev.look || '',
    from: entry.from !== undefined ? String(entry.from).trim() : prev.from || '',
    aka: Array.isArray(entry.aka) ? entry.aka : prev.aka || [],
    refs: prev.refs || [],
    source: entry.source || prev.source || 'manual',
    updatedAt: Date.now(),
  }
  save(db)
  return { name, ...db.items[name] }
}

/** 删除 */
export function remove(name) {
  const db = load()
  if (!db.items[name]) return false
  delete db.items[name]
  save(db)
  return true
}

/** 给模型看的名单：最多 limit 条，按 kind 标注 */
export function promptList(limit = 40) {
  const rows = list().filter((c) => c.look || c.name)
  const ordered = [...rows].sort((a, b) => (a.kind === 'meme' ? 1 : 0) - (b.kind === 'meme' ? 1 : 0))
  return ordered.slice(0, limit).map((c) => ({
    name: c.kind === 'meme' ? `${c.name}（梗模板）` : c.name,
    look: c.look || '',
  }))
}

/**
 * 把模型输出的角色名对齐到表里的规范名。
 * 处理：括号后缀（"龙图（梗模板）"）、别名、大小写、包含关系。
 * 对不上返回空串 —— 宁可记为未知，也不要存进一个表里没有的名字。
 */
export function normalizeName(raw) {
  const s = String(raw || '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .trim()
  if (!s) return ''
  const rows = list()
  const lower = s.toLowerCase()

  const exact = rows.find((c) => c.name === s || c.name.toLowerCase() === lower)
  if (exact) return exact.name

  const byAlias = rows.find((c) => (c.aka || []).some((a) => String(a).toLowerCase() === lower))
  if (byAlias) return byAlias.name

  // 包含：只接受长度足够、避免 "猫" 之类过短误配
  const byPart = rows.find((c) => s.length >= 2 && (s.includes(c.name) || c.name.includes(s)))
  return byPart ? byPart.name : ''
}

/**
 * 人工输入用的对齐：只认「完全相同」和「别名」，**不做包含匹配**。
 *
 * 为什么和 normalizeName 分开：模型输出可以猜（"龙图（梗模板）"），
 * 但人在输入框里敲的字就是他想要的——把「大肥鱼飞起」模糊成「大肥鱼」
 * 会把一次明确的人工判断改掉。对不上就是新角色。
 */
export function matchExact(raw) {
  const s = String(raw || '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .trim()
  if (!s) return ''
  const lower = s.toLowerCase()
  const rows = list()
  const exact = rows.find((c) => c.name === s || c.name.toLowerCase() === lower)
  if (exact) return exact.name
  const byAlias = rows.find((c) => (c.aka || []).some((a) => String(a).toLowerCase() === lower))
  return byAlias ? byAlias.name : ''
}
