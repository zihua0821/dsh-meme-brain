// 角色表的读写与提示词投影
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-ch-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const ch = await import('../../src/lib/characters.js')

after(() => rmSync(tmpRoot, { recursive: true, force: true }))

test('空表：list 为空，promptList 为空', () => {
  assert.deepEqual(ch.list(), [])
  assert.deepEqual(ch.promptList(), [])
})

test('新增后能读到，并落盘成可手改的 JSON', () => {
  ch.upsert({ name: '大肥鱼', look: '蓝发双马尾、女仆装、鱼尾', from: '本机人设' })
  const rows = ch.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '大肥鱼')
  assert.equal(rows[0].kind, 'character')

  assert.ok(existsSync(ch.CHARACTERS_FILE))
  const raw = JSON.parse(readFileSync(ch.CHARACTERS_FILE, 'utf8'))
  assert.equal(raw.items['大肥鱼'].look, '蓝发双马尾、女仆装、鱼尾')
})

test('梗模板在提示词里带标注', () => {
  ch.upsert({ name: '龙图', look: '黑白熊猫头贴真人脸', kind: 'meme' })
  const list = ch.promptList()
  const names = list.map((c) => c.name)
  assert.ok(names.includes('大肥鱼'))
  assert.ok(names.includes('龙图（梗模板）'), '梗模板应带标注，避免模型当成具体角色')
})

test('重复 upsert 是更新而不是新增', () => {
  ch.upsert({ name: '大肥鱼', look: '新描述' })
  assert.equal(ch.list().length, 2)
  assert.equal(ch.list().find((c) => c.name === '大肥鱼').look, '新描述')
})

test('空名字被拒绝', () => {
  assert.throws(() => ch.upsert({ name: '   ' }), /不能为空/)
})

test('删除', () => {
  assert.equal(ch.remove('龙图'), true)
  assert.equal(ch.remove('龙图'), false)
  assert.equal(ch.list().length, 1)
})

test('promptList 有上限', () => {
  for (let i = 0; i < 60; i++) ch.upsert({ name: `角色${i}`, look: 'x' })
  assert.ok(ch.promptList(40).length <= 40)
})

test('规范化：剥后缀、认别名、拒收表外名字', () => {
  ch.upsert({ name: '龙图', kind: 'meme', look: '熊猫头' })
  ch.upsert({ name: '大肥鱼', aka: ['鱼鱼'], look: '蓝发' })

  assert.equal(ch.normalizeName('龙图（梗模板）'), '龙图', '应剥掉提示词里的标注')
  assert.equal(ch.normalizeName('大肥鱼（角色）'), '大肥鱼')
  assert.equal(ch.normalizeName('鱼鱼'), '大肥鱼', '别名应归一到正式名')
  assert.equal(ch.normalizeName('DORO'), '', '表里没有就返回空')
  assert.equal(ch.normalizeName(''), '')
  assert.equal(ch.normalizeName('未知'), '', '「未知」不是角色')
})

test('带 BOM 的文件也能读（Windows 编辑器常写 BOM）', () => {
  // 先造一个带 BOM 的合法 JSON
  const payload = { version: 1, items: { 测试角色: { kind: 'character', look: '红发', aka: [], refs: [] } } }
  writeFileSync(ch.CHARACTERS_FILE, '\uFEFF' + JSON.stringify(payload), 'utf8')
  const rows = ch.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '测试角色')
  assert.equal(ch.lastLoadError, null)
})

test('坏 JSON 不炸，但会记录原因', () => {
  writeFileSync(ch.CHARACTERS_FILE, '{ 这不是合法 JSON', 'utf8')
  assert.deepEqual(ch.list(), [])
  assert.ok(ch.lastLoadError, '应记录解析失败原因，便于体检发现')
})
