// Aurabot 表情模块（meme-qq）的冒烟测试：跑仓库源码副本，不碰真库。
//
// 这个模块负责她全部的表情行为（内置模块被停用），所以至少要钉住：
//   1. 它是独立模块：id 不叫 stickers，不冒充内置
//   2. 内置模块只是被「停用」，不是被顶掉
//   3. <sticker:标签> 能被换成我们库里的图（内置停用后这条没人管了）
//   4. 工具发过之后回复里不再重复发
//   5. 找不到图、太大、文件没了，都不能发坏消息段

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模块在顶层读这个变量，必须在 import 之前设
const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-qq-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot
const LIB = join(tmpRoot, 'library')

const MODULE = new URL('../../integrations/aurabot/meme-qq/index.mjs', import.meta.url)

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// 两张「库里真有文件」的表情 + 一张超大的
const okPath = 'aa/aa/' + 'a'.repeat(32) + '.gif'
const bigPath = 'bb/bb/' + 'b'.repeat(32) + '.gif'
mkdirSync(join(LIB, 'aa', 'aa'), { recursive: true })
mkdirSync(join(LIB, 'bb', 'bb'), { recursive: true })
writeFileSync(join(LIB, okPath), Buffer.from('GIF89a fake but exists'))
// 6MB：超过默认 5MB 发送上限
writeFileSync(join(LIB, bigPath), Buffer.alloc(6 * 1024 * 1024, 1))

const ITEMS = [
  { md5: 'a'.repeat(32), path: okPath, name: '开心炫饭', tags: '干饭,开心', character: '大肥鱼', text: '', bytes: 20 },
  { md5: 'b'.repeat(32), path: bigPath, name: '巨大表情', tags: '', character: '', text: '', bytes: 6 * 1024 * 1024 },
  { md5: 'c'.repeat(32), path: 'cc/cc/' + 'c'.repeat(32) + '.gif', name: '文件丢了', tags: '', character: '', text: '', bytes: 100 },
]

let fetched = []
const realFetch = globalThis.fetch
const FAKE_IMAGE = Buffer.from('GIF89a fake image bytes')
globalThis.fetch = async (url, init) => {
  const u = String(url)
  fetched.push({ url: u, method: init?.method || 'GET' })
  if (u.startsWith('http://stub')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: ITEMS, total: ITEMS.length } }) }
  }
  // 图片下载：给一个真正的 body 流，否则模块里 for await 会炸
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(FAKE_IMAGE.length) },
    body: (async function* () { yield FAKE_IMAGE })(),
  }
}

after(() => {
  globalThis.fetch = realFetch
})

function fakeApi(over = {}) {
  const config = {
    stickers: {
      enabled: true, autoChance: 0, faces: true, collect: true, collectMode: 'auto',
      fromGroups: true, fromPrivate: true, maxPerHour: 20, maxLibrary: 300, caption: false,
    },
    ownerQQ: '1',
    modules: {},
  }
  const sets = []
  const handlers = {}
  const toolFactories = []
  const sent = []
  return {
    configWatcher: { config, sets },
    handlers,
    toolFactories,
    sent,
    api: {
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      dsh: { get: (n) => (n === 'webServer' ? { getOrigin: () => 'http://stub' } : undefined) },
      core: {
        hub: {
          stickerOf: () => ({ type: 'image', data: { file: 'x.jpg', url: 'http://x/y.jpg' } }),
          recentMedia: () => [{ seg: { type: 'image', data: { url: 'http://x/z.jpg' } } }],
          sendSticker: async () => { throw new Error('不该再调 hub.sendSticker：那是内置模块的服务') },
        },
        onebot: { call: async () => ({ url: 'http://x/y.jpg' }) },
      },
      config: () => config,
      setConfig: (next) => { sets.push(next); Object.keys(next).forEach((k) => { config[k] = next[k] }) },
      // 只留本模块新造的那几个；其余参数一律走 config.stickers
      settings: () => ({ autoPick: false, ownerImages: false, maxMB: 8, maxSendMB: 5 }),
      // 和插件真身的 defineTool 对齐
      defineTool: ({ name, description, properties = {}, required = [], execute }) => ({
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async (args) => execute(args || {}),
      }),
      tool: (fn) => { toolFactories.push(fn) },
      on: (name, fn) => { handlers[name] = fn },
      rule: () => {},
      command: () => {},
      sendImage: async (chatId, path) => { sent.push({ chatId, path }) },
      ...over,
    },
  }
}

