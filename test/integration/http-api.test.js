// HTTP 层端到端：用假的 req/res 直接打真实路由。
//
// 覆盖的是接线（参数解析 → 业务 → 响应形状），不是网络栈。
// 界面能不能筛选、能不能改角色，最终都落在这几个 op 上。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-h-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const http = await import('../../src/lib/http.js')

store.ensureDirs()
const index = db.openDb(store.INDEX_DB)

after(() => {
  try {
    index.close?.()
  } catch {
    /* 已关闭 */
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

function seed(md5, over = {}) {
  const rel = `${md5.slice(0, 2)}/${md5.slice(2, 4)}/${md5}.png`
  const abs = join(store.LIBRARY, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ))
  db.insertItem(index, {
    md5, path: rel, ext: 'png', bytes: 68, width: 1, height: 1, frames: 1, hasAlpha: false,
    dhash: '0'.repeat(16), state: 'stored', createdAt: Date.now(),
    score: JSON.stringify({ valence: 0.5, arousal: 0.2 }), analyzedAt: Date.now(), model: 'm',
    ...over,
  })
}

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
seed(A, { name: '有名有角色', character: '大肥鱼', charConf: '高', appearance: '蓝发', tags: 'a' })
seed(B, { name: null, character: null, tags: null, analyzed_at: null, analyzedAt: null })

// ---- 假 req/res ----
let handler = null

/** 假模型：永远返回一份合法分析，用来验证「按钮 → 分析 → 落库」这条链 */
function fakeModel() {
  const seen = []
  return {
    seen,
    attachments: {
      admitPromptContent: async (parts) => {
        seen.push(parts.filter((p) => p.type === 'image').length)
        return parts
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'fake-model' }) },
    llm: {
      stream: () => (async function* () {
        yield {
          type: 'text-delta',
          text: '帧: 1\n角色: 未知\n角色把握: 低\n文字: 按钮测试\n外观: 蓝发\n情绪: 0.3\n强度: 0.4\n攻击: 0\n亲密: 0.1\n抽象: 0.2\n指向: 无\n场景: 日常\n名字: 模型起的名\n一句话: 测试\n',
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }
}

const model = fakeModel()

const ctx = {
  effect: (fn) => fn(),
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  },
  ...model,
}
http.registerApi(ctx)

function makeReq(method, url, body) {
  const chunks = []
  if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body), 'utf8'))
  const listeners = {}
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      listeners[event] = fn
      if (event === 'data') chunks.forEach((c) => fn(c))
      if (event === 'end') fn()
      return this
    },
    destroy() {},
  }
}

async function call(method, query, body) {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(payload) {
      if (typeof payload === 'string') this.body += payload
      else if (Buffer.isBuffer(payload)) this.body += payload.toString('binary')
      return this
    },
  }
  await handler(makeReq(method, `/meme-brain/api?${query}`, body), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 二进制 */
  }
  return { status: res.statusCode, json, raw: res.body, headers: res.headers }
}

test('facets：给出筛选条需要的全部数字', async () => {
  const r = await call('GET', 'op=facets')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  const d = r.json.data
  assert.equal(d.total, 2)
  assert.deepEqual(d.characters, [{ name: '大肥鱼', count: 1 }])
  assert.equal(d.unknownCharacter, 1)
  assert.equal(d.todo.unanalyzed, 1)
  assert.equal(d.todo.unnamed, 1)
  assert.equal(d.todo.notags, 1)
  assert.equal(d.todo.nochar, 1)
})

test('list：todo 与 character 两个筛选都生效', async () => {
  const nochar = await call('GET', 'op=list&todo=nochar')
  assert.equal(nochar.json.data.total, 1)
  assert.equal(nochar.json.data.items[0].md5, B)

  const byChar = await call('GET', 'op=list&character=' + encodeURIComponent('大肥鱼'))
  assert.equal(byChar.json.data.total, 1)
  assert.equal(byChar.json.data.items[0].md5, A)

  const unknown = await call('GET', 'op=list&character=__none__')
  assert.equal(unknown.json.data.total, 1)
  assert.equal(unknown.json.data.items[0].md5, B)
})

test('list：乱写 todo 返回 500 且带错误信息（不会静默当成全部）', async () => {
  const r = await call('GET', 'op=list&todo=乱写')
  assert.equal(r.status, 500)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error.message, /未知的 todo/)
})

