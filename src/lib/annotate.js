// 人工标注：界面上改名字 / 标签 / 角色，以及锁定。
//
// 为什么单独一层（ADR-0005 / G-2）：HTTP 只该做参数校验与转发，
// 「角色要写进角色表」「手工定角色要上锁」这些判断属于业务，放在这里才能被测试和命令复用。

import * as characterTable from './characters.js'
import { findByPrefix, updateItem } from './db.js'

export const MAX_NAME = 60
export const MAX_TAGS = 200
export const MAX_CHARACTER = 20

/** 人工标注的角色把握度：和模型的 高/中/低 区分开，一眼能看出是谁定的 */
export const MANUAL_CONF = '人工'

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

/**
 * 解析人工输入的角色名。
 * - 空 / 「未知」→ 清空角色（交还给模型）
 * - 表里有的（完全相同或别名）→ 用表里的规范名
 * - 表里没有 → 建表项，source 记成 ui
 *
 * @returns {{name: string, created: boolean}}
 */
export function resolveCharacter(raw) {
  const s = clean(raw, MAX_CHARACTER)
  if (!s || s === '未知' || s === '无') return { name: '', created: false }

  const hit = characterTable.matchExact(s)
  if (hit) return { name: hit, created: false }

  characterTable.upsert({ name: s, source: 'ui' })
  return { name: s, created: true }
}

/**
 * 应用一次人工标注。
 *
 * 锁定规则（唯一一条，别再加隐式规则）：
 *   - 设置角色 → pinned = 1（这是唯一会挡住的字段，`analyze --force` 会跳过它）
 *   - 清空角色 → pinned = 0（用户把它交还给模型了）
 *   - 显式 pin:false → 解锁
 * 改名字、改标签都不上锁：`--force` 本来就不碰标签，名字另有 `--rename` 把关。
 *
 * @returns {{ok: boolean, code?: string, message?: string, md5?: string, createdCharacter?: boolean, cleared?: boolean}}
 */
export function annotate(index, input = {}) {
  const { row } = findByPrefix(index, input.md5 || '')
  if (!row) return { ok: false, code: 'E_NOT_FOUND', message: '没有这条记录' }

  const patch = {}
  if (typeof input.name === 'string') patch.name = clean(input.name, MAX_NAME) || null
  if (typeof input.tags === 'string') patch.tags = clean(input.tags, MAX_TAGS) || null

  let createdCharacter = false
  let cleared = false
  if (typeof input.character === 'string') {
    const { name, created } = resolveCharacter(input.character)
    createdCharacter = created
    cleared = !name
    patch.character = name || null
    patch.char_conf = name ? MANUAL_CONF : null
    patch.pinned = name ? 1 : 0
  }
  if (input.pin === false) patch.pinned = 0

  if (!Object.keys(patch).length) return { ok: false, code: 'E_EMPTY_PATCH', message: '没有要改的字段' }

  updateItem(index, row.md5, patch)
  return { ok: true, md5: row.md5, createdCharacter, cleared }
}
