// 锁定保护：analyze 必须跳过人工锁定的条目。
//
// 用一个假 ctx 代替模型：只要能证明「锁定的没被调用、没被改」，保护就是真的。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-p-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const { runAnalyze } = await import('../../src/lib/analyze.js')

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

/** 造一条记录，并真的写一个文件（analyze 要读图） */
function seed(md5, over = {}) {
  const rel = `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.png`
  const abs = join(store.LIBRARY, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  // 一个 1x1 的 PNG 就够：假模型不看内容
  writeFileSync(abs, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ))
  db.insertItem(index, {
    md5, path: rel, ext: 'png', bytes: 68, width: 1, height: 1, frames: 1, hasAlpha: false,
    dhash: '0'.repeat(16), state: 'stored', createdAt: Date.now(), ...over,
  })
  return db.getItem(index, md5)
}

/** 假 ctx：记录被喂过哪些图 */
function fakeCtx(seen) {
  return {
    attachments: { admitPromptContent: async (parts) => parts },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: {
      stream() {
        return (async function* () {
          // 返回 4 帧都不够，按张数返回「帧: N」
          const count = seen.pending
          for (let i = 1; i <= count; i++) {
            yield { type: 'text-delta', text: `帧: ${i}\n角色: 未知\n角色把握: 低\n文字: 无\n外观: 测试\n情绪: 0.1\n强度: 0.2\n攻击: 0\n亲密: 0\n抽象: 0.5\n指向: 无\n场景: 日常\n名字: 模型给的名字\n一句话: 测试\n` }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    __seen: seen,
  }
}

// 让假模型知道这一批有几张：从 admitted parts 里数 image
function instrument(ctx, seen) {
  const orig = ctx.attachments.admitPromptContent
  ctx.attachments.admitPromptContent = async (parts) => {
    const images = parts.filter((p) => p.type === 'image')
    for (const img of images) seen.push(img.name)
    seen.pending = images.length
    return orig(parts)
  }
  return ctx
}

const LOCKED = 'a'.repeat(32)
const FREE = 'b'.repeat(32)

test('analyze 跳过人工锁定的条目', async () => {
  seed(LOCKED, { name: '人工确认过', character: '大肥鱼', charConf: '人工', pinned: 1 })
  seed(FREE, { name: '没锁的', analyzedAt: null })

  const seen = []
  const ctx = instrument(fakeCtx(seen), seen)

  const r = await runAnalyze(ctx, index, { limit: 10, force: true })
  assert.equal(r.total, 1, '只应该处理未锁的那一张')
  assert.equal(r.ok, 1)
  assert.equal(seen.length, 1, '模型只看到 1 张图')

  const locked = db.getItem(index, LOCKED)
  assert.equal(locked.character, '大肥鱼', '锁定的角色不能被覆盖')
  assert.equal(locked.name, '人工确认过', '锁定的名字不能被覆盖')
  assert.equal(locked.pinned, 1)

  const free = db.getItem(index, FREE)
  assert.ok(free.analyzed_at, '没锁的正常分析')
})

test('--include-pinned 才连锁定的一起重跑', async () => {
  const seen = []
  const ctx = instrument(fakeCtx(seen), seen)

  const r = await runAnalyze(ctx, index, { limit: 10, force: true, includePinned: true })
  assert.equal(r.total, 2, '两张都处理')

  const locked = db.getItem(index, LOCKED)
  assert.notEqual(locked.character, '大肥鱼', '明确要求时才允许覆盖角色')
})

test('点名 --md5 也会尊重锁定，并说明原因（不静默跳过）', async () => {
  db.updateItem(index, LOCKED, { pinned: 1, character: '大肥鱼', char_conf: '人工' })

  const seen = []
  const ctx = instrument(fakeCtx(seen), seen)

  const r = await runAnalyze(ctx, index, { md5: LOCKED.slice(0, 8), force: true })
  assert.equal(r.total, 0, '没有处理任何一张')
  assert.equal(r.skipped.length, 1, '要说清楚为什么没跑')
  assert.match(r.skipped[0].message, /人工锁定/)
  assert.equal(db.getItem(index, LOCKED).character, '大肥鱼')
})
