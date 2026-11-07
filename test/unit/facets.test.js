// 筛选口径测试：待办四类 + 角色 + 未知角色哨兵 + facets 计数。
// 界面筛选条上的每个数字都来自 facets，口径错了界面就会显示错数字。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-f-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')

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
const index = openIndex()

let n = 0
function seed(over = {}) {
  n += 1
  const md5 = String(n).padStart(32, '0')
  db.insertItem(index, {
    md5,
    path: `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.gif`,
    ext: 'gif',
    bytes: 100,
    width: 10,
    height: 10,
    frames: 1,
    hasAlpha: false,
    dhash: '0'.repeat(16),
    state: 'stored',
    createdAt: Date.now(),
    ...over,
  })
  return md5
}

// 4 张各种组合
const named = seed({ name: '有名字', tags: 'a', character: '大肥鱼', charConf: '高', analyzedAt: Date.now() })
const unnamed = seed({ name: null, tags: 'b', character: 'doro', charConf: '高', analyzedAt: Date.now() })
const noTags = seed({ name: '有名字无标签', tags: null, character: null, analyzedAt: null })
seed({ name: null, tags: null, character: null, analyzedAt: null, pinned: 1 })

test('facets：总数、角色分布、未知角色、待办四项都对', () => {
  const f = db.facets(index)
  assert.equal(f.total, 4)
  assert.deepEqual(f.characters, [
    { name: 'doro', count: 1 },
    { name: '大肥鱼', count: 1 },
  ], '角色按张数倒序（同数按名字）')
  assert.equal(f.unknownCharacter, 2)
  assert.deepEqual(f.todo, { unanalyzed: 2, unnamed: 2, notags: 2, nochar: 2 })
  assert.equal(f.pinned, 1)
})

test('todo 筛选：四类各返回对的条目', () => {
  const ids = (opts) => db.queryItems(index, { ...opts, limit: 50 }).rows.map((r) => r.md5)

  assert.equal(ids({ todo: 'unanalyzed' }).length, 2)
  assert.ok(ids({ todo: 'unanalyzed' }).includes(noTags))

  assert.equal(ids({ todo: 'unnamed' }).length, 2)
  assert.ok(ids({ todo: 'unnamed' }).includes(unnamed))

  assert.equal(ids({ todo: 'notags' }).length, 2)
  assert.equal(ids({ todo: 'nochar' }).length, 2)
  assert.ok(ids({ todo: 'nochar' }).includes(noTags))
  assert.ok(!ids({ todo: 'nochar' }).includes(named))
})

test('character 筛选：具名与未知哨兵分开', () => {
  const byChar = db.queryItems(index, { character: '大肥鱼', limit: 50 })
  assert.equal(byChar.total, 1)
  assert.equal(byChar.rows[0].md5, named)

  const unknown = db.queryItems(index, { character: db.UNKNOWN_CHARACTER, limit: 50 })
  assert.equal(unknown.total, 2, '未知角色 = 空值，不含具名条目')
})

test('未知的 todo 值要报错，不能静默返回全部', () => {
  assert.throws(() => db.queryItems(index, { todo: '乱写' }), /未知的 todo 筛选/)
})

test('筛选与搜索可以叠加', () => {
  const r = db.queryItems(index, { todo: 'unanalyzed', q: '有名字', limit: 50 })
  assert.equal(r.total, 1)
  assert.equal(r.rows[0].md5, noTags)
})
