// 角色表的写操作：新增 / 修改 / 改名 / 删除。
//
// 为什么单独一层（ADR-0005 / G-2）：
//   - 角色表是**闭集**，模型只能从里面选；改它等于改模型的候选空间，属于业务判断
//   - 「改名要连带动库里引用它的条目」「删除前要看有没有人在用」这些都不是 HTTP 该做的事
//   - 命令和界面都调这里，保证两条入口行为一致（G-1）

import * as characterTable from './characters.js'
import { updateItem } from './db.js'

export const MAX_CHAR_NAME = 20
export const MAX_LOOK = 80
export const MAX_FROM = 40

const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

/** 库里有多少张标着这个角色 */
export function countUsing(index, name) {
  return Number(index.prepare('SELECT COUNT(*) AS n FROM items WHERE character = ?').get(name)?.n || 0)
}

/**
 * 新增或修改一个角色。
 * 传 `originalName` 且与新名字不同 = 改名：角色表里的条目改名，**并且把库里引用旧名的条目一起改**，
 * 否则那些图会指向一个已经不存在的角色（闭集里查不到 → 变成未知）。
 *
 * @returns {{ok:boolean, code?:string, message?:string, name?:string, created?:boolean, renamedFrom?:string, moved?:number}}
 */
export function saveCharacter(index, input = {}) {
  const name = clean(input.name, MAX_CHAR_NAME)
  if (!name) return { ok: false, code: 'E_EMPTY_NAME', message: '角色名不能为空' }

  const original = clean(input.originalName, MAX_CHAR_NAME)
  const renaming = Boolean(original) && original !== name

  if (renaming && !characterTable.list().some((c) => c.name === original)) {
    return { ok: false, code: 'E_NOT_FOUND', message: `角色表里没有「${original}」，没法改名` }
  }
  if (renaming && characterTable.list().some((c) => c.name === name)) {
    return { ok: false, code: 'E_NAME_TAKEN', message: `已经有一个叫「${name}」的角色了` }
  }

  const existed = characterTable.list().some((c) => c.name === name)
  characterTable.upsert({
    name,
    look: typeof input.look === 'string' ? clean(input.look, MAX_LOOK) : undefined,
    from: typeof input.from === 'string' ? clean(input.from, MAX_FROM) : undefined,
    kind: input.kind === 'meme' || input.kind === 'character' ? input.kind : undefined,
    aka: Array.isArray(input.aka)
      ? input.aka.map((a) => clean(a, MAX_CHAR_NAME)).filter(Boolean)
      : (typeof input.aka === 'string'
        ? input.aka.split(/[,，;；\s]+/).map((a) => clean(a, MAX_CHAR_NAME)).filter(Boolean)
        : undefined),
    source: 'ui',
  })

  let moved = 0
  if (renaming) {
    characterTable.remove(original)
    const rows = index.prepare('SELECT md5 FROM items WHERE character = ?').all(original)
    for (const r of rows) {
      // 改名也算人工决定：把握标人工、顺手锁定，别让下一次 --force 又改回旧名
      updateItem(index, r.md5, { character: name, char_conf: '人工', pinned: 1 })
      moved += 1
    }
  }

  return { ok: true, name, created: !existed && !renaming, renamedFrom: renaming ? original : '', moved }
}

/**
 * 删除一个角色。
 * 库里还有图标着它时默认**拒绝**（删了那些图会变成「未知」，是静默的数据变化）；
 * 显式 force 才允许，并把这些图的角色清空。
 */
export function removeCharacter(index, name, opts = {}) {
  const target = clean(name, MAX_CHAR_NAME)
  if (!target) return { ok: false, code: 'E_EMPTY_NAME', message: '要删哪个角色？' }
  if (!characterTable.list().some((c) => c.name === target)) {
    return { ok: false, code: 'E_NOT_FOUND', message: `角色表里没有「${target}」` }
  }

  const used = countUsing(index, target)
  if (used && !opts.force) {
    return {
      ok: false,
      code: 'E_IN_USE',
      message: `库里还有 ${used} 张标着「${target}」。先把它们改掉，或者用 --force 一起清空`,
      count: used,
    }
  }

  if (used) {
    for (const r of index.prepare('SELECT md5 FROM items WHERE character = ?').all(target)) {
      updateItem(index, r.md5, { character: null, char_conf: null })
    }
  }
  characterTable.remove(target)
  return { ok: true, name: target, cleared: used }
}
