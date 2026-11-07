// 人工标注：界面上改任何字段，以及锁定。
//
// 为什么单独一层（ADR-0005 / G-2）：HTTP 只该做参数校验与转发，
// 「角色要写进角色表」「手工改模型字段要上锁」这些判断属于业务，放在这里才能被测试和命令复用。
//
// 字段分两类（决定了要不要上锁）：
//   人工字段：name / tags —— `analyze --force` 本来就不碰它们，所以不上锁
//   模型字段：character / appearance / text / scene / target / score
//             —— 一旦人工改过就 pinned=1，否则下一次 `--force` 会把人的判断冲掉

import * as characterTable from './characters.js'
import { findByPrefix, updateItem } from './db.js'
import { SCORE_KEYS, TARGETS, SCENES } from './analyze.js'

export const MAX_NAME = 60
export const MAX_TAGS = 200
export const MAX_CHARACTER = 20
export const MAX_APPEARANCE = 60
export const MAX_TEXT = 100

/** 人工标注的角色把握度：和模型的 高/中/低 区分开，一眼能看出是谁定的 */
export const MANUAL_CONF = '人工'

/** 模型字段：人工改过就要上锁 */
export const MODEL_FIELDS = ['character', 'appearance', 'text', 'scene', 'target', 'score']

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

/** 手输「无」等于清空（和模型输出一致），免得把「无」当内容存进去 */
const cleanOrNull = (v, max) => {
  const s = clean(v, max)
  return !s || s === '无' ? null : s
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * 解析人工输入的分数。
 * 接受对象 `{valence: 0.5}` 或字符串 `valence:0.5,arousal:0.3`（命令用）。
 * 只返回**给了的维度**，没给的保留原值（部分修改）。
 *
 * @returns {{values: object, invalid: string[]}}
 */
export function resolveScore(raw) {
  const out = {}
  const invalid = []
  if (raw === undefined || raw === null || raw === '') return { values: out, invalid }

  let pairs = []
  if (typeof raw === 'string') {
    pairs = raw.split(/[,;]+/).map((s) => s.split(':')).filter((p) => p.length === 2)
  } else if (typeof raw === 'object') {
    pairs = Object.entries(raw)
  } else {
    return { values: out, invalid: ['score'] }
  }

  for (const [k, v] of pairs) {
    const key = String(k).trim().toLowerCase()
    if (!SCORE_KEYS.includes(key)) {
      invalid.push(key)
      continue
    }
    const n = Number(String(v).trim())
    if (!Number.isFinite(n)) {
      invalid.push(key)
      continue
    }
    const lo = key === 'valence' ? -1 : 0
    out[key] = Math.round(clamp(n, lo, 1) * 100) / 100
  }
  return { values: out, invalid }
}

/** 场景：只认规定的那几个，逗号分隔，去重，最多 3 个 */
export function resolveScene(raw) {
  const list = String(raw ?? '')
    .split(/[,，/\s]+/)
    .map((s) => s.trim())
    .filter((s) => SCENES.includes(s))
  return [...new Set(list)].slice(0, 3).join(',')
}

/** 指向：只认四个之一，非法返回 null（表示不改） */
export function resolveTarget(raw) {
  const s = String(raw ?? '').trim()
  return TARGETS.includes(s) ? s : null
}

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
 * 应用一次人工标注。任何字段都能改 —— 名字、标签、角色、外观、图上文字、场景、指向、五维分数。
 *
 * 锁定规则：
 *   - 改了任一**模型字段** → pinned = 1（挡住 `analyze --force`）
 *   - 显式 pin:false → 解锁
 *   - 改名字 / 标签 → 不动锁定状态
 *   - 清空角色 → 解锁（把这一项交还给模型）
 *
 * @returns {{ok: boolean, code?: string, message?: string, md5?: string,
 *            createdCharacter?: boolean, cleared?: boolean, changed?: string[]}}
 */
export function annotate(index, input = {}) {
  const { row } = findByPrefix(index, input.md5 || '')
  if (!row) return { ok: false, code: 'E_NOT_FOUND', message: '没有这条记录' }

  const patch = {}
  const changed = []

  if (typeof input.name === 'string') {
    patch.name = clean(input.name, MAX_NAME) || null
    changed.push('name')
  }
  if (typeof input.tags === 'string') {
    patch.tags = clean(input.tags, MAX_TAGS) || null
    changed.push('tags')
  }

  let createdCharacter = false
  let cleared = false
  if (typeof input.character === 'string') {
    const { name, created } = resolveCharacter(input.character)
    createdCharacter = created
    cleared = !name
    patch.character = name || null
    patch.char_conf = name ? MANUAL_CONF : null
    patch.pinned = name ? 1 : 0
    changed.push('character')
  }

  // 外观 / 图上文字：空字符串或「无」= 清掉
  if (typeof input.appearance === 'string') {
    patch.appearance = cleanOrNull(input.appearance, MAX_APPEARANCE)
    changed.push('appearance')
  }
  if (typeof input.text === 'string') {
    patch.text = cleanOrNull(input.text, MAX_TEXT)
    changed.push('text')
  }
  if (typeof input.scene === 'string') {
    patch.scene = resolveScene(input.scene) || null
    changed.push('scene')
  }
  if (input.target !== undefined && input.target !== null) {
    const t = resolveTarget(input.target)
    if (t) {
      patch.target = t
      changed.push('target')
    }
  }

  // 分数：和已有分数合并（只改给了的维度）
  if (input.score !== undefined && input.score !== null && input.score !== '') {
    const { values } = resolveScore(input.score)
    if (Object.keys(values).length) {
      let current = {}
      try {
        current = row.score ? JSON.parse(row.score) : {}
      } catch {
        current = {}
      }
      patch.score = JSON.stringify({ ...current, ...values })
      changed.push('score')
    }
  }

  // 改过任何模型字段就上锁（角色已单独处理过，这里只补其余的）
  if (changed.some((k) => MODEL_FIELDS.includes(k)) && patch.pinned === undefined) {
    patch.pinned = 1
  }
  if (input.pin === false) patch.pinned = 0

  if (!Object.keys(patch).length) return { ok: false, code: 'E_EMPTY_PATCH', message: '没有要改的字段' }

  updateItem(index, row.md5, patch)
  return { ok: true, md5: row.md5, createdCharacter, cleared, changed }
}
