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
// 模块日志（断言用）：load() 会清空
let logLines = []
const realFetch = globalThis.fetch
const FAKE_IMAGE = Buffer.from('GIF89a fake image bytes')
// 真动图：GIF 头 + 两个图形控制扩展（animatedKind 就靠这个判多帧）
const ANIMATED_IMAGE = Buffer.concat([
  Buffer.from('GIF89a'),
  Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from('frame1'),
  Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from('frame2'),
])
let imageBytes = FAKE_IMAGE
let addSeq = 0
// 模型判定的返回值，测试里按场景改
let judgeVerdict = { sticker: false, why: '截图' }
// op=add 的返回值（默认成功；判重测试用它模拟「库里已有」）
let addVerdict = null
globalThis.fetch = async (url, init) => {
  const u = String(url)
  let body
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  fetched.push({ url: u, method: init?.method || 'GET', body })
  if (u.startsWith('http://stub')) {
    // 不同 op 回不同形状，否则入库/起名这条链根本走不到
    let data
    if (u.includes('op=add')) {
      addSeq += 1
      data = addVerdict || { added: true, md5: String(addSeq).padStart(32, '0'), near: null, item: { name: '' } }
    } else if (u.includes('op=judge')) {
      data = { sticker: judgeVerdict.sticker, why: judgeVerdict.why, md5: 'judged', cached: Boolean(judgeVerdict.cached) }
    } else if (u.includes('op=analyze')) {
      data = { item: { name: '起的名' }, result: { ok: 1, failed: [], skipped: [] } }
    } else {
      data = { items: ITEMS, total: ITEMS.length }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) }
  }
  // 图片下载：给一个真正的 body 流，否则模块里 for await 会炸
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(imageBytes.length) },
    body: (async function* () { yield imageBytes })(),
  }
}

after(() => {
  globalThis.fetch = realFetch
})

function fakeApi(over = {}, settingOver = {}) {
  // config.stickers 现在只是「被镜像」的对象；真正的参数在 settings 里
  const config = {
    stickers: { enabled: false, autoChance: 0, faces: true, collect: true, collectMode: 'auto', fromGroups: true, fromPrivate: true, maxPerHour: 20, caption: false },
    ownerQQ: '1',
    modules: {},
  }
  const settings = {
    enabled: true, autoChance: 0, collect: true, fromGroups: true, fromPrivate: true,
    collectMode: 'auto', maxPerHour: 20, caption: false, maxMB: 8, maxSendMB: 5, faces: true,
    ...settingOver,
  }
  const sets = []
  const handlers = {}
  const toolFactories = []
  const sent = []
  return {
    configWatcher: { config, sets },
    settings,
    handlers,
    toolFactories,
    sent,
    api: {
      log: {
        info: (m, ...rest) => logLines.push({ level: 'info', text: [m, ...rest].join(' ') }),
        warn: (m, ...rest) => logLines.push({ level: 'warn', text: [m, ...rest].join(' ') }),
        debug: (m, ...rest) => logLines.push({ level: 'debug', text: [m, ...rest].join(' ') }),
        error: (m, ...rest) => logLines.push({ level: 'error', text: [m, ...rest].join(' ') }),
      },
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
      // 和插件真身对齐：对象 = 深合并，函数 = 整份替换
      setConfig: (next) => {
        const value = typeof next === 'function' ? next(JSON.parse(JSON.stringify(config))) : next
        sets.push(value)
        Object.keys(value).forEach((k) => { config[k] = value[k] })
      },
      settings: () => settings,
      // 和插件真身的 defineTool 对齐
      defineTool: ({ name, description, properties = {}, required = [], execute }) => ({
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
        output: { schema: { type: 'object' }, render: () => [] },
        execute: async (args) => execute(args || {}),
      }),
      tool: (fn) => { toolFactories.push(fn) },
      // 插件内部源码：模块用 api.lib('chat/inbound.js').imageSize 读尺寸
      lib: (key) => (key === 'chat/inbound.js'
        ? {
          imageSize: (buf) => {
            if (String(buf.subarray(0, 3)) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
            return { width: 0, height: 0 }
          },
        }
        : {}),
      on: (name, fn) => { handlers[name] = fn },
      rule: () => {},
      command: () => {},
      sendImage: async (chatId, path) => { sent.push({ chatId, path }) },
      ...over,
    },
  }
}

async function load(apiOver, settingOver) {
  logLines = []
  addVerdict = null
  const ctx = fakeApi(apiOver, settingOver)
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  const svc = mod.setup(ctx.api)
  await svc.refresh()
  return { mod, svc, ...ctx }
}

/** 模拟主人在这个聊天里说了句话（权限校验看的是最近发言人） */
function ownerSpeaks(handlers, chatId = 'private:1', kind = 'private', userId = '1') {
  handlers.message({ kind, chatId, userId, text: '这张是 doro', stickers: [], images: [] })
}

test('对话改库：主人说「这张是 doro」→ 用刚发的那张，改角色', async () => {
  const { handlers, toolFactories } = await load({}, { caption: false })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })

  // 主人先发一张图（会被收进来，noteImage 记下 md5）
  imageBytes = ANIMATED_IMAGE
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [], images: [{ type: 'image', data: { file: 'i'.repeat(32) + '.gif', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 200))
  imageBytes = FAKE_IMAGE

  fetched.length = 0
  const tool = made.find((t) => t.name === 'qq_set_character')
  assert.ok(tool, '要有 qq_set_character 工具')
  const r = await tool.execute({ character: 'doro' })

  assert.equal(r.ok, true, r.message)
  const ann = fetched.find((f) => f.url.includes('op=annotate'))
  assert.ok(ann, '要调 annotate')
  assert.equal(ann.body.character, 'doro')
  assert.match(r.message, /doro/, '要告诉主人改成了什么')
})

