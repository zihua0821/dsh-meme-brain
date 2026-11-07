// 人工标注的规则测试：写进角色表、上锁、解锁、清空。
//
// 这些规则是「手工判断不被模型的下一轮覆盖」的唯一保障，所以逐条钉住。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-a-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const annotateLib = await import('../../src/lib/annotate.js')
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

/** 造一条最小记录 */
function seed(index, md5, over = {}) {
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
  return db.getItem(index, md5)
}

const A = '1'.repeat(32)
const B = '2'.repeat(32)

test('角色表里有：用规范名，不新建', () => {
  mkdirSync(store.ROOT, { recursive: true })
  writeFileSync(characterTable.CHARACTERS_FILE, JSON.stringify({
    version: 1,
    items: { 大肥鱼: { kind: 'character', look: '蓝发', aka: ['鱼鱼'] } },
  }), 'utf8')

  const r = annotateLib.resolveCharacter('大肥鱼')
  assert.deepEqual(r, { name: '大肥鱼', created: false })

  const alias = annotateLib.resolveCharacter('鱼鱼')
  assert.deepEqual(alias, { name: '大肥鱼', created: false }, '别名要映射到规范名')

  const padded = annotateLib.resolveCharacter('  大肥鱼  ')
  assert.equal(padded.name, '大肥鱼', '首尾空格要吃掉')
})

test('角色表里没有：新建一条，出处记成 ui', () => {
  const r = annotateLib.resolveCharacter('耄耋')
  assert.deepEqual(r, { name: '耄耋', created: true })

  const rows = characterTable.list()
  const added = rows.find((c) => c.name === '耄耋')
  assert.ok(added, '角色表里出现了新条目')
  assert.equal(added.source, 'ui', '人工建的条目出处要能区分')
})

test('人工输入不做模糊匹配：「大肥鱼飞起」不会被吞成「大肥鱼」', () => {
  const r = annotateLib.resolveCharacter('大肥鱼飞起')
  assert.equal(r.name, '大肥鱼飞起', '人工明确写的名字要原样保留')
  assert.equal(r.created, true)
})

test('空 / 未知 / 无：清空角色，不建表项', () => {
  for (const v of ['', '   ', '未知', '无']) {
    assert.deepEqual(annotateLib.resolveCharacter(v), { name: '', created: false }, `输入 ${JSON.stringify(v)}`)
  }
})

test('改角色 → 上锁，把握度标为「人工」', () => {
  const index = openIndex()
  seed(index, A, { name: '某张图', character: null })

  const r = annotateLib.annotate(index, { md5: A.slice(0, 8), character: '大肥鱼' })
  assert.equal(r.ok, true)
  assert.equal(r.createdCharacter, false)

  const row = db.getItem(index, A)
  assert.equal(row.character, '大肥鱼')
  assert.equal(row.char_conf, '人工')
  assert.equal(row.pinned, 1, '人工定角色必须上锁')
})

test('清空角色 → 解锁并交还给模型', () => {
  const index = openIndex()
  seed(index, B, { name: '另一张', character: '大肥鱼', charConf: '人工', pinned: 1 })

  const r = annotateLib.annotate(index, { md5: B.slice(0, 8), character: '' })
  assert.equal(r.ok, true)
  assert.equal(r.cleared, true)

  const row = db.getItem(index, B)
  assert.equal(row.character, null)
  assert.equal(row.char_conf, null)
  assert.equal(row.pinned, 0, '交还给模型就要解锁')
})

test('只改名字 → 不动角色，也不上锁', () => {
  const index = openIndex()
  seed(index, '3'.repeat(32), { name: '旧名', character: '耄耋', charConf: '中', pinned: 0 })

  const r = annotateLib.annotate(index, { md5: '3'.repeat(32).slice(0, 8), name: '新名' })
  assert.equal(r.ok, true)

  const row = db.getItem(index, '3'.repeat(32))
  assert.equal(row.name, '新名')
  assert.equal(row.character, '耄耋', '没提交角色就不能动它')
  assert.equal(row.pinned, 0, '只改名不该上锁')
})

test('显式 pin:false → 解锁；没有任何字段 → 报空补丁', () => {
  const index = openIndex()
  seed(index, '4'.repeat(32), { name: '锁着的', character: 'doro', charConf: '人工', pinned: 1 })

  const unlock = annotateLib.annotate(index, { md5: '4'.repeat(32).slice(0, 8), pin: false })
  assert.equal(unlock.ok, true)
  assert.equal(db.getItem(index, '4'.repeat(32)).pinned, 0)

  const empty = annotateLib.annotate(index, { md5: '4'.repeat(32), })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'E_EMPTY_PATCH')

  const missing = annotateLib.annotate(index, { md5: 'ffffffff', name: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'E_NOT_FOUND')
})

