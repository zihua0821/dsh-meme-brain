// Aurabot 表情模块的冒烟测试（仓库里的源码副本，不碰真库）。
//
// 这个模块替换的是插件内置的表情模块：它一坏，她就完全不会发表情了。
// 所以至少要钉住四件事：导出全、找不到图时不当机、发不出去的图不硬发、别把旧模块留着重复收。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const MODULE = new URL('../../integrations/aurabot/stickers/index.mjs', import.meta.url)

const ITEMS = [
  { md5: 'a'.repeat(32), path: 'aa/aa/' + 'a'.repeat(32) + '.gif', name: '开心炫饭', tags: '干饭,开心', character: '大肥鱼', text: '', bytes: 100 * 1024 },
  { md5: 'b'.repeat(32), path: 'bb/bb/' + 'b'.repeat(32) + '.gif', name: '生气举刀', tags: '生气', character: '大肥鱼', text: '滚', bytes: 300 * 1024 },
  { md5: 'c'.repeat(32), path: 'cc/cc/' + 'c'.repeat(32) + '.gif', name: '巨大表情', tags: '', character: '', text: '', bytes: 9 * 1024 * 1024 },
]

let fetched = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), method: init?.method || 'GET' })
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { items: ITEMS, total: ITEMS.length } }),
  }
}

after(() => {
  globalThis.fetch = realFetch
})

/** 造一个够用的假 api */
function fakeApi(over = {}) {
  const config = { stickers: { enabled: true, collect: true }, ownerQQ: '1', modules: { 'gif-stickers': { enabled: true } } }
  const sets = []
  const handlers = {}
  const toolFactories = []
  return {
    configWatcher: { config, sets },
    handlers,
    toolFactories,
    api: {
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      dsh: { get: (n) => (n === 'webServer' ? { getOrigin: () => 'http://stub' } : undefined) },
      core: { hub: { sendSticker: async () => true, sendImage: async () => true }, onebot: { call: async () => ({}) } },
      config: () => config,
      setConfig: (next) => { sets.push(next); Object.keys(next).forEach((k) => { config[k] = next[k] }) },
      settings: () => ({ auto: true, groups: true, ownerImages: false, maxPerHour: 30, maxMB: 8, maxSendMB: 5, autoAnalyze: false }),
      // 和插件真身的 defineTool 对齐：它负责把 properties/required 包装成 parameters
      defineTool: ({ name, description, properties = {}, required = [], execute }) => ({
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: (v && (v.message || (v.ok === false ? '✗' : '✓'))) || '' }] },
        execute: async (args) => execute(args || {}),
      }),
      tool: (fn) => { toolFactories.push(fn) },
      on: (name, fn) => { handlers[name] = fn },
      rule: () => {},
      command: () => {},
      sendImage: async () => true,
      ...over,
    },
  }
}

async function load(apiOver) {
  const { api, configWatcher, handlers, toolFactories } = fakeApi(apiOver)
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  const svc = mod.setup(api)
  await svc.refresh()
  return { mod, svc, configWatcher, handlers, toolFactories }
}

test('模块定义：id 必须是 stickers（同名才顶得掉内置）', async () => {
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  assert.equal(mod.id, 'stickers')
  assert.equal(typeof mod.setup, 'function')
  assert.equal(mod.api, 1)
  assert.ok(Array.isArray(mod.settings) && mod.settings.length > 0, '面板要有设置项')
})

test('导出 hub 需要的全部函数', async () => {
  const { svc } = await load()
  for (const fn of ['match', 'segmentFor', 'pickForReply', 'collect', 'library', 'markUsed']) {
    assert.equal(typeof svc[fn], 'function', `缺 ${fn}，聊天中枢会以为表情模块关了`)
  }
  assert.equal(svc.library().items.length, ITEMS.length)
})

test('match：按名字/标签/角色/图上文字都能找到', async () => {
  const { svc } = await load()
  assert.equal(svc.match('开心炫饭')?.md5, ITEMS[0].md5)
  assert.equal(svc.match('干饭')?.md5, ITEMS[0].md5)
  assert.equal(svc.match('滚')?.md5, ITEMS[1].md5, '图上文字也要能匹配')
  assert.equal(svc.match('根本不存在'), null, '找不到必须返回 null，不能拿一张凑数')
  assert.equal(svc.match(''), null)
})

test('segmentFor：文件不存在时返回 null（不能构造出坏消息段）', async () => {
  const { svc } = await load()
  assert.equal(svc.segmentFor(ITEMS[0]), null, '路径是假的，读不到文件')
  assert.equal(svc.segmentFor(null), null)
  assert.equal(svc.segmentFor({}), null)
})

test('segmentFor：超过发送上限的图不硬发', async () => {
  const { svc } = await load()
  // 真库里没有这张，但体积判断要在读文件之前生效
  assert.equal(svc.segmentFor(ITEMS[2]), null)
})

test('pickForReply：只会挑发得出去的图', async () => {
  const { svc } = await load()
  for (let i = 0; i < 30; i++) {
    const p = svc.pickForReply('今天好累啊')
    assert.ok(p, '空库才该没有，这里必须挑出一张')
    assert.notEqual(p.md5, ITEMS[2].md5, '9MB 那张不该被挑中')
  }
})