test('对话改库：群里别人说同样的话 → 拒绝（权限硬闸，不靠模型自觉）', async () => {
  const { handlers, toolFactories } = await load({}, { caption: false })
  const made = toolFactories[0]({ chat: { chatId: 'group:1', kind: 'group' } })

  handlers.message({ kind: 'group', chatId: 'group:1', userId: '999', stickers: [], images: [{ type: 'image', data: { file: 'j'.repeat(32) + '.gif', sub_type: 99 } }] })
  await new Promise((r) => setTimeout(r, 150))

  fetched.length = 0
  const r = await made.find((t) => t.name === 'qq_set_character').execute({ character: '蘑菇头' })
  assert.equal(r.ok, false)
  assert.match(r.message, /只有主人/)
  assert.ok(!fetched.some((f) => f.url.includes('op=annotate')), '不能真的写库')
})

test('对话改库：charEditMode=off 时不让她改', async () => {
  const { toolFactories } = await load({}, { caption: false, charEditMode: 'off' })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const r = await made.find((t) => t.name === 'qq_set_character').execute({ character: 'doro', md5: 'a'.repeat(8) })
  assert.equal(r.ok, false)
  assert.match(r.message, /关着/)
})

test('对话改库：能按名字定位，也能按 md5 前缀定位', async () => {
  const { handlers, toolFactories } = await load({}, { caption: false })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const tool = made.find((t) => t.name === 'qq_set_character')
  ownerSpeaks(handlers) // 权限：确认是主人在说

  fetched.length = 0
  const byName = await tool.execute({ character: '大肥鱼', sticker: '开心炫饭' })
  assert.equal(byName.ok, true, byName.message)
  assert.equal(fetched.find((f) => f.url.includes('op=annotate')).body.md5, ITEMS[0].md5)

  fetched.length = 0
  const byMd5 = await tool.execute({ character: '龙图', md5: ITEMS[1].md5.slice(0, 8) })
  assert.equal(byMd5.ok, true, byMd5.message)
  assert.equal(fetched.find((f) => f.url.includes('op=annotate')).body.md5, ITEMS[1].md5)
})

