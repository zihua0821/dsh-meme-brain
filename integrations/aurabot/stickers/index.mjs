// 表情包（新库）—— 用 ~/.dsh/meme-brain 的统一表情库替换插件内置的表情库。
//
// 为什么 id 叫 stickers：插件 core/modules.js 的 wanted() 规则是「同名用户模块顶掉内置模块」。
// 用这个名字是为了让聊天中枢（hub）找表情时找到我们，而不是内置的 index.json 库。
// 想退回内置：把 modules.stickers.useBuiltin 设成 true（面板「扩展」页能看到这个模块替换了谁）。
//
// 分工（别搞混）：
//   - 库、判重、分析、打分全在 DSH 插件 dsh-meme-brain 里，这里只通过 HTTP 调它。
//   - 这里只做 QQ 侧的事：发表情、收表情、按人话找图。
//   - 判重规则绝不在这里重写：op=add 内部走 lib/pipeline.js 的 ingestBuffer，和目录导入同一份。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(homedir(), '.dsh', 'meme-brain')
const LIBRARY = join(ROOT, 'library')
const MB = 1024 * 1024

// 动图识别用的字节标记
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

export default {
  id: 'stickers',
  name: '表情包（新库）',
  version: '1.0.0',
  api: 1,
  description: '把表情库换成 ~/.dsh/meme-brain 的统一库：发表情、偷表情、按情绪/角色找图，并补收 QQ 的动图表情。',
  tab: 'stickers',
  defaults: {
    auto: true,          // 自动补收动图表情
    groups: true,        // 群里也收
    ownerImages: false,  // 主人发的普通图片也当表情收
    maxPerHour: 30,
    maxMB: 8,
    maxSendMB: 5,        // 发出去的单张上限：base64 会膨胀 33%。库里 269/275 张在 5MB 内
    autoAnalyze: true,   // 入库后让模型起名/打分
  },
  settings: [
    { key: 'auto', label: '自动补收动图表情', type: 'switch', hint: 'QQ 把动图表情标成 sub_type=11，内置偷表情收不到它们；这里补一条路' },
    { key: 'groups', label: '群里也收', type: 'switch', hint: '关掉只在私聊收' },
    { key: 'ownerImages', label: '主人发的图片也收', type: 'switch', hint: '默认关。只收够小、接近方形的' },
    { key: 'maxPerHour', label: '每小时最多收几张', type: 'number', min: 0, max: 200, step: 1, hint: '0 = 不限' },
    { key: 'maxMB', label: '单张上限（MB）', type: 'number', min: 1, max: 32, step: 1 },
    { key: 'maxSendMB', label: '发出去的单张上限（MB）', type: 'number', min: 1, max: 16, step: 1, hint: 'base64 会让体积涨三分之一；太大的图发出去会被网关拒，不如不发' },
    { key: 'autoAnalyze', label: '入库后自动起名打分', type: 'switch', hint: '每张会调一次视觉模型；关掉就只按 md5 存着，之后在界面里补' },
  ],

  setup(api) {
    const log = api.log
    const hub = api.core.hub
    const settings = () => api.settings()

    // ---------- 找 DSH 里的表情库 ----------

    function origin() {
      try {
        const w = api.dsh.get('webServer')
        return w?.getOrigin?.() || ''
      } catch (error) {
        return ''
      }
    }

    async function httpJson(path, init) {
      const base = origin()
      if (!base) throw new Error('拿不到 DSH 的 HTTP 地址')
      const res = await fetch(`${base}/meme-brain/api?${path}`, {
        signal: AbortSignal.timeout(init?.timeoutMs || 5000),
        ...init,
      })
      const j = await res.json().catch(() => null)
      if (!j) throw new Error(`返回的不是 JSON（HTTP ${res.status}）`)
      if (!j.ok) throw new Error(j.error?.message || j.error?.code || '请求失败')
      return j.data
    }

    const findRemote = (q) => httpJson(`op=find&${q}`)
    const statusRemote = () => httpJson('op=facets')

    /** 入库：字节交给插件判重（判重规则只有那一份） */
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

    // ---------- 本地快照：hub 的 match/pickForReply 是同步调用，不能现查 HTTP ----------

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

    /** 同步拿快照；过期就在后台刷，不阻塞调用方 */
    function items() {
      if (!snap.items.length || Date.now() - snap.at > 60_000) refresh().catch(() => {})
      return snap.items
    }
    refresh().catch(() => {})

    // ---------- hub 要的那几个函数 ----------

    const haystack = (it) => [it.name || '', it.character || '', it.text || '', it.tags || '']

    /** 模糊匹配（同步）：名字 10 分、角色 8 分、文字/标签 6 分，都是「包含」就算 */
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

    /** 自动配表情：回复里出现的词优先，匹配不到随机挑一张（和内置行为一致） */
    function pickForReply(text) {
      const all = items()
      if (!all.length) return null
      // 太大的发不出去，别让自动配表情抽到它们
      const limit = Math.min(16, Math.max(1, Number(settings().maxSendMB) || 6)) * MB
      const sendable = all.filter((it) => !it.bytes || it.bytes <= limit)
      const list = sendable.length ? sendable : all
      const t = String(text || '')
      const words = new Set(['开心', '卖萌', '生气', '委屈', '无语', '嘲讽', '疑惑'])
      for (const it of list) {
        for (const w of String(it.tags || '').split(/[,，]/)) if (w) words.add(w.trim())
      }
      for (const w of words) {
        if (w && t.includes(w)) {
          const m = match(w)
          if (m && (!m.bytes || m.bytes <= limit)) return m
        }
      }
      return list[Math.floor(Math.random() * list.length)]
    }

    /** 发表情用的消息段：本地文件按表情发（sub_type=1）。超过体积上限就不发（发出去也会被网关拒） */
    function segmentFor(item) {
      if (!item || !item.path) return null
      const abs = join(LIBRARY, item.path)
      if (!existsSync(abs)) return null
      const limit = Math.min(16, Math.max(1, Number(settings().maxSendMB) || 6)) * MB
      const buf = readFileSync(abs)
      if (buf.length > limit) {
        log.info(`「${item.name || item.md5.slice(0, 8)}」${Math.round(buf.length / MB)}MB，超过发送上限 ${Math.round(limit / MB)}MB，没发`)
        return null
      }
      return {
        type: 'image',
        data: {
          file: 'base64://' + buf.toString('base64'),
          sub_type: 1,
          summary: `[${item.name || '表情'}]`,
        },
      }
    }

    /** 发出去一次就记一笔（内置用 uses 做淘汰；我们的库不淘汰，所以只记 lastUsed） */
    let lastUsed = new Map()
    function markUsed(md5) {
      lastUsed.set(md5, Date.now())
      if (lastUsed.size > 500) lastUsed = new Map([...lastUsed].slice(-200))
    }

    function library() {
      return { items: items() }
    }

    // ---------- 兼容垫片：内置模块曾经导出这几个 ----------
    //
    // 旧的「动图表情补收」模块会调 api.use('stickers').addFromBuffer(...)。
    // 它现在被我们关掉了，但万一哪天重新打开，没有这个函数就会崩。
    // 有垫片的话它照样能用——只是入库改走新库。
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

    // ---------- 收表情 ----------

    const recent = []
    function underQuota() {
      const n = Math.max(0, Number(settings().maxPerHour) || 0)
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
      return fetch(s, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
        .then(async (res) => {
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

    /**
     * 下载一个消息段里的图。
     * 先 get_image 换新 rkey（事件里那个 url 过几分钟就 403），再退回事件自带地址。
     * 这套顺序是从旧的「动图表情补收」模块里搬过来的——它是踩出来的。
     */
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

    /**
     * 入库一张。返回 { ok, md5, reason }
     * 判重在插件那边做：这里只看结果，不自己比。
     */
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
      if (settings().autoAnalyze) {
        analyzeRemote(r.md5)
          .then((d) => log.info(`起名「${d.item?.name || '?'}」`))
          .catch((error) => log.debug('自动起名失败（图已入库）：', error.message))
      }
      refresh().catch(() => {})
      return { ok: true, md5: r.md5 }
    }

    /** hub 收到表情时调它（sub_type=1 那种） */
    async function collect(seg, chatId) {
      const cfg = api.config().stickers || {}
      if (!cfg.enabled || !cfg.collect) return { ok: false, reason: '偷表情关着' }
      if (!underQuota()) return { ok: false, reason: '这小时收够了' }
      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        return { ok: false, reason: '下载失败：' + error.message }
      }
      return ingest(buf, 'qq')
    }

    // ---------- 补收：QQ 的动图表情（sub_type=11）内置收不到 ----------

    let capturing = Promise.resolve()
    const serialize = (fn) => {
      const next = capturing.then(fn, fn)
      capturing = next.then(() => {}, () => {})
      return next
    }

    async function captureOne(seg, msg) {
      const animated = looksAnimated(seg)
      const subType = String(seg.data?.sub_type ?? seg.data?.subType ?? '')
      const stickerish = subType === '11' || subType === '7' || /^[0-9a-f]{32}\./i.test(String(seg.data?.file || ''))
      if (!animated && !stickerish && !settings().ownerImages) return
      if (!underQuota()) return

      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        log.debug('补收下载失败：', error.message)
        return
      }
      // 静态字节：只有「本来就是表情段」的才收；普通图片不收（那不是表情）
      if (!animatedKind(buf) && !stickerish) return
      await ingest(buf, 'qq')
    }

    async function capture(msg) {
      if (!settings().auto) return
      if (msg.kind === 'group' && !settings().groups) return
      const ownerQQ = String(api.config().ownerQQ || '')
      const takePlain = Boolean(settings().ownerImages) && ownerQQ && String(msg.userId) === ownerQQ

      const segs = []
      const seen = new Set()
      for (const seg of [...(msg.stickers || []), ...(msg.images || [])]) {
        const d = (seg && seg.data) || {}
        // hub 自己会收 sub_type=1 的表情，这里别重复下载
        const subType = String(d.sub_type ?? d.subType ?? '')
        if (subType === '1' && !looksAnimated(seg)) continue
        const k = String(d.file || d.url || '') + '|' + String(seg?.type || '')
        if (seen.has(k)) continue
        seen.add(k)
        segs.push(seg)
      }
      if (!segs.length) return
      if (!takePlain) {
        // 主人普通图片那条路只在 takePlain 时走，别的图片一律跳过
        for (let i = segs.length - 1; i >= 0; i--) {
          const d = (segs[i] && segs[i].data) || {}
          const subType = String(d.sub_type ?? d.subType ?? '')
          const stickerish = subType === '11' || subType === '7' || /^[0-9a-f]{32}\./i.test(String(d.file || ''))
          if (!looksAnimated(segs[i]) && !stickerish) segs.splice(i, 1)
        }
      }
      for (const seg of segs) await serialize(() => captureOne(seg, msg))
    }

    api.on('message', (msg) => {
      capture(msg).catch((error) => log.debug('补收出错：', error.message))
      return false // 只是旁观，不接管
    })

    // ---------- 工具：她自己决定什么时候用 ----------

    const str = (description) => ({ type: 'string', description })
    const FIELDS = { query: str('关键词或整句，比如「生气的大肥鱼」「无所谓」'), character: str('角色，比如 大肥鱼 / doro / 龙图 / 耄耋'), emotion: str('情绪，比如 生气 / 开心 / 委屈 / 抽象'), limit: { type: 'integer', description: '要几张，默认 5' } }

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

    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      const current = chat.chatId
      return [
        api.defineTool({
          name: 'meme_find',
          description: '在统一表情库里找图（275 张，都带角色/情绪标注）。用户说「来张生气的大肥鱼」「有没有写着无所谓的图」「找张摆烂的」时先用它看看有什么，再把名字告诉对方。找不到就明说没有，不要编。',
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
          description: '从统一表情库里挑一张发到当前聊天。想直接发图（而不是只报名字）时用它。参数和 meme_find 一样，它会自动挑最像的那张。',
          properties: FIELDS,
          execute: async (args) => {
            try {
              const r = await find({ ...args, limit: 1 })
              if (!r.items.length) return { ok: false, message: '库里没有合适的，别硬发' }
              const item = r.items[0]
              const ok = await hub.sendSticker(current, item)
              return ok ? { ok: true, message: `发了「${item.name || item.md5.slice(0, 8)}」` } : { ok: false, message: '没发出去（表情被关着或者文件没了）' }
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
            const ok = await hub.sendSticker(current, String(name || ''))
            return ok ? { ok: true, message: '发了' } : { ok: false, message: '表情库里没找到合适的' }
          },
        }),
        api.defineTool({
          name: 'qq_list_stickers',
          description: '看看表情库里有什么（名字/角色/图上文字）。挑表情前可以先看。',
          properties: { query: str('可选，按名字/角色/文字筛') },
          execute: async ({ query }) => {
            try {
              const r = await findRemote(`op=list&limit=${query ? 40 : 20}${query ? `&q=${encodeURIComponent(String(query))}` : ''}`)
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
          description: '给表情改名字 / 改标签（库是统一库，改完浏览器界面里也一样）。',
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
      ]
    })

    /**
     * 兼并旧的「动图表情补收」模块：本模块已经把它那套（get_image 换 rkey + 动图判定 + 入库）搬进来了。
     * 两个都开着会重复下载、重复占配额、重复起名，所以这里关掉它。
     * 想恢复：面板「扩展」页把 gif-stickers 打开，或者把 config.json 的 modules.gif-stickers.enabled 改成 true。
     */
    function absorbOldModule() {
      try {
        const mods = api.config().modules || {}
        const old = mods['gif-stickers'] || {}
        if (old.enabled === false) return
        // 没有条目也照样写：模块默认是开的（enabled !== false 就算开）
        api.setConfig({ ...api.config(), modules: { ...mods, 'gif-stickers': { ...old, enabled: false } } })
        log.info('已接管动图补收：旧的 gif-stickers 模块已关闭（想恢复就在「扩展」页重新打开它）')
      } catch (error) {
        log.warn('关闭旧的补收模块失败（可能两边都在收，注意配额）：', error.message)
      }
    }
    absorbOldModule()

    // ---------- 让她知道自己有这本账 ----------

    api.rule(() => '你的表情包在一个统一库里，按角色/情绪/图上文字都能找。要挑图用 meme_find 先看，发图用 meme_send；回复里也可以直接写 <sticker:名字>。库里没有的就直说没有，不要编。')

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
          const abs = item.path ? join(LIBRARY, item.path) : ''
          if (abs && existsSync(abs)) await api.sendImage(msg.chatId, abs)
          return `${item.name || item.md5.slice(0, 8)}${item.character ? `（${item.character}）` : ''}`
        } catch (error) {
          return `查库失败：${error.message}`
        }
      },
    })

    log.info('表情包（新库）已接管：发表情/偷表情/找图都走 ~/.dsh/meme-brain')

    // hub 通过这些函数用我们的库
    return { match, segmentFor, pickForReply, collect, library, markUsed, refresh, find, status: statusRemote, addFromBuffer, rename }
  },
}
