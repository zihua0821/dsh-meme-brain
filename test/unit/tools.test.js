// AI 工具定义测试。
//
// 工具是模型唯一能看见的接口：schema 写错、output 缺失，模型那边会静默调不了，
// 而且不会报错——所以这里逐项验证「能被注册、能被调用、能返回人话」。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-t-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const tools = await import('../../src/lib/tools.js')

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
    dhash: '0'.repeat(16), state: 'stored', analyzedAt: Date.now(), createdAt: Date.now() + n,
    ...over,
  })
  return md5
}

const angry = seed({
  name: '举刀的女仆', character: '大肥鱼',
  score: JSON.stringify({ valence: -0.2, arousal: 0.8, aggression: 0.9, intimacy: 0.3, absurdity: 0.3 }),
})
seed({ name: '开心炫饭', character: '大肥鱼', score: JSON.stringify({ valence: 0.9, arousal: 0.4, aggression: 0, intimacy: 0.6, absurdity: 0.2 }) })

test('meme_find：schema 合规（模型能读懂的形状）', () => {
  const d = tools.FIND_TOOL
  assert.equal(d.name, 'meme_find')
  assert.ok(d.description.length > 40, '描述要够长，模型才知道什么时候用它')
  assert.equal(d.parameters.type, 'object')
  assert.deepEqual(Object.keys(d.parameters.properties).sort(), ['character', 'emotion', 'limit', 'query', 'scene'])
  assert.equal(d.parameters.additionalProperties, false)
  assert.ok(d.output && d.output.schema, '必须给 output.schema')
  assert.equal(typeof d.output.render, 'function')
  assert.equal(typeof d.execute, 'function')
  assert.equal(d.isConcurrencySafe(), true, '只读工具应允许并发')
})

test('meme_find：execute 返回人话 + 结构化结果', async () => {
  const value = await tools.FIND_TOOL.execute({ query: '生气的大肥鱼', limit: 1 })
  assert.equal(value.ok, true)
  assert.equal(value.count, 1)
  assert.equal(value.items[0].md5, angry)
  assert.match(value.text, /角色=大肥鱼/)
  assert.match(value.text, /情绪=生气/)
})

test('meme_find：render 把结果变成文本 content block', async () => {
  const value = await tools.FIND_TOOL.execute({ character: '大肥鱼' })
  const blocks = tools.FIND_TOOL.output.render({ character: '大肥鱼' }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /找到 2 张/)
})

test('meme_find：找不到时说没有，不编', async () => {
  const value = await tools.FIND_TOOL.execute({ query: '不存在的词' })
  assert.equal(value.ok, true)
  assert.equal(value.count, 0)
  assert.match(value.text, /没找到/)
})

test('meme_status：给出总量、角色、待办', async () => {
  const value = await tools.STATUS_TOOL.execute({})
  assert.equal(value.ok, true)
  assert.match(value.text, /共 2 张/)
  assert.match(value.text, /大肥鱼 2/)
})

test('registerTools：能注册进 tools 服务，并能撤掉', () => {
  const registered = []
  const removed = []
  const fakeCtx = {
    get: (name) => (name === 'tools'
      ? { register: (def) => { registered.push(def.name); return () => removed.push(def.name) } }
      : undefined),
  }

  const dispose = tools.registerTools(fakeCtx)
  assert.deepEqual(registered.sort(), ['meme_find', 'meme_status'])

  dispose()
  assert.deepEqual(removed.sort(), ['meme_find', 'meme_status'], '停用插件时必须把工具撤干净')
})

test('registerTools：没有 tools 服务时不炸（插件其余部分照常）', () => {
  const dispose = tools.registerTools({ get: () => undefined })
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('registerTools：单个工具注册失败不影响另一个', () => {
  const registered = []
  const fakeCtx = {
    get: () => ({
      register: (def) => {
        if (def.name === 'meme_find') throw new Error('名字被占了')
        registered.push(def.name)
        return () => {}
      },
    }),
    logger: () => ({ warn: () => {} }),
  }
  tools.registerTools(fakeCtx)
  assert.deepEqual(registered, ['meme_status'])
})
