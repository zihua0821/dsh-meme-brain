// 角色表的写操作：新增 / 修改 / 改名 / 删除。
//
// 这些规则改的是**模型的候选空间**，错一条就会让「认角色」整体跑偏，所以逐条钉住。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-ce-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const charEdit = await import('../../src/lib/charEdit.js')
const characterTable = await import('../../src/lib/characters.js')

const opened = []
const openIndex = () => {
  const index = db.openDb(store.INDEX_DB)
  opened.push(index)
  return index
}

after(() => {
  for (const index of opened) {
    try {
      index.close?.()
    } catch {
      /* 已关闭 */
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

store.ensureDirs()

function seed(index, md5, over = {}) {
  db.insertItem(index, {
    md5,
    path: `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.gif`,
    ext: 'gif', bytes: 100, width: 10, height: 10, frames: 1, hasAlpha: false,
    dhash: '0'.repeat(16), state: 'stored', createdAt: Date.now(),
    ...over,
  })
  return db.getItem(index, md5)
}

test('新增：写进表里，kind / look / from / aka 都在', () => {
  const index = openIndex()
  const r = charEdit.saveCharacter(index, {
    name: '测试角色', kind: 'character', look: '蓝色短发、白衬衫', from: '测试', aka: '阿测,小测',
  })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)

  const row = characterTable.list().find((c) => c.name === '测试角色')
  assert.ok(row)
  assert.equal(row.kind, 'character')
  assert.equal(row.look, '蓝色短发、白衬衫')
  assert.equal(row.from, '测试')
  assert.deepEqual(row.aka, ['阿测', '小测'])
})

test('修改：只改给的字段，没给的保留', () => {
  const index = openIndex()
  charEdit.saveCharacter(index, { name: '测试角色', look: '改过的外观' })
  const row = characterTable.list().find((c) => c.name === '测试角色')
  assert.equal(row.look, '改过的外观')
  assert.equal(row.from, '测试', '没传 from 就保留')
  assert.deepEqual(row.aka, ['阿测', '小测'], '没传 aka 也保留')
})

test('新增：空名字被拒绝', () => {
  const index = openIndex()
  const r = charEdit.saveCharacter(index, { name: '   ' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_EMPTY_NAME')
})

test('改名：库里引用旧名的条目一起改，并且上锁', () => {
  const index = openIndex()
  const a = 'a1'.repeat(16)
  const b = 'b2'.repeat(16)
  seed(index, a, { character: '测试角色', charConf: '高' })
  seed(index, b, { character: '测试角色', charConf: '高' })

  const r = charEdit.saveCharacter(index, { name: '新名字', originalName: '测试角色' })
  assert.equal(r.ok, true)
  assert.equal(r.renamedFrom, '测试角色')
  assert.equal(r.moved, 2, '两张图跟着改')

  assert.ok(!characterTable.list().some((c) => c.name === '测试角色'), '旧名从表里消失')
  assert.ok(characterTable.list().some((c) => c.name === '新名字'), '新名在表里')

  for (const md5 of [a, b]) {
    const row = db.getItem(index, md5)
    assert.equal(row.character, '新名字', '条目的角色跟着改了')
    assert.equal(row.char_conf, '人工', '改名的把握标人工')
    assert.equal(row.pinned, 1, '改名顺手锁定，挡住 --force')
  }
})

test('改名：目标名字已被占用时拒绝', () => {
  const index = openIndex()
  charEdit.saveCharacter(index, { name: '占位的' })
  const r = charEdit.saveCharacter(index, { name: '占位的', originalName: '新名字' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NAME_TAKEN')
})

test('改名：原名不存在时拒绝（避免静默新建）', () => {
  const index = openIndex()
  const r = charEdit.saveCharacter(index, { name: '随便', originalName: '根本不存在的角色' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_FOUND')
})

test('删除：库里还有图在用就拒绝，并说明有几张', () => {
  const index = openIndex()
  const r = charEdit.removeCharacter(index, '新名字')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_IN_USE')
  assert.equal(r.count, 2)
  assert.match(r.message, /还有 2 张/)
  assert.ok(characterTable.list().some((c) => c.name === '新名字'), '拒绝了就不能真删')
})

test('删除：force 才清空引用并删掉条目', () => {
  const index = openIndex()
  const r = charEdit.removeCharacter(index, '新名字', { force: true })
  assert.equal(r.ok, true)
  assert.equal(r.cleared, 2)
  assert.ok(!characterTable.list().some((c) => c.name === '新名字'))

  for (const md5 of ['a1'.repeat(16), 'b2'.repeat(16)]) {
    const row = db.getItem(index, md5)
    assert.equal(row.character, null, '引用被清空')
    assert.equal(row.char_conf, null)
  }
})

test('删除：不存在的角色返回 E_NOT_FOUND', () => {
  const index = openIndex()
  const r = charEdit.removeCharacter(index, '从来没建过')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_FOUND')
})