test('对话改库：没图也没名字 → 让她问清楚，而不是乱改', async () => {
  const { handlers, toolFactories } = await load({}, { caption: false })
  const made = toolFactories[0]({ chat: { chatId: 'private:9', kind: 'private' } })
  ownerSpeaks(handlers, 'private:9')
  fetched.length = 0
  const r = await made.find((t) => t.name === 'qq_set_character').execute({ character: 'doro' })
  assert.equal(r.ok, false)
  assert.match(r.message, /哪一张/)
  assert.ok(!fetched.some((f) => f.url.includes('op=annotate')))
})

test('自动配图：回复里点名角色时，必须配那个角色的图（不能随机）', async () => {
  const { handlers } = await load({}, { caption: false, autoChance: 1 })
  // 假库里有「大肥鱼」那张（其它两张：一张太大发不出、一张文件丢了）
  const out = handlers['reply/items']([{ kind: 'text', value: '来张大肥鱼' }], { chatId: 'group:1' })
  assert.ok(Array.isArray(out), '应该配了一张')
  const img = out.find((i) => i.kind === 'image')
  assert.ok(img, '有图')
  assert.ok(img.value.includes('a'.repeat(32)), `应该发大肥鱼那张，实际发了 ${img.value}`)
  const line = logLines.find((l) => l.text.startsWith('自动配了一张'))
  assert.ok(line, '要记下为什么是这张')
  assert.match(line.text, /角色=大肥鱼/, '依据应写角色')
})

test('自动配图：没点名时兜底随机，并标明「依据：随机」', async () => {
  const { handlers } = await load({}, { caption: false, autoChance: 1 })
  const out = handlers['reply/items']([{ kind: 'text', value: '嗯嗯' }], { chatId: 'group:1' })
  assert.ok(Array.isArray(out))
  const line = logLines.find((l) => l.text.startsWith('自动配了一张'))
  assert.ok(line, '记下依据')
  assert.match(line.text, /依据：随机/)
})

test('判重命中：日志里要写清撞上的是哪一张（不能只说「重复」）', async () => {
  const { handlers } = await load({}, { caption: false })
  const existing = ITEMS[0] // 开心炫饭
  addVerdict = { added: false, md5: 'f'.repeat(32), near: { md5: existing.md5, reason: 'near', max: 3 } }
  imageBytes = ANIMATED_IMAGE
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'h'.repeat(32) + '.gif', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 200))
  imageBytes = FAKE_IMAGE

  const dup = logLines.find((l) => l.text.startsWith('没入库：'))
  assert.ok(dup, '应该有「没入库」日志')
  assert.match(dup.text, /开心炫饭/, '要说清撞上哪张')
  assert.match(dup.text, /距离 3/, '带上距离')
})

test('模块定义：名字和插件绑定 + 独立页（不挂内置页签）', async () => {
  const mod = (await import(MODULE.href + '?t=' + Math.random())).default
  assert.equal(mod.id, 'meme-qq', 'id 必须独立；叫 stickers 就成了顶掉内置')
  assert.equal(mod.name, '表情脑', '名字要和 dsh-meme-brain 插件相关')
  assert.equal(typeof mod.setup, 'function')
  // 不能写 tab:'stickers'：那个页签只在内置模块运行时才存在（TAB_MODS 写死），
  // 内置关着时挂上去 = 设置彻底看不见
  assert.equal(mod.tab, undefined, '不挂内置页签，用独立页')
  const keys = (mod.settings || []).map((s) => s.key).sort()
  assert.deepEqual(keys, [
    'autoChance', 'caption', 'charEditMode', 'collect', 'collectMode', 'collectPlain', 'enabled',
    'faces', 'fromGroups', 'fromPrivate', 'judgeMode', 'maxMB', 'maxPerHour', 'maxSendMB',
  ], '14 个参数：8 个必要 + 2 个上限 + judgeMode + charEditMode + collectPlain（旧口径）+ faces')
  // maxLibrary 已决定不做（自动删图 = 数据损失）
  assert.ok(!keys.includes('maxLibrary'))
})

