// 检索层测试：这是 AI 工具、命令、以后 QQ 共用的判断，错了三处一起错。
//
// 重点不是「能查出东西」，而是三条容易退化的行为：
//   1. 「生气的大肥鱼」必须拆成 角色 + 情绪（不然 27 张同角色图只剩 4 张）
//   2. 情绪排序必须真的有方向（生气应排在开心前面）
//   3. 搜不到就老实说没有，不能拿无关的图凑数

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-s-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const searchLib = await import('../../src/lib/search.js')
const { formatSearch } = await import('../../src/lib/query.js')

const index = db.openDb(store.INDEX_DB)
after(() => {
  try {
    index.close?.()
  } catch {
    /* 已关闭 */
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

store.ensureDirs()

let n = 0
const seed = (over = {}) => {
  n += 1
  const md5 = String(n).padStart(32, '0')
  db.insertItem(index, {
    md5,
    path: `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.gif`,
    ext: 'gif', bytes: 100, width: 10, height: 10, frames: 1, hasAlpha: false,
    dhash: '0'.repeat(16), state: 'stored', analyzedAt: Date.now(),
    createdAt: Date.now() + n,
    ...over,
  })
  return md5
}

const angryFish = seed({
  name: '举刀的女仆', character: '大肥鱼', appearance: '蓝发双马尾、手持长刀',
  score: JSON.stringify({ valence: -0.2, arousal: 0.8, aggression: 0.9, intimacy: 0.3, absurdity: 0.3 }),
})
const happyFish = seed({
  name: '开心炫饭', character: '大肥鱼', appearance: '蓝发、端着饭碗', tags: '干饭',
  score: JSON.stringify({ valence: 0.9, arousal: 0.5, aggression: 0.0, intimacy: 0.6, absurdity: 0.2 }),
})
const otherChar = seed({
  name: '熊猫头说无所谓', character: '龙图', text: '无所谓 反正我不要脸',
  score: JSON.stringify({ valence: 0.1, arousal: 0.5, aggression: 0.6, intimacy: 0.1, absurdity: 0.8 }),
})
const weird = seed({
  name: '纯抽象图', character: '', appearance: '彩色噪点',
  score: JSON.stringify({ valence: 0.0, arousal: 0.4, aggression: 0.0, intimacy: 0.0, absurdity: 1.0 }),
})

test('情绪词识别：长词优先，认不出就老实返回 null', () => {
  assert.equal(searchLib.resolveEmotion('生气').word, '生气')
  assert.equal(searchLib.resolveEmotion('大笑').word, '大笑', '「大笑」不能被「笑」抢走')
  assert.equal(searchLib.resolveEmotion('他有点火大').word, '火大')
  assert.equal(searchLib.resolveEmotion('帮我找张图'), null)
  assert.equal(searchLib.resolveEmotion(''), null)
})

test('情绪距离：越像越小，缺维度不算', () => {
  const d = searchLib.emotionDistance({ aggression: 0.9 }, { aggression: 0.9 })
  assert.equal(d, 0)
  const far = searchLib.emotionDistance({ aggression: 0 }, { aggression: 0.9 })
  assert.ok(far > 0.8 && far <= 1)
  assert.equal(searchLib.emotionDistance(null, { aggression: 1 }), 1, '没有分数当成最不像')
})

test('整句拆解：「生气的大肥鱼」= 角色大肥鱼 + 情绪生气', () => {
  const r = searchLib.search(index, { keyword: '生气的大肥鱼' })
  assert.equal(r.used.character, '大肥鱼')
  assert.equal(r.used.emotion, '生气')
  assert.equal(r.used.keyword, null, '「的」不该剩成一个关键词')
  assert.equal(r.total, 2, '大肥鱼的 2 张全部进入候选（不是只剩下名字里带「大肥鱼」的）')

  assert.equal(r.items[0].md5, angryFish, '生气的应该排在开心前面')
  assert.ok(r.items[0].score.aggression >= r.items[1].score.aggression)
})

test('只给角色也能查：不带关键词时按新到旧', () => {
  const r = searchLib.search(index, { character: '大肥鱼', limit: 5 })
  assert.equal(r.total, 2)
  assert.equal(r.items.length, 2)
})

test('图上文字能搜到', () => {
  const r = searchLib.search(index, { keyword: '无所谓' })
  assert.equal(r.total, 1)
  assert.equal(r.items[0].md5, otherChar)
  assert.ok(r.items[0].fields.includes('text'), '要能说出命中的是图上文字')
})

test('关键词匹配名字时排序更靠前（名字=用途）', () => {
  const r = searchLib.search(index, { keyword: '炫饭' })
  assert.equal(r.items[0].md5, happyFish)
  assert.ok(r.items[0].fields.includes('name'))
})

test('纯情绪也能查：抽象拉满的那张应该第一', () => {
  const r = searchLib.search(index, { emotion: '抽象', limit: 3 })
  assert.equal(r.items[0].md5, weird)
  assert.equal(r.used.emotion, '抽象')
})

test('搜不到就返回空，不凑数', () => {
  const r = searchLib.search(index, { keyword: '根本不存在的词' })
  assert.equal(r.total, 0)
  assert.equal(r.items.length, 0)
  assert.match(formatSearch(r), /没找到/)
})

test('formatSearch 把人话摘要写全（角色/情绪/文字/md5）', () => {
  const r = searchLib.search(index, { keyword: '生气的大肥鱼', limit: 1 })
  const text = formatSearch(r)
  assert.match(text, /角色=大肥鱼/)
  assert.match(text, /情绪=生气/)
  assert.match(text, /共 2 张匹配/)
  assert.match(text, new RegExp(angryFish.slice(0, 8)))
})

test('limit 被限制在合理范围（防止一口气把整库塞给模型）', () => {
  assert.equal(searchLib.search(index, { character: '大肥鱼', limit: 0 }).items.length, 1)
  assert.ok(searchLib.search(index, { limit: 999 }).items.length <= 20)
})