test('名字与标签会被裁剪（换行、超长）', () => {
  const index = openIndex()
  const md5 = '5'.repeat(32)
  seed(index, md5)

  annotateLib.annotate(index, { md5, name: '第一行\n第二行', tags: 'x'.repeat(500) })
  const row = db.getItem(index, md5)
  assert.ok(!row.name.includes('\n'), '换行被换成空格')
  assert.equal(row.name, '第一行 第二行')
  assert.equal(row.tags.length, annotateLib.MAX_TAGS)
})

// ---- 分析结果与评分也能人工改 ----

test('改外观 / 图上文字 / 场景 / 指向：都写进去，并且上锁', () => {
  const index = openIndex()
  const md5 = '6'.repeat(32)
  seed(index, md5, { pinned: 0, analyzedAt: Date.now() })

  const r = annotateLib.annotate(index, {
    md5,
    appearance: '蓝发双马尾、女仆装（手改）',
    text: '无所谓 反正我不要脸',
    scene: '吃饭,日常,乱写的场景',
    target: '对方',
  })
  assert.equal(r.ok, true)

  const row = db.getItem(index, md5)
  assert.equal(row.appearance, '蓝发双马尾、女仆装（手改）')
  assert.equal(row.text, '无所谓 反正我不要脸')
  assert.equal(row.scene, '吃饭,日常', '只认规定的场景，非法值被丢掉')
  assert.equal(row.target, '对方')
  assert.equal(row.pinned, 1, '改模型字段必须上锁，挡住 --force')
})

test('外观写「无」等于清空；指向非法就不改', () => {
  const index = openIndex()
  const md5 = '7'.repeat(32)
  seed(index, md5, { appearance: '原来有', target: '自己', pinned: 0 })

  annotateLib.annotate(index, { md5, appearance: '无' })
  let row = db.getItem(index, md5)
  assert.equal(row.appearance, null, '「无」= 清空，而不是存一个「无」字')

  annotateLib.annotate(index, { md5, target: '外星人' })
  row = db.getItem(index, md5)
  assert.equal(row.target, '自己', '非法指向不改')
})

test('改分数：只动给了的维度，其余保留；越界会夹回范围', () => {
  const index = openIndex()
  const md5 = '8'.repeat(32)
  seed(index, md5, {
    pinned: 0,
    score: JSON.stringify({ valence: 0.1, arousal: 0.2, aggression: 0.3, intimacy: 0.4, absurdity: 0.5 }),
  })

  const r = annotateLib.annotate(index, { md5, score: { valence: -3, arousal: 9 } })
  assert.equal(r.ok, true)
  const score = JSON.parse(db.getItem(index, md5).score)
  assert.equal(score.valence, -1, 'valence 夹到 -1')
  assert.equal(score.arousal, 1, 'arousal 夹到 1')
  assert.equal(score.aggression, 0.3, '没给的维度保留原值')
  assert.equal(score.absurdity, 0.5)
})

test('分数也接受命令里的字符串写法', () => {
  const { values, invalid } = annotateLib.resolveScore('valence:0.5,arousal:0.25,乱写:1')
  assert.deepEqual(values, { valence: 0.5, arousal: 0.25 })
  assert.deepEqual(invalid, ['乱写'])
})

test('只改名字/标签时仍然不上锁（不误锁模型判断）', () => {
  const index = openIndex()
  const md5 = '9'.repeat(32)
  seed(index, md5, { name: '旧', pinned: 0, appearance: '模型写的外观' })

  const r = annotateLib.annotate(index, { md5, name: '新名字', tags: '甲,乙' })
  assert.equal(r.ok, true)
  assert.deepEqual((r.changed || []).sort(), ['name', 'tags'])
  const row = db.getItem(index, md5)
  assert.equal(row.pinned, 0, '只改人工字段不该上锁')
  assert.equal(row.appearance, '模型写的外观', '没提交外观就别动它')
})

test('reset：pin:false 能解锁', () => {
  const index = openIndex()
  const md5 = 'a'.repeat(31) + '1'
  seed(index, md5, { pinned: 1 })
  annotateLib.annotate(index, { md5, pin: false })
  assert.equal(db.getItem(index, md5).pinned, 0)
})