test('内置模块只被停用，不是被替换', async () => {
  const { configWatcher } = await load()
  const mods = configWatcher.config.modules
  assert.equal(mods.stickers?.enabled, false, '内置 stickers 应该在配置里停用')
  assert.equal(mods['gif-stickers']?.enabled, false, '旧补录模块也应该停用')
  const retire = configWatcher.sets.find((s) => s.modules)
  assert.ok(retire, '应该有一次停用写入')
  // 只写 enabled，不许把别的字段抹掉
  for (const id of ['stickers', 'gif-stickers']) {
    for (const k of Object.keys(retire.modules[id] || {})) {
      assert.ok(['enabled'].includes(k), `不该改内置模块的 ${k}`)
    }
  }
})

test('设置镜像到 config.stickers：hub 那边只认 config', async () => {
  const { configWatcher } = await load({}, { faces: false, collect: false, collectMode: 'owner', fromGroups: false, fromPrivate: true })
  const mirrored = configWatcher.config.stickers
  assert.equal(mirrored.enabled, false, '内置模块没跑，hub 的旧库发表情路径必须保持关着')
  assert.equal(mirrored.faces, false, 'faces 要镜像，hub 直接读它')
  assert.equal(mirrored.collect, false)
  assert.equal(mirrored.collectMode, 'owner')
  assert.equal(mirrored.fromGroups, false)
  assert.equal(mirrored.fromPrivate, true)
})

test('已经是停用状态时不再写 modules，但镜像照写', async () => {
  const { configWatcher } = await load({
    config: () => ({ stickers: {}, ownerQQ: '1', modules: { stickers: { enabled: false }, 'gif-stickers': { enabled: false } } }),
  })
  // setConfig 传的是整份配置，所以只看「写了几次 + 这次写动的是 stickers」
  assert.equal(configWatcher.sets.length, 1, '停用早已完成，只该剩镜像那一次写入')
  assert.ok('stickers' in configWatcher.sets[0], '镜像写的是 stickers')
  assert.equal(configWatcher.sets[0].stickers.enabled, false)
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

test('存表情：库里已有这张时，给了名字就应用到已有那张（不是白说一句）', async () => {
  const { toolFactories } = await load({}, { caption: false })
  const dupMd5 = ITEMS[0].md5
  const fetchReal = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('op=add')) {
      fetched.push({ url: u })
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { added: false, md5: dupMd5, near: { reason: 'byte-identical' } } }) }
    }
    if (u.includes('op=annotate')) {
      fetched.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { md5: dupMd5, name: '猫猫捂嘴' } }) }
    }
    return fetchReal(url, init)
  }

  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const tool = made.find((t) => t.name === 'qq_save_sticker')
  const r = await tool.execute({ name: '猫猫捂嘴' })
  globalThis.fetch = fetchReal

  assert.equal(r.ok, true, '给了名字就该当成成功（名字应用上去了）')
  const ann = fetched.find((f) => f.url.includes('op=annotate'))
  assert.ok(ann, '应该调用改名接口')
  assert.equal(ann.body.name, '猫猫捂嘴')
})

test('存图的动作很淡：工具结果里不出现「存 / 库 / 收进」这些词', async () => {
  const { toolFactories } = await load({}, { caption: false })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const r = await made.find((t) => t.name === 'qq_save_sticker').execute({ name: '猫猫捂嘴' })
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.message, /存|库|收进|已收好/, '工具结果越淡越好，别给她「可以汇报」的材料')
})

test('存图和回应是两条独立的路：存完之后她的回复不被改写', async () => {
  const { toolFactories, handlers } = await load({}, { caption: true })
  const made = toolFactories[0]({ chat: { chatId: 'private:9', kind: 'private' } })
  const save = await made.find((t) => t.name === 'qq_save_sticker').execute({ name: '猫猫捂嘴' })
  assert.equal(save.ok, true)

  // 她这一轮想说话 —— 那就说话，不该被塞成表情
  const out = handlers['reply/items']([{ kind: 'text', value: '这猫伸手够东西的样子 好像我够白饭' }], { chatId: 'private:9', userText: '存一下' })
  assert.equal(out, undefined, '存图不该改写她的回复')

  // 她这一轮想甩个表情 —— 也照常
  const withSticker = handlers['reply/items']([{ kind: 'sticker', value: '开心炫饭' }], { chatId: 'private:9' })
  assert.deepEqual(withSticker.map((i) => i.kind), ['image'], '她写的表情照常被换成本库的图')
})