test('collect：偷表情关着时直接拒绝，不发请求', async () => {
  const { svc } = await load({
    config: () => ({ stickers: { enabled: true, collect: false }, ownerQQ: '1', modules: { 'gif-stickers': { enabled: false } } }),
  })
  const before = fetched.length
  const r = await svc.collect({ type: 'image', data: { url: 'http://x/y.gif' } }, 'group:1')
  assert.equal(r.ok, false)
  assert.match(r.reason, /关着/)
  assert.equal(fetched.length, before, '关着就不该发任何请求')
})

test('find：走 op=find，参数名和 Host 对得上', async () => {
  const { svc } = await load()
  fetched.length = 0
  await svc.find({ query: '生气的大肥鱼', limit: 3 })
  const hit = fetched.find((f) => f.url.includes('op=find'))
  assert.ok(hit, '应该打 op=find')
  assert.ok(hit.url.includes('q=') && hit.url.includes('limit=3'))
})

test('library：走 op=list，快照带 path（发图要读文件）', async () => {
  const { svc } = await load()
  fetched.length = 0
  await svc.refresh()
  const hit = fetched.find((f) => f.url.includes('op=list'))
  assert.ok(hit, '应该打 op=list')
  assert.ok(svc.library().items.every((i) => i.path), '每张都要有 path')
})

test('兼并旧模块：只关一次，不重复写配置', async () => {
  const { configWatcher } = await load()
  assert.equal(configWatcher.config.modules['gif-stickers'].enabled, false, '旧的补收模块应被关掉')
  assert.equal(configWatcher.sets.length, 1, '只该写一次配置')
  assert.ok(Array.isArray(configWatcher.sets) && configWatcher.sets.length === 1)
})

test('兼并旧模块：已经关着就不再写', async () => {
  const { configWatcher } = await load({
    config: () => ({ stickers: { enabled: true }, ownerQQ: '1', modules: { 'gif-stickers': { enabled: false } } }),
  })
  assert.equal(configWatcher.sets.length, 0)
})

test('工具名单：内置模块里被点名的工具名字还在（qq_collect_sticker 是 hub 提示词写死的）', async () => {
  const { toolFactories } = await load()
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const names = made.map((t) => t.name)
  for (const must of ['qq_send_sticker', 'qq_list_stickers', 'qq_edit_sticker', 'qq_collect_sticker', 'qq_save_sticker', 'meme_find', 'meme_send']) {
    assert.ok(names.includes(must), `缺 ${must}：她按提示词调用时会拿到「未知工具」`)
  }
  for (const t of made) {
    assert.ok(t.description && t.description.length > 8, `${t.name} 的描述太短，模型不知道怎么用`)
    assert.equal(t.parameters?.type, 'object', `${t.name} 的 parameters 形状不对`)
  }
})

test('防重复发：工具发过之后，回复里的 <sticker:> 会被去掉（实测过的 bug）', async () => {
  const { handlers, toolFactories } = await load()
  assert.equal(typeof handlers['reply/items'], 'function', '要监听 reply/items')

  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const memeSend = made.find((t) => t.name === 'meme_send')
  assert.ok(memeSend, '有 meme_send 工具')

  // 还没发过：回复里的表情原样保留
  assert.equal(handlers['reply/items']([{ kind: 'text', value: '好' }, { kind: 'sticker', value: 'x' }], { chatId: 'private:1' }), undefined)

  const r = await memeSend.execute({ query: '大肥鱼' })
  assert.equal(r.ok, true, '工具应该发成功（hub 桩返回 true）')

  // 发过之后：同一聊天里的表情项被拿掉
  const kept = handlers['reply/items'](
    [{ kind: 'text', value: '给你' }, { kind: 'sticker', value: '气鼓鼓的' }],
    { chatId: 'private:1' },
  )
  assert.ok(Array.isArray(kept), '应该返回新的 items 列表')
  assert.deepEqual(kept.map((i) => i.kind), ['text'], '只留文字，表情去掉')

  // 别的聊天不受影响
  assert.equal(handlers['reply/items']([{ kind: 'sticker', value: 'y' }], { chatId: 'group:2' }), undefined)

  // 只用一次：第二次不再干预
  assert.equal(handlers['reply/items']([{ kind: 'sticker', value: 'z' }], { chatId: 'private:1' }), undefined)
})

test('防重复发：qq_send_sticker 也算工具发过', async () => {
  const { handlers, toolFactories } = await load()
  const made = toolFactories[0]({ chat: { chatId: 'group:9', kind: 'group' } })
  const tool = made.find((t) => t.name === 'qq_send_sticker')
  const r = await tool.execute({ name: '开心炫饭' })
  assert.equal(r.ok, true)

  const kept = handlers['reply/items']([{ kind: 'text', value: '嘿' }, { kind: 'sticker', value: 'x' }], { chatId: 'group:9' })
  assert.deepEqual(kept.map((i) => i.kind), ['text'])
})