test('annotate：改角色 → 新建表项 + 上锁，响应带完整详情', async () => {
  const r = await call('POST', 'op=annotate', { md5: B, character: '耄耋' })
  assert.equal(r.status, 200)
  const d = r.json.data
  assert.equal(d.character, '耄耋')
  assert.equal(d.charConf, '人工')
  assert.equal(d.pinned, true)
  assert.equal(d.createdCharacter, true)
  assert.ok(d.score, '响应里应包含评分（详情形状）')
  assert.ok(d.appearance !== undefined)
})

test('annotate：只传名字不会解锁也不会改角色', async () => {
  const before = db.getItem(index, A)
  const r = await call('POST', 'op=annotate', { md5: A, name: '改个名' })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.name, '改个名')

  const after = db.getItem(index, A)
  assert.equal(after.character, before.character)
  assert.equal(after.pinned, before.pinned)
})

test('annotate：pin:false 解锁；空补丁报 400；找不到报 404', async () => {
  const unlock = await call('POST', 'op=annotate', { md5: B, pin: false })
  assert.equal(unlock.json.data.pinned, false)

  const empty = await call('POST', 'op=annotate', { md5: A })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'E_EMPTY_PATCH')

  const missing = await call('POST', 'op=annotate', { md5: 'ffffffff', name: 'x' })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'E_NOT_FOUND')
})

test('非回环地址一律 403', async () => {
  const res = {
    statusCode: 0,
    writeHead(status) { this.statusCode = status; return this },
    end() { return this },
  }
  const req = { ...makeReq('GET', '/meme-brain/api?op=list'), socket: { remoteAddress: '10.0.0.9' } }
  await handler(req, res)
  assert.equal(res.statusCode, 403)
})

test('analyze：单张分析真的跑了模型并落库', async () => {
  const C = 'c'.repeat(32)
  seed(C, { name: '人工名', character: null, tags: null, analyzedAt: null, score: null, appearance: null })

  const r = await call('POST', 'op=analyze', { md5: C })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)

  const { item, result } = r.json.data
  assert.equal(result.ok, 1, '成功分析了 1 张')
  assert.equal(item.analyzed, true)
  assert.equal(item.model, 'fake-model')
  assert.ok(item.score && typeof item.score.valence === 'number', '分数进了库也回了界面')
  assert.equal(item.appearance, '蓝发')
  assert.equal(item.text, '按钮测试')
  assert.equal(item.name, '人工名', '已有名字不动（要改名得显式 --rename）')

  assert.ok(model.seen.length >= 1, '模型确实被调用了')
})

test('analyze：没有名字的图会被模型补一个名字', async () => {
  const E = 'e'.repeat(32)
  seed(E, { name: null, character: null, tags: null, analyzedAt: null })

  const r = await call('POST', 'op=analyze', { md5: E })
  assert.equal(r.json.data.item.name, '模型起的名', '空名字应该被补上')
})

test('analyze：锁定的人工标注不会被这张按钮覆盖', async () => {
  const D = 'd'.repeat(32)
  seed(D, { name: '人工定的', character: '大肥鱼', charConf: '人工', pinned: 1, analyzedAt: Date.now() })

  const r = await call('POST', 'op=analyze', { md5: D })
  assert.equal(r.status, 200)
  const { item, result } = r.json.data
  assert.equal(result.ok, 0, '没有处理')
  assert.equal(result.skipped.length, 1, '要说明为什么没跑')
  assert.match(result.skipped[0].message, /人工锁定/)
  assert.equal(item.character, '大肥鱼', '人工角色原样保留')
  assert.equal(item.pinned, true)
})

test('analyze：找不到的 md5 返回 404；没有 llm 服务返回 409', async () => {
  const missing = await call('POST', 'op=analyze', { md5: 'ffffffff' })
  assert.equal(missing.status, 404)

  // 换一个没有 llm 的 ctx：注册到一个临时 handler 上
  let bare = null
  const ctxNoLlm = { effect: (fn) => fn(), webServer: { register: (route) => { bare = route.handler; return () => {} } } }
  http.registerApi(ctxNoLlm)

  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    end(p) { this.body += p; return this },
  }
  await bare(makeReq('POST', '/meme-brain/api?op=analyze', { md5: 'c'.repeat(32) }), res)
  assert.equal(res.statusCode, 409)
  assert.equal(JSON.parse(res.body).error.code, 'E_NO_LLM')

  // 把主 handler 注册回来，避免影响后续测试
  http.registerApi(ctx)
})