test('主人发图被自动收集：同样不影响她怎么回', async () => {
  const { handlers } = await load({}, { caption: false })
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'own.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 120))

  const out = handlers['reply/items']([{ kind: 'text', value: '这猫伸手够东西的样子 好像我够白饭' }], { chatId: 'private:1', userText: '存一下' })
  assert.equal(out, undefined, '自动收集也不该干扰她的回复')
})

test('普通图：模型判定是表情包 → 收（哪怕形状不标准）', async () => {
  const { handlers } = await load({}, { caption: false, judgeMode: 'model' })
  imageBytes = Buffer.from('GIF89a\x84\x03\xbc\x02', 'binary') // 900x700，按尺寸会被挡
  judgeVerdict = { sticker: true, why: '梗图' }
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'd'.repeat(32) + '.png', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(fetched.some((f) => f.url.includes('op=judge')), '问过模型')
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '模型说是，就该收')
  imageBytes = FAKE_IMAGE
})

test('普通图：模型判定不是表情包 → 不收，而且不去猜尺寸', async () => {
  const { handlers } = await load({}, { caption: false, judgeMode: 'model' })
  imageBytes = Buffer.from('GIF89a\xc8\x00\xc8\x00', 'binary') // 200x200，按尺寸会收
  judgeVerdict = { sticker: false, why: '游戏截图' }
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'e'.repeat(32) + '.png', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(fetched.some((f) => f.url.includes('op=judge')), '问过模型')
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '模型说不是，就不收')
  imageBytes = FAKE_IMAGE
})

test('普通图：模型挂了 → 退回按尺寸猜（不因为判定失败就不收）', async () => {
  const { handlers } = await load({}, { caption: false, judgeMode: 'model' })
  imageBytes = Buffer.from('GIF89a\xc8\x00\xc8\x00', 'binary') // 200x200 近方形
  judgeVerdict = { sticker: false, why: '' }
  const before = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('op=judge')) throw new Error('模型超时')
    return before(url, init)
  }
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'f'.repeat(32) + '.png', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 200))
  globalThis.fetch = before
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '判定失败时退回尺寸判断，小方图照收')
  imageBytes = FAKE_IMAGE
})

test('普通图：judgeMode=off 时不问模型也不收', async () => {
  const { handlers } = await load({}, { caption: false, judgeMode: 'off' })
  imageBytes = Buffer.from('GIF89a\xc8\x00\xc8\x00', 'binary')
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'g'.repeat(32) + '.png', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(!fetched.some((f) => f.url.includes('op=judge')), 'off 就不该花模型的钱')
  assert.ok(!fetched.some((f) => f.url.includes('op=add')))
  imageBytes = FAKE_IMAGE
})

test('收表情：QQ 标成表情段（sub_type=1）的静态图照收', async () => {
  const { handlers } = await load({}, { caption: false })
  imageBytes = FAKE_IMAGE
  fetched.length = 0
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'b'.repeat(32) + '.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '标记为表情的应该收')
})

test('收表情：真动图即使 QQ 没标记也收（这正是内置漏掉的那类）', async () => {
  const { handlers } = await load({}, { caption: false })
  imageBytes = ANIMATED_IMAGE
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [], images: [{ type: 'image', data: { file: 'c'.repeat(32) + '.gif', sub_type: 0 } }] })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '多帧动图应该收')
  imageBytes = FAKE_IMAGE
})

test('find 走 op=find，参数名和 Host 对得上', async () => {
  const { svc } = await load()
  fetched.length = 0
  await svc.find({ query: '生气的大肥鱼', limit: 3 })
  const hit = fetched.find((f) => f.url.includes('op=find'))
  assert.ok(hit && hit.url.includes('q=') && hit.url.includes('limit=3'))
})

// ---- 参数全在本模块设置里（config.stickers 只是被镜像） ----

