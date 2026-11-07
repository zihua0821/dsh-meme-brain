// 表情包（新库）—— 独立模块，不冒充内置。
//
// 架构（用户定的调子，别改回去）：
//   - **内置 stickers 模块原样留在插件里，只是配置里停用它**（modules.stickers.enabled = false）。
//     这样插件升级照常、想退回内置只改一个开关，谁都没被顶掉。
//   - 本模块 id 是 meme-qq，**不跟任何人重名**，只做自己的事。
//   - 内置停用之后，她原本的三条表情行为由这里接住：
//       1. `<sticker:标签>`  → 在 reply/items 里换成我们库里的图（内置那步靠 hub 调 stickers.match）
//       2. 自动配表情        → 同样在 reply/items 里按概率补一张（概率沿用 config.stickers.autoChance）
//       3. 偷表情            → 自己的 message 监听（内置靠 hub 调 stickers.collect）
//
// 库、判重、分析、打分都在 DSH 插件 dsh-meme-brain 里，这里只通过 HTTP 调它。
// 判重规则绝不在这里重写：op=add 内部走 lib/pipeline.js 的 ingestBuffer。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 库根目录：和 dsh-meme-brain 用同一个环境变量，测试时能指向临时目录
const ROOT = process.env.DSH_MEME_BRAIN_ROOT || join(homedir(), '.dsh', 'meme-brain')
const LIBRARY = join(ROOT, 'library')
const MB = 1024 * 1024

const GIF_GCE = Buffer.from([0x21, 0xf9, 0x04])
const WEBP_ANIM = Buffer.from('ANIM')
const PNG_ACTL = Buffer.from('acTL')

/** 'gif' | 'webp' | 'apng' | ''（空串 = 静态或认不出） */
function animatedKind(buf) {
  if (!buf || buf.length < 24) return ''
  const head = buf.subarray(0, 4).toString('ascii')
  if (head.startsWith('GIF')) {
    const first = buf.indexOf(GIF_GCE)
    if (first === -1) return ''
    return buf.indexOf(GIF_GCE, first + 3) !== -1 ? 'gif' : ''
  }
  if (head === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return buf.indexOf(WEBP_ANIM) !== -1 ? 'webp' : ''
  }
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('ascii') === 'PNG') {
    return buf.indexOf(PNG_ACTL) !== -1 ? 'apng' : ''
  }
  return ''
}

const looksAnimated = (seg) => {
  const d = (seg && seg.data) || {}
  if (String(d.sub_type ?? d.subType ?? '') === '11') return true
  return /\.gif$/i.test(String(d.file || d.path || ''))
}

const subTypeOf = (seg) => String(((seg && seg.data) || {}).sub_type ?? ((seg && seg.data) || {}).subType ?? '')