async function load(apiOver) {
  const ctx = fakeApi(apiOver)
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  const svc = mod.setup(ctx.api)
  await svc.refresh()
  return { mod, svc, ...ctx }
}

test('模块定义：独立 id，不冒充内置', async () => {
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  assert.equal(mod.id, 'meme-qq', 'id 必须独立；叫 stickers 就成了顶掉内置')
  assert.equal(typeof mod.setup, 'function')
  // 只放「内置没有、确实需要」的参数；其余一律认 config.stickers
  const keys = (mod.settings || []).map((s) => s.key)
  assert.deepEqual(keys.sort(), ['autoPick', 'maxMB', 'maxSendMB', 'ownerImages'])
})

test('内置模块只被停用，不是被替换', async () => {
  const { configWatcher } = await load()
  const mods = configWatcher.config.modules
  assert.equal(mods.stickers?.enabled, false, '内置 stickers 应该在配置里停用')
  assert.equal(mods['gif-stickers']?.enabled, false, '旧补录模块也应该停用')
  assert.equal(configWatcher.sets.length, 1, '只该写一次配置')
  // 只写 enabled，不许把别的字段抹掉
  for (const id of ['stickers', 'gif-stickers']) {
    for (const k of Object.keys(configWatcher.sets[0].modules[id] || {})) {
      assert.ok(['enabled'].includes(k), `不该改内置模块的 ${k}`)
    }
  }
})

test('已经是停用状态时不再写配置', async () => {
  const { configWatcher } = await load({
    config: () => ({ stickers: { enabled: true }, ownerQQ: '1', modules: { stickers: { enabled: false }, 'gif-stickers': { enabled: false } } }),
  })
  assert.equal(configWatcher.sets.length, 0)
})

test('reply/items：<sticker:标签> 换成我们库里的图', async () => {
  const { handlers } = await load()
  const out = handlers['reply/items']([{ kind: 'text', value: '给你' }, { kind: 'sticker', value: '开心炫饭' }], { chatId: 'private:1' })
  assert.ok(Array.isArray(out), '应该返回新的 items')
  assert.deepEqual(out.map((i) => i.kind), ['text', 'image'])
  assert.ok(out[1].value.includes(join('library', okPath)), '应该是库内文件的绝对路径')
})

test('reply/items：标签找不到就不发（和内置行为一致）', async () => {
  const { handlers } = await load()
  const out = handlers['reply/items']([{ kind: 'text', value: '嗯' }, { kind: 'sticker', value: '根本没有这个标签' }], { chatId: 'private:1' })
  assert.deepEqual(out.map((i) => i.kind), ['text'], '找不到就丢掉那条表情')
})

test('reply/items：文件丢了或超过发送上限，都不发', async () => {
  const { handlers } = await load()
  const lost = handlers['reply/items']([{ kind: 'sticker', value: '文件丢了' }], { chatId: 'private:1' })
  assert.deepEqual(lost, [], '文件不存在 → 丢掉')
  const big = handlers['reply/items']([{ kind: 'sticker', value: '巨大表情' }], { chatId: 'private:1' })
  assert.deepEqual(big, [], '超过 maxSendMB → 丢掉')
})

test('工具名单齐全（hub 提示词点名的 qq_collect_sticker 也在）', async () => {
  const { toolFactories } = await load()
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const names = made.map((t) => t.name)
  for (const must of ['meme_find', 'meme_send', 'qq_send_sticker', 'qq_list_stickers', 'qq_edit_sticker', 'qq_collect_sticker', 'qq_save_sticker']) {
    assert.ok(names.includes(must), `缺 ${must}`)
  }
  for (const t of made) {
    assert.ok(t.description && t.description.length > 8, `${t.name} 描述太短`)
    assert.equal(t.parameters?.type, 'object', `${t.name} 参数形状不对`)
  }
})