test('参数：发表情总开关关着时，不发也不解析 <sticker:>', async () => {
  const { handlers, toolFactories, sent } = await load({}, { enabled: false })
  const made = toolFactories[0]({ chat: { chatId: 'private:1', kind: 'private' } })
  const r = await made.find((t) => t.name === 'qq_send_sticker').execute({ name: '开心炫饭' })
  assert.equal(r.ok, false, '总开关关着不能发')
  assert.equal(sent.length, 0)

  const out = handlers['reply/items']([{ kind: 'text', value: '嗯' }, { kind: 'sticker', value: '开心炫饭' }], { chatId: 'private:1' })
  assert.deepEqual(out.map((i) => i.kind), ['text'], '总开关关着就把表情项去掉')
})

test('参数：autoChance=0 时不自动配表情，>0 时会补一张', async () => {
  const zero = await load({}, { autoChance: 0 })
  assert.equal(zero.handlers['reply/items']([{ kind: 'text', value: '嗯' }], { chatId: 'private:1' }), undefined, '概率 0 不动')

  const one = await load({}, { autoChance: 1 })
  const out = one.handlers['reply/items']([{ kind: 'text', value: '嗯' }], { chatId: 'private:1' })
  assert.ok(Array.isArray(out), '概率 1 应该补一张')
  assert.deepEqual(out.map((i) => i.kind), ['text', 'image'])
})

test('参数：fromGroups / fromPrivate 分别管住收表情', async () => {
  const offGroup = await load({}, { fromGroups: false, fromPrivate: true })
  fetched.length = 0
  offGroup.handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [{ type: 'image', data: { file: 'g.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '关了群里就不该收')

  const offPrivate = await load({}, { fromGroups: true, fromPrivate: false })
  fetched.length = 0
  offPrivate.handlers.message({ kind: 'private', chatId: 'private:2', userId: '2', stickers: [{ type: 'image', data: { file: 'p.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), '关了私聊就不该收')
})

test('参数：collectMode=ask 不自动收（她自己按编号挑）', async () => {
  const { handlers } = await load({}, { collectMode: 'ask' })
  fetched.length = 0
  handlers.message({ kind: 'group', chatId: 'group:1', userId: '2', stickers: [{ type: 'image', data: { file: 'a.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')), 'ask 模式不该自动收')
})

test('参数：collectMode=owner 只收主人发的', async () => {
  const { handlers } = await load({}, { collectMode: 'owner' })
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
  const { handlers } = await load({}, { collect: false })
  fetched.length = 0
  handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'x.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(!fetched.some((f) => f.url.includes('op=add')))
})

test('参数：maxPerHour=0 不限，=1 时第二张就不收', async () => {
  const lim = await load({}, { maxPerHour: 1 })
  const seg = (n) => [{ type: 'image', data: { file: n, sub_type: 1 } }]
  fetched.length = 0
  lim.handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: seg('a1.jpg'), images: [] })
  await new Promise((r) => setTimeout(r, 80))
  const first = fetched.filter((f) => f.url.includes('op=add')).length
  lim.handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: seg('a2.jpg'), images: [] })
  await new Promise((r) => setTimeout(r, 80))
  const both = fetched.filter((f) => f.url.includes('op=add')).length
  assert.equal(first, 1)
  assert.equal(both, 1, '配额用完就不该再收')
})

test('参数：caption=false 不起名，true 才调分析', async () => {
  const off = await load({}, { caption: false })
  fetched.length = 0
  off.handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'c1.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(fetched.some((f) => f.url.includes('op=add')), '应该入库')
  assert.ok(!fetched.some((f) => f.url.includes('op=analyze')), '关了就不该调分析')

  const on = await load({}, { caption: true })
  fetched.length = 0
  on.handlers.message({ kind: 'private', chatId: 'private:1', userId: '1', stickers: [{ type: 'image', data: { file: 'c2.jpg', sub_type: 1 } }], images: [] })
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(fetched.some((f) => f.url.includes('op=analyze')), '开着就该叫模型起名')
})

test('列表快照带 path（发图要读文件）', async () => {
  const { svc } = await load()
  assert.ok(svc.refresh)
  await svc.refresh()
  assert.ok(true)
})