export default {
  id: 'meme-qq',
  name: '表情包（新库）',
  version: '2.0.0',
  api: 1,
  description: '独立的表情模块：用 ~/.dsh/meme-brain 的统一库发图、找图、收表情。内置表情模块保持原样，只是被停用（随时可以切回去）。',
  tab: 'stickers',
  defaults: {
    autoPick: true,      // 自动配表情总开关（概率和内置共用 config.stickers.autoChance）
    ownerImages: false,  // 主人发的普通图片也当表情收（内置没有这个）
    maxMB: 8,            // 收取单张上限（内置没有这个）
    maxSendMB: 5,        // 发送单张上限（内置没有这个）
  },
  settings: [
    { key: 'autoPick', label: '自动配表情', type: 'switch', hint: '关掉就只在她自己写 <sticker:…> 时发。概率用「表情包」页里那个「自动配表情的概率」' },
    { key: 'ownerImages', label: '主人发的图片也收', type: 'switch', hint: '默认关。只收够小、接近方形的' },
    { key: 'maxMB', label: '收取单张上限（MB）', type: 'number', min: 1, max: 32, step: 1, hint: '内置卡 1.5MB，导致大动图永远收不进来；这里放宽' },
    { key: 'maxSendMB', label: '发送单张上限（MB）', type: 'number', min: 1, max: 16, step: 1, hint: '内置没有这道闸门。库里 269/275 张在 5MB 内，超过的发出去会被网关拒' },
  ],

  setup(api) {
    const log = api.log
    const hub = api.core.hub
    const settings = () => api.settings()
    /**
     * 参数唯一来源：面板「表情包」页写的 config.stickers。
     * 内置模块停用了，但这些参数还在、还能改，所以必须认它们——不要自己再造一套同义开关。
     */
    const stickerCfg = () => api.config().stickers || {}
    const stickersOn = () => stickerCfg().enabled !== false

    // ---------- 找 DSH 里的表情库 ----------

    function origin() {
      try {
        return api.dsh.get('webServer')?.getOrigin?.() || ''
      } catch (error) {
        return ''
      }
    }

    async function httpJson(path, init) {
      const base = origin()
      if (!base) throw new Error('拿不到 DSH 的 HTTP 地址')
      const res = await fetch(`${base}/meme-brain/api?${path}`, { signal: AbortSignal.timeout(init?.timeoutMs || 5000), ...init })
      const j = await res.json().catch(() => null)
      if (!j) throw new Error(`返回的不是 JSON（HTTP ${res.status}）`)
      if (!j.ok) throw new Error(j.error?.message || j.error?.code || '请求失败')
      return j.data
    }

    const findRemote = (q) => httpJson(`op=find&${q}`)
    const statusRemote = () => httpJson('op=facets')

    async function addRemote(buf, source = 'qq') {
      const base = origin()
      if (!base) throw new Error('拿不到 DSH 的 HTTP 地址')
      const res = await fetch(`${base}/meme-brain/api?op=add&source=${source}`, {
        method: 'POST',
        body: buf,
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(30000),
      })
      const j = await res.json().catch(() => null)
      if (!j) throw new Error(`入库返回的不是 JSON（HTTP ${res.status}）`)
      if (!j.ok) throw new Error(j.error?.message || j.error?.code || '入库失败')
      return j.data
    }

    const analyzeRemote = (md5) => httpJson('op=analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ md5 }),
      timeoutMs: 90000,
    })

    const annotateRemote = (body) => httpJson('op=annotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    // ---------- 本地快照（reply/items 是同步的，不能现查 HTTP） ----------

    let snap = { items: [], at: 0 }
    let refreshing = null

    async function refresh() {
      if (refreshing) return refreshing
      refreshing = (async () => {
        try {
          const d = await httpJson('op=list&limit=500')
          snap = { items: Array.isArray(d.items) ? d.items : [], at: Date.now() }
        } catch (error) {
          log.debug('表情快照刷新失败（继续用旧的）：', error.message)
        } finally {
          refreshing = null
        }
      })()
      return refreshing
    }

    function items() {
      if (!snap.items.length || Date.now() - snap.at > 60_000) refresh().catch(() => {})
      return snap.items
    }
    refresh().catch(() => {})

    const maxSend = () => Math.min(16, Math.max(1, Number(settings().maxSendMB) || 5)) * MB

    /** 库内相对路径 → 能发出去的绝对路径；太大或文件没了返回 '' */
    function sendablePath(item) {
      if (!item || !item.path) return ''
      const abs = join(LIBRARY, item.path)
      try {
        if (!existsSync(abs)) return ''
        if (statSync(abs).size > maxSend()) return ''
        return abs
      } catch {
        return ''
      }
    }

    const haystack = (it) => [it.name || '', it.character || '', it.text || '', it.tags || '']

    /** 模糊匹配（同步）：名字 10 分、角色 8 分、文字/标签 6 分 */
    function match(query) {
      const q = String(query || '').trim()
      if (!q) return null
      let best = null
      let bestScore = 0
      for (const it of items()) {
        let s = 0
        for (const h of haystack(it)) {
          if (!h) continue
          if (h === q) s = Math.max(s, 10)
          else if (h.includes(q) || q.includes(h)) s = Math.max(s, 6)
          else {
            const common = [...q].filter((c) => h.includes(c)).length
            if (common >= 2) s = Math.max(s, (common / Math.max(q.length, 1)) * 4)
          }
        }
        if (s > bestScore) {
          best = it
          bestScore = s
        }
      }
      return bestScore >= 1.5 ? best : null
    }

    /** 自动配表情用：只从发得出去的里挑，回复里提到的词优先 */
    function pickForReply(text) {
      const all = items()
      if (!all.length) return null
      const usable = all.filter((it) => sendablePath(it))
      const list = usable.length ? usable : all
      const t = String(text || '')
      const words = new Set(['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑'])
      for (const it of list) {
        for (const w of String(it.tags || '').split(/[,，]/)) if (w) words.add(w.trim())
      }
      for (const w of words) {
        if (w && t.includes(w)) {
          const m = match(w)
          if (m && sendablePath(m)) return m
        }
      }
      return list[Math.floor(Math.random() * list.length)]
    }

    // ---------- 回复改写：接住内置模块停用后的三条路 ----------

    // 工具刚替她发过表情 → 记下来，避免同一条回复又发一张
    let lastToolSend = { chatId: '', at: 0, md5: '', name: '' }
    const TOOL_SEND_WINDOW = 20_000

    const textOf = (list) => list.filter((x) => x && x.kind === 'text').map((x) => String(x.value || '')).join(' ')

    api.on('reply/items', (items, info = {}) => {
      if (!Array.isArray(items) || !items.length) return undefined
      const chatId = String(info.chatId || '')
      const inGroup = chatId.startsWith('group:')
      const cfg = stickerCfg()
      let out = items.slice()
      let touched = false

      // 0) 「表情包」总开关关着：她写的表情不解析，也不自动配（面板关掉就该完全不发）
      if (cfg.enabled === false) {
        const stripped = out.filter((it) => !it || it.kind !== 'sticker')
        return stripped.length === out.length ? undefined : stripped
      }

      // 1) 她写的 <sticker:标签> → 换成我们库里的图（内置停用后没人给她解析这个了）
      if (out.some((it) => it && it.kind === 'sticker')) {
        const converted = []
        for (const it of out) {
          if (it && it.kind === 'sticker') {
            const hit = match(it.value)
            const abs = hit ? sendablePath(hit) : ''
            if (abs) converted.push({ kind: 'image', value: abs })
            // 找不到就丢掉：和内置行为一致（没找到就不发）
          } else converted.push(it)
        }
        if (converted.length !== out.length || converted.some((x, i) => x !== out[i])) touched = true
        out = converted
      }

      const justSentTool = lastToolSend.at
        && chatId === lastToolSend.chatId
        && Date.now() - lastToolSend.at < TOOL_SEND_WINDOW

      if (justSentTool) {
        const sent = lastToolSend
        lastToolSend = { chatId: '', at: 0, md5: '', name: '' }
        if (out.some((it) => it && (it.kind === 'image' || it.kind === 'sticker'))) {
          out = out.filter((it) => !it || (it.kind !== 'image' && it.kind !== 'sticker'))
          touched = true
          log.info(`这一轮已经用工具发过「${sent.name || sent.md5.slice(0, 8)}」，去掉回复里重复的那张`)
        }
        return touched ? out : undefined
      }

      // 2) 自动配一张（替代内置的 autoChance 那一步，概率读面板里的值）
      if (settings().autoPick) {
        const hasPic = out.some((it) => it && (it.kind === 'image' || it.kind === 'sticker'))
        const chance = Number(cfg.autoChance ?? 0.35)
        const tooMany = inGroup && out.length >= 2
        if (!hasPic && !tooMany && Math.random() < chance) {
          const pick = pickForReply(textOf(out))
          const abs = pick ? sendablePath(pick) : ''
          if (abs) {
            out.push({ kind: 'image', value: abs })
            touched = true
          }
        }
      }

      return touched ? out : undefined
    })

    // ---------- 收表情（内置停用后，普通表情也要我们自己收） ----------

    const recent = []
    function underQuota() {
      // 配额读面板里的「每小时最多收」，不另设开关
      const n = Math.max(0, Number(stickerCfg().maxPerHour ?? 20) || 0)
      if (!n) return true
      const now = Date.now()
      while (recent.length && now - recent[0] > 3600_000) recent.shift()
      return recent.length < n
    }

    const maxBytes = () => Math.min(32, Math.max(1, Number(settings().maxMB) || 8)) * MB

    function download(src, limit) {
      const s = String(src || '').trim()
      if (!s) return Promise.reject(new Error('没有地址'))
      if (s.startsWith('base64://')) {
        const b = Buffer.from(s.slice(9), 'base64')
        if (b.length > limit) return Promise.reject(new Error(`太大（${Math.round(b.length / MB)}MB）`))
        return Promise.resolve(b)
      }
      if (!/^https?:\/\//i.test(s)) return Promise.reject(new Error('不是 http 地址'))
      return fetch(s, { signal: AbortSignal.timeout(30000), redirect: 'follow' }).then(async (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > limit) throw new Error(`太大（${Math.round(declared / MB)}MB）`)
        const chunks = []
        let total = 0
        for await (const part of res.body) {
          total += part.length
          if (total > limit) throw new Error('太大')
          chunks.push(Buffer.from(part))
        }
        return Buffer.concat(chunks)
      })
    }

    /** 先 get_image 换新 rkey（事件里的 url 几分钟就 403），再退回事件自带地址 */
    async function fetchSegment(seg, limit) {
      const d = (seg && seg.data) || {}
      const sources = []
      if (d.file) {
        try {
          const info = await api.core.onebot.call('get_image', { file: d.file }, { timeoutMs: 15000 })
          for (const x of [info && info.url, info && info.file]) if (x) sources.push(x)
        } catch (error) {
          log.debug('get_image 没拿到新地址：', error.message)
        }
      }
      for (const x of [d.url, d.path, d.file]) if (x) sources.push(x)
      const seen = new Set()
      let last = null
      for (const src of sources) {
        const key = String(src)
        if (seen.has(key)) continue
        seen.add(key)
        try {
          const buf = await download(src, limit)
          if (buf && buf.length) return buf
        } catch (error) {
          last = error
        }
      }
      throw last || new Error('这个表情段没有可用的地址')
    }

    async function ingest(buf, source = 'qq') {
      let r
      try {
        r = await addRemote(buf, source)
      } catch (error) {
        return { ok: false, reason: `入库失败：${error.message}` }
      }
      if (!r.added) {
        return { ok: false, md5: r.md5, reason: r.near?.reason === 'byte-identical' ? '库里已经有了' : '和库里某张重复' }
      }
      recent.push(Date.now())
      log.info(`表情入库 ${r.md5.slice(0, 8)}（${Math.round(buf.length / 1024)}KB）`)
      // 「看图起名」：面板里那个 caption 开关（内置也用它），不另设开关
      if (stickerCfg().caption !== false) {
        analyzeRemote(r.md5)
          .then((d) => log.info(`起名「${d.item?.name || '?'}」`))
          .catch((error) => log.debug('自动起名失败（图已入库）：', error.message))
      }
      refresh().catch(() => {})
      return { ok: true, md5: r.md5 }
    }

    /** 兼容垫片：旧补录模块会调 addFromBuffer/rename（见下面的说明） */
    async function addFromBuffer(buf, opts = {}) {
      const { name = '', tags = [], from = 'manual' } = opts
      const r = await ingest(buf, from)
      if (!r.ok) return { ok: false, reason: r.reason, existed: /已经有了|重复/.test(String(r.reason || '')) }
      if (name || (Array.isArray(tags) && tags.length)) {
        try {
          await annotateRemote({ md5: r.md5, name: name || undefined, tags: Array.isArray(tags) && tags.length ? tags.join(',') : undefined })
        } catch (error) {
          log.debug('垫片改名失败（图已入库）：', error.message)
        }
      }
      refresh().catch(() => {})
      return { ok: true, item: { md5: r.md5 } }
    }

    async function rename(md5, name, tags) {
      try {
        const body = { md5 }
        if (name !== undefined) body.name = String(name).slice(0, 12)
        if (Array.isArray(tags)) body.tags = tags.slice(0, 5).join(',')
        const d = await annotateRemote(body)
        refresh().catch(() => {})
        return { ok: true, item: d }
      } catch (error) {
        return { ok: false, reason: error.message }
      }
    }

    /** 下载一个段再入库（工具用） */
    async function collectSeg(seg, opts = {}) {
      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        return { ok: false, message: '下载失败：' + error.message }
      }
      const r = await addFromBuffer(buf, { name: opts.name || '', tags: opts.tags || [], from: opts.from || 'tool' })
      if (!r.ok) return { ok: false, message: r.existed ? '库里已经有这张了' : (r.reason || '没存成') }
      return { ok: true, md5: r.item.md5 }
    }

    let capturing = Promise.resolve()
    const serialize = (fn) => {
      const next = capturing.then(fn, fn)
      capturing = next.then(() => {}, () => {})
      return next
    }

    async function captureOne(seg, msg) {
      if (!underQuota()) return
      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        log.debug('收表情下载失败：', error.message)
        return
      }
      // 静态字节：本来就是表情段的收；普通图片要开 ownerImages 且够小
      const animated = Boolean(animatedKind(buf))
      const stickerish = subTypeOf(seg) === '1' || subTypeOf(seg) === '7' || subTypeOf(seg) === '11'
        || /^[0-9a-f]{32}\./i.test(String(seg?.data?.file || ''))
      if (!animated && !stickerish) {
        if (!(settings().ownerImages && buf.length <= 1.5 * MB)) return
      }
      await ingest(buf, 'qq')
    }

    async function capture(msg) {
      const cfg = stickerCfg()
      if (!cfg.collect) return
      // 从群里 / 从私聊：面板里能分别关
      if (msg.kind === 'group' && cfg.fromGroups === false) return
      if (msg.kind !== 'group' && cfg.fromPrivate === false) return

      const ownerQQ = String(api.config().ownerQQ || '')
      const mode = String(cfg.collectMode || 'auto')
      // 「她挑」：不自动收，先记着，她用 qq_collect_sticker 按编号收
      if (mode === 'ask') return
      // 「只听主人的」：只有主人发的时候才自动收
      if (mode === 'owner' && !(ownerQQ && String(msg.userId) === ownerQQ)) return

      const segs = []
      const seen = new Set()
      for (const seg of [...(msg.stickers || []), ...(msg.images || [])]) {
        const d = (seg && seg.data) || {}
        const k = String(d.file || d.url || '') + '|' + String(seg?.type || '')
        if (seen.has(k)) continue
        seen.add(k)
        segs.push(seg)
      }
      for (const seg of segs) await serialize(() => captureOne(seg, msg))
    }

    api.on('message', (msg) => {
      capture(msg).catch((error) => log.debug('收表情出错：', error.message))
      return false // 只旁观，不接管
    })

    // ---------- 工具 ----------

    function noteToolSend(md5, name, chatId) {
      lastToolSend = { chatId, at: Date.now(), md5: String(md5 || ''), name: String(name || '') }
      log.info(`工具发了一张表情：${name || md5}（${String(md5).slice(0, 8)}）`)
    }

    const str = (description) => ({ type: 'string', description })
    const FIELDS = {
      query: str('关键词或整句，比如「生气的大肥鱼」「无所谓」'),
      character: str('角色，比如 大肥鱼 / doro / 龙图 / 耄耋'),
      emotion: str('情绪，比如 生气 / 开心 / 委屈 / 抽象'),
      limit: { type: 'integer', description: '要几张，默认 5' },
    }

    const fmt = (r) => (r.items || []).map((it, i) => {
      const s = it.score || {}
      const bits = []
      if (typeof s.valence === 'number') bits.push(`情绪${s.valence}`)
      if (typeof s.aggression === 'number') bits.push(`攻击${s.aggression}`)
      return `${i + 1}. ${it.name || '未命名'}${it.character ? `（${it.character}）` : ''}${bits.length ? ` ${bits.join(' ')}` : ''}${it.text ? ` 字：${it.text}` : ''}`
    }).join('；')

    async function find(args = {}) {
      const p = new URLSearchParams()
      if (args.query) p.set('q', String(args.query))
      if (args.character) p.set('character', String(args.character))
      if (args.emotion) p.set('emotion', String(args.emotion))
      p.set('limit', String(Math.min(10, Math.max(1, Number(args.limit) || 5))))
      return findRemote(p.toString())
    }

    /** 直接发一张（不再走 hub.sendSticker——那是内置模块的服务） */
    async function sendItem(chatId, item) {
      if (!stickersOn()) {
        log.debug('表情包总开关关着，不发')
        return false
      }
      const abs = sendablePath(item)
      if (!abs) return false
      await api.sendImage(chatId, abs)
      noteToolSend(item.md5, item.name, chatId)
      return true
    }

    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      const current = chat.chatId
      return [
        api.defineTool({
          name: 'meme_find',
          description: '在统一表情库里找图（277 张，都带角色/情绪标注）。用户说「来张生气的大肥鱼」「有没有写着无所谓的图」时先用它看看有什么，再把名字告诉对方。找不到就明说没有，不要编。',
          properties: FIELDS,
          execute: async (args) => {
            try {
              const r = await find(args)
              if (!r.items.length) return { ok: false, message: `没找到${args.query ? `「${args.query}」` : ''}的图` }
              return { ok: true, message: `找到 ${r.items.length} 张（共 ${r.total} 张匹配）：${fmt(r)}`, items: r.items.map((i) => ({ md5: i.md5, name: i.name })) }
            } catch (error) {
              return { ok: false, message: `查表情库失败：${error.message}` }
            }
          },
        }),
        api.defineTool({
          name: 'meme_send',
          description: '从统一表情库里挑一张发到当前聊天。想直接发图（而不是只报名字）时用它，它会自动挑最像的那张。发完不要在回复里再写 <sticker:…>，否则会发两张。',
          properties: FIELDS,
          execute: async (args) => {
            try {
              const r = await find({ ...args, limit: 1 })
              if (!r.items.length) return { ok: false, message: '库里没有合适的，别硬发' }
              const item = r.items[0]
              const ok = await sendItem(current, item)
              return ok ? { ok: true, message: `发了「${item.name || item.md5.slice(0, 8)}」` } : { ok: false, message: '没发出去（文件没了，或者超过发送上限）' }
            } catch (error) {
              return { ok: false, message: `发失败：${error.message}` }
            }
          },
        }),
        api.defineTool({
          name: 'qq_send_sticker',
          description: '按名字或情绪关键词发一张表情。一般直接在回复里写 <sticker:名字> 就行，这个工具用于回复之外单独补发。',
          properties: { name: str('表情名字或情绪关键词') },
          required: ['name'],
          execute: async ({ name }) => {
            const hit = match(String(name || ''))
            if (!hit) return { ok: false, message: '表情库里没找到合适的' }
            const ok = await sendItem(current, hit)
            return ok ? { ok: true, message: '发了' } : { ok: false, message: '这张太大了或者文件没了，没发出去' }
          },
        }),
        api.defineTool({
          name: 'qq_list_stickers',
          description: '看看表情库里有什么（名字/角色/图上文字）。挑表情前可以先看。',
          properties: { query: str('可选，按名字/角色/文字筛') },
          execute: async ({ query }) => {
            try {
              const r = await httpJson(`op=list&limit=${query ? 40 : 20}${query ? `&q=${encodeURIComponent(String(query))}` : ''}`)
              return r.items.length
                ? { ok: true, count: r.total, message: r.items.map((i) => i.name || i.md5.slice(0, 8)).join('、') }
                : { ok: false, message: '没有符合的' }
            } catch (error) {
              return { ok: false, message: `查库失败：${error.message}` }
            }
          },
        }),
        api.defineTool({
          name: 'qq_edit_sticker',
          description: '给表情改名字 / 改标签（统一库，改完浏览器界面里也一样）。',
          properties: {
            sticker: str('现在的名字（模糊匹配）'),
            new_name: str('新名字，12 字以内，不改就不填'),
            tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
          },
          required: ['sticker'],
          execute: async ({ sticker, new_name, tags }) => {
            try {
              const hit = match(String(sticker || ''))
              if (!hit) return { ok: false, message: '库里没找到这张' }
              if (!new_name && !(Array.isArray(tags) && tags.length)) return { ok: false, message: '要说改成什么' }
              const body = { md5: hit.md5 }
              if (new_name) body.name = String(new_name).slice(0, 12)
              if (Array.isArray(tags) && tags.length) body.tags = tags.slice(0, 5).join(',')
              await annotateRemote(body)
              refresh().catch(() => {})
              return { ok: true, message: `改好了：「${hit.name || hit.md5.slice(0, 8)}」` }
            } catch (error) {
              return { ok: false, message: `没改成：${error.message}` }
            }
          },
        }),
        api.defineTool({
          name: 'qq_collect_sticker',
          description: '悄悄把聊天里刚出现的表情收进自己的表情库（喜欢才收，不喜欢就别调）。index 从 1 开始；name 是你给它起的名字。',
          properties: {
            index: { type: 'integer', description: '第几张表情（从 1 开始，默认 1）' },
            name: str('给它起的名字（≤12 字）'),
            tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈' },
          },
          execute: async ({ index, name, tags }) => {
            const seg = hub.stickerOf(current, Number(index) || 1)
            if (!seg) return { ok: false, message: '这张表情已经拿不到了（超过 30 分钟，或者这一轮里没有这张）' }
            const r = await collectSeg(seg, { name: String(name || '').slice(0, 12), tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: current })
            if (!r.ok) return r
            return { ok: true, message: `收进库了：「${name || r.md5.slice(0, 8)}」` }
          },
        }),
        api.defineTool({
          name: 'qq_save_sticker',
          description: '把这个聊天里刚发来的那张表情包 / 图片收进表情库。主人说「存一下这个表情」「收藏这张」时用。',
          properties: {
            name: str('备注（≤12 字，可不填）'),
            tags: { type: 'array', items: { type: 'string' }, description: '标签，如 开心/委屈（可不填）' },
          },
          execute: async ({ name, tags }) => {
            const recentMedia = typeof hub.recentMedia === 'function' ? hub.recentMedia(current) || [] : []
            const last = [...recentMedia].reverse().find((x) => x && x.seg)
            if (!last) return { ok: false, message: '这个聊天里最近没有可以存的图' }
            const r = await collectSeg(last.seg, { name: String(name || '').slice(0, 12), tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'owner' })
            if (!r.ok) return r
            return { ok: true, message: `存好了「${name || r.md5.slice(0, 8)}」` }
          },
        }),
      ]
    })

    // ---------- 停用内置模块（保留代码，只关开关） ----------

    /**
     * 内置 stickers 模块留在插件里不动，只是配置里停用；旧补录模块的逻辑已经并进来，也停用。
     * 想退回内置：面板「扩展」页把 stickers 打开，或把 config.json 的 modules.stickers.enabled 改回 true。
     */
    function retireOldModules() {
      try {
        const mods = api.config().modules || {}
        const next = { ...mods }
        const retired = []
        for (const id of ['stickers', 'gif-stickers']) {
          const cur = next[id] || {}
          if (cur.enabled === false) continue
          next[id] = { ...cur, enabled: false }
          retired.push(id)
        }
        if (!retired.length) return
        api.setConfig({ ...api.config(), modules: next })
        log.info(`已停用：${retired.join('、')}（代码原样保留，随时可以在「扩展」页重新打开）`)
      } catch (error) {
        log.warn('停用内置表情模块失败（会和本模块同时工作，注意重复）：', error.message)
      }
    }
    retireOldModules()

    // ---------- 让她知道 ----------

    api.rule(() => '你的表情包在一个统一库里，按角色/情绪/图上文字都能找。要发图就调一次 meme_send（它会直接把图发出去），调完不要在回复里再写 <sticker:…>，否则对方会收到两张；只在回复里写 <sticker:名字> 也可以。库里没有的就直说没有，不要编。')

    api.command({
      name: '表情',
      aliases: ['表情包'],
      desc: '按关键词/情绪找一张表情发出来，例：/表情 生气的大肥鱼',
      run: async (arg, msg) => {
        const q = String(arg || '').trim()
        if (!q) return '用法：/表情 生气的大肥鱼'
        try {
          const r = await find({ query: q, limit: 1 })
          if (!r.items.length) return `库里没有「${q}」`
          const item = r.items[0]
          const ok = await sendItem(msg.chatId, item)
          return ok ? `${item.name || item.md5.slice(0, 8)}${item.character ? `（${item.character}）` : ''}` : '这张发不出去（太大或文件没了）'
        } catch (error) {
          return `查库失败：${error.message}`
        }
      },
    })

    log.info('表情包（新库）已就绪（独立模块，内置 stickers 已停用）')

    return { refresh, find, status: statusRemote, addFromBuffer, rename }
  },
}