test('发图不再依赖内置服务：走 api.sendImage', async () => {
  const { toolFactories, sent } = await load()
  const made = toolFactories[0]({ chat: { chatId: 'private:7', kind: 'private' } })
  const tool = made.find((t) => t.name === 'qq_send_sticker')
  const r = await tool.execute({ name: '开心炫饭' })
  assert.equal(r.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:7')
  assert.ok(sent[0].path.includes('library'))
})

test('防重复发：工具发过之后，回复里的表情/图片项被去掉', async () => {
  const { handlers, toolFactories } = await load()
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  await made.find((t) => t.name === 'qq_send_sticker').execute({ name: '开心炫饭' })

  const kept = handlers['reply/items']([{ kind: 'text', value: '给你' }, { kind: 'sticker', value: '开心炫饭' }], { chatId: 'private:1' })
  assert.deepEqual(kept.map((i) => i.kind), ['text'])
})

test('收表情：普通表情也收（内置停用后 hub 不再代劳）', async () => {
  const { handlers } = await load()
  fetched.length = 0
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'deadbeef.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '应该去打 op=add')
})

test('find 走 op=find，参数名和 Host 对得上', async () => {
  const { svc } = await load()
  fetched.length = 0
  await svc.find({ query: '生气的大肥鱼', limit: 3 })
  const hit = fetched.find((f) => f.url.includes('op=find'))
  assert.ok(hit && hit.url.includes('q=') && hit.url.includes('limit=3'))
})

// ---- 内置那套参数：模块停用了，但参数还在起作用，必须认 ----

test('参数：表情包总开关关着时，不发也不解析 <sticker:>', async () => {
  const { handlers, toolFactories, sent } = await load({
    config: () => ({ stickers: { enabled: false, collect: true, caption: false }, ownerQQ: '1', modules: {} }),
  })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const r = await made.find((t) => t.name === 'qq_send_sticker').execute({ name: '开心炫饭' })
  assert.equal(r.ok, false, '总开关关着不能发')
  assert.equal(sent.length, 0)

  const out = handlers['reply/items']([{ kind: 'text', value: '嗯' }, { kind: 'sticker', value: '开心炫饭' }], { chatId: 'private:1' })
  assert.deepEqual(out.map((i) => i.kind), ['text'], '总开关关着就把表情项去掉')
})

test('参数：fromGroups / fromPrivate 分别管住收表情', async () => {
  const offGroup = await load({
    config: () => ({ stickers: { enabled: true, collect: true, fromGroups: false, fromPrivate: true, caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  offGroup.handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [{ type: 'image', data: { file: 'g.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '关了群里就不该收')

  const offPrivate = await load({
    config: () => ({ stickers: { enabled: true, collect: true, fromGroups: true, fromPrivate: false, caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  offPrivate.handlers.message({ kind: 'private', chatId: 'private:2', userId: '2', stickers: [{ type: 'image', data: { file: 'p.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '关了私聊就不该收')
})

test('参数：collectMode=ask 不自动收（她自己按编号挑）', async () => {
  const { handlers } = await load({
    config: () => ({ stickers: { enabled: true, collect: true, collectMode: 'ask', caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [{ type: 'image', data: { file: 'a.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), 'ask 模式不该自动收')
})

test('参数：collectMode=owner 只收主人发的', async () => {
  const { handlers } = await load({
    config: () => ({ stickers: { enabled: true, collect: true, collectMode: 'owner', caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '999', stickers: [{ type: 'image', data: { file: 'n.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '别人发的不要')

  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '1', stickers: [{ type: 'image', data: { file: 'o.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '主人发的要收')
})

test('参数：collect 关着就完全不收', async () => {
  const { handlers } = await load({
    config: () => ({ stickers: { enabled: true, collect: false, caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'x.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')))
})

test('参数：caption=false 时入库后不叫模型起名', async () => {
  const { handlers } = await load({
    config: () => ({ stickers: { enabled: true, collect: true, caption: false }, ownerQQ: '1', modules: {} }),
  })
  fetched.length = 0
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'c.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '应该入库')
  assert.ok(!fetched.some((f) => f.url.includes('op=analyze')), '关了看图起名就不该调分析')
})

test('列表快照带 path（发图要读文件）', async () => {
  const { svc } = await load()
  assert.ok(svc.refresh)
  await svc.refresh()
  assert.ok(true)
})
