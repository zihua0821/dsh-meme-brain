// 角色表种子：新装的人不该拿到空表
//
// 这一组测试的顺序有意义：同一个临时数据目录里依次走过
// 「空目录 → 种入 → 又加了人 → 文件坏掉」，后者依赖前者留下的状态。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-seed-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const ch = await import('../../src/lib/characters.js')

after(() => rmSync(tmpRoot, { recursive: true, force: true }))

test('种子文件随包发布，格式是 {version, items}', () => {
  assert.ok(existsSync(ch.SEED_FILE), `找不到种子：${ch.SEED_FILE}`)
  const raw = JSON.parse(readFileSync(ch.SEED_FILE, 'utf8'))
  assert.equal(typeof raw.version, 'number')
  assert.equal(typeof raw.items, 'object')
  assert.ok(Object.keys(raw.items).length >= 30, '种子至少要有 30 条（当前 38）')
})

test('空数据目录：首次种入全部角色，并落盘成可手改的 JSON', () => {
  const r = ch.seedIfMissing()
  assert.equal(r.error, undefined)
  assert.equal(r.seeded, true)
  assert.ok(r.count >= 30)

  const rows = ch.list()
  assert.equal(rows.length, r.count)
  assert.ok(rows.some((c) => c.name === '大肥鱼'), '种子里的角色应该能读到')
  assert.ok(existsSync(ch.CHARACTERS_FILE), '种子要真的写进数据目录')
})

test('再调一次：不重复种，也不改动已有条目', () => {
  ch.upsert({ name: '我后来加的角色', look: '自己写的' })
  const before = readFileSync(ch.CHARACTERS_FILE, 'utf8')

  const r = ch.seedIfMissing()
  assert.equal(r.seeded, false)
  assert.equal(readFileSync(ch.CHARACTERS_FILE, 'utf8'), before, '已有角色表必须一个字节都不动')
  assert.ok(ch.list().some((c) => c.name === '我后来加的角色'))
})

test('已有文件坏掉时也不拿种子盖掉（人工数据优先）', () => {
  writeFileSync(ch.CHARACTERS_FILE, '{ 这不是合法 JSON', 'utf8')
  const before = readFileSync(ch.CHARACTERS_FILE, 'utf8')

  const r = ch.seedIfMissing()
  assert.equal(r.seeded, false)
  assert.equal(readFileSync(ch.CHARACTERS_FILE, 'utf8'), before, '坏文件也不能被静默覆盖')
})
