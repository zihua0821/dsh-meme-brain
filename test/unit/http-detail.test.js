// 详情投影：界面「看到详细分析结果」的数据来源。
// 这些断言的作用是——以后谁改坏了字段名，界面会先在这里红，而不是让你在页面上发现少了一行。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseScore, detailItem } from '../../src/lib/http.js'

const row = (over = {}) => ({
  md5: 'a'.repeat(32),
  path: 'aa/aa/' + 'a'.repeat(32) + '.gif',
  ext: 'gif',
  bytes: 2048,
  width: 640,
  height: 480,
  frames: 4,
  has_alpha: 1,
  dhash: '0f0f0f0f0f0f0f0f,1111111111111111,2222222222222222',
  name: '大肥鱼生气',
  tags: '生气,瞪眼',
  state: 'stored',
  text: '滚',
  character: '大肥鱼',
  char_conf: '高',
  score: JSON.stringify({ valence: -0.6, arousal: 0.8, aggression: 0.5, intimacy: 0.3, absurdity: 0.2 }),
  scene: '社交,日常',
  analyzed_at: 1794043000000,
  model: 'deepseek-vl',
  source: 'import',
  dup_of: null,
  dup_distance: null,
  pinned: 0,
  created_at: 1794042000000,
  updated_at: 1794043000000,
  target: '对方',
  appearance: '蓝发双马尾、女仆装、蓝色蝴蝶结',
  ...over,
})

test('parseScore：正常 JSON 解析成对象', () => {
  const s = parseScore('{"valence":0.5,"arousal":1}')
  assert.equal(s.valence, 0.5)
  assert.equal(s.arousal, 1)
})

test('parseScore：空值与坏数据都返回 null，不抛错', () => {
  assert.equal(parseScore(null), null)
  assert.equal(parseScore(''), null)
  assert.equal(parseScore('不是JSON'), null)
  assert.equal(parseScore('[1,2]'), null, '数组不是分数对象')
  assert.equal(parseScore('null'), null)
})

test('detailItem：分析字段全部带出来', () => {
  const d = detailItem(row())
  assert.equal(d.character, '大肥鱼')
  assert.equal(d.charConf, '高', 'char_conf 必须翻成 charConf')
  assert.equal(d.appearance, '蓝发双马尾、女仆装、蓝色蝴蝶结')
  assert.equal(d.text, '滚')
  assert.equal(d.target, '对方')
  assert.equal(d.scene, '社交,日常')
  assert.equal(d.score.valence, -0.6)
  assert.equal(d.analyzedAt, 1794043000000)
  assert.equal(d.model, 'deepseek-vl')
  assert.equal(d.hasAlpha, true, 'has_alpha 必须翻成 hasAlpha')
  assert.equal(d.pinned, false)
  assert.equal(d.url, `/meme-brain/api?op=image&md5=${'a'.repeat(32)}`)
})

test('detailItem：未分析的条目返回一致形状（不给界面埋雷）', () => {
  const d = detailItem(row({
    character: null, char_conf: null, score: null, appearance: null,
    text: null, target: null, scene: null, analyzed_at: null, model: null,
  }))
  assert.equal(d.analyzed, false)
  assert.equal(d.score, null)
  assert.equal(d.character, '')
  assert.equal(d.charConf, '')
  assert.equal(d.appearance, '')
  assert.equal(d.scene, '')
  assert.equal(d.model, '')
  assert.equal(d.analyzedAt, null)
})

test('detailItem：score 存坏了也只丢分数，其他字段照旧', () => {
  const d = detailItem(row({ score: '{坏掉的' }))
  assert.equal(d.score, null)
  assert.equal(d.character, '大肥鱼')
  assert.equal(d.analyzed, true)
})

test('detailItem：重复信息带出来', () => {
  const d = detailItem(row({ dup_of: 'b'.repeat(32), dup_distance: 2 }))
  assert.equal(d.dupOf, 'b'.repeat(32))
  assert.equal(d.dupDistance, 2)
})

test('detailItem：保留字面量 0 的分数（不能被 ?? 或 || 吃掉）', () => {
  const d = detailItem(row({ score: JSON.stringify({ valence: 0, arousal: 0 }) }))
  assert.equal(d.score.valence, 0)
  assert.equal(d.score.arousal, 0)
})
