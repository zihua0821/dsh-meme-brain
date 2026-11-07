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

/** 参数表：`defaults` 与「清理未知键」共用这一份，避免两边写重 */
const DEFAULTS = {
  enabled: true,          // 发表情总开关
  autoChance: 0.35,       // 自动配表情概率（0 = 关）
  collect: true,          // 收表情
  fromGroups: true,       // 从群里收
  fromPrivate: true,      // 从私聊收
  collectMode: 'auto',    // auto 全都收 / owner 只听主人的 / ask 她挑
  maxPerHour: 20,         // 每小时最多收
  caption: true,          // 看图起名（唯一花钱的开关）
  maxMB: 8,               // 收取单张上限
  maxSendMB: 5,           // 发送单张上限
  collectPlain: false,    // 旧口径：普通图片按尺寸猜（judgeMode=size 时才用）
  judgeMode: 'model',     // 普通图片怎么判：model=问模型 / size=按尺寸猜 / off=不收
  charEditMode: 'owner',  // 谁能通过对话改库：owner=只有主人 / anyone=群里谁都可以 / off / 关掉
  faces: true,            // 夹 QQ 小黄脸（不是本库的功能，但面板页挪走后只有这里能改）
}

export default {
  id: 'meme-qq',
  name: '表情脑',
  version: '3.2.0',
  api: 1,
  description: 'dsh-meme-brain 插件里的表情库在 QQ 这边的出口：发表情、找图、收表情都走这里。参数在本页，内置表情模块保持停用。',
  // 为什么不用 tab：面板写死了「表情包」页签只在内置 stickers 模块运行时才出现
  // （TAB_MODS = { stickers: ['stickers'] }），内置一停那一页就没了。
  // 自定义模块页只能在「系统」组（navGroupOf 对自定义页只有 平台/系统 两个去处）。
  // 结论：内置关着的前提下，参数页进不了「表达」。独立页最稳。
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '发表情', type: 'switch', hint: '关掉她就不发表情（也不解析回复里的 <sticker:…>），但收表情不受影响' },
    { key: 'autoChance', label: '自动配表情的概率', type: 'number', min: 0, max: 1, step: 0.05, hint: '0.35 = 三成多会自己补一张；填 0 = 完全不用自动配' },
    { key: 'collect', label: '收表情', type: 'switch', hint: '别人发的表情包会被收进库（普通照片不收）' },
    { key: 'fromGroups', label: '　从群里收', type: 'switch', hint: '关掉就不在群里收' },
    { key: 'fromPrivate', label: '　从私聊收', type: 'switch', hint: '关掉就不在私聊收' },
    { key: 'collectMode', label: '怎么收', type: 'select', options: [
      { value: 'auto', label: '全都收' },
      { value: 'owner', label: '只听主人的' },
      { value: 'ask', label: '她挑' },
    ], hint: '她挑：先记着、提示她「第几张不错」，她喜欢才凭编号收' },
    { key: 'maxPerHour', label: '每小时最多收', type: 'number', min: 0, max: 200, step: 1, hint: '0 = 不限' },
    { key: 'caption', label: '看图起名', type: 'switch', hint: '收下后调一次视觉模型起名打分。关掉就只按 md5 存着，之后在界面里补' },
    { key: 'maxMB', label: '收取单张上限（MB）', type: 'number', min: 1, max: 32, step: 1, hint: '内置卡 1.5MB，大动图永远收不进来；这里放宽' },
    { key: 'maxSendMB', label: '发送单张上限（MB）', type: 'number', min: 1, max: 16, step: 1, hint: '超过就不发（发出去会被网关拒）。库里 269/275 张在 5MB 内' },
    { key: 'judgeMode', label: '普通图片怎么判', type: 'select', options: [
      { value: 'model', label: '问模型（准，每张一次调用，有缓存）' },
      { value: 'size', label: '按尺寸猜（免费，会漏也会错）' },
      { value: 'off', label: '不收普通图片' },
    ], hint: '群里发的表情包经常就是普通图片（QQ 不标表情段），只能看图判断。选「问模型」后同图只判一次，结果缓存在 judge-cache.json' },
    { key: 'collectPlain', label: '（旧）按尺寸收普通图片', type: 'switch', hint: '只在「普通图片怎么判=按尺寸猜」时生效：近方形、边长≤600、≤512KB' },
    { key: 'charEditMode', label: '谁能对话改库', type: 'select', options: [
      { value: 'owner', label: '只有主人（推荐）' },
      { value: 'anyone', label: '谁都可以（群里任何人都能改）' },
      { value: 'off', label: '关掉（不让她改库）' },
    ], hint: '对话里说「这张是XX角色」就能改角色表。注意：这是写库权限，默认只给主人' },
    { key: 'faces', label: '夹 QQ 小黄脸', type: 'switch', hint: '回复里能夹 /捂脸 /斜眼笑 这种系统表情。这是插件本来的功能，不属于表情库，但归到这里统一管' },
  ],

  setup(api) {
    const log = api.log
    const hub = api.core.hub
    /**
     * 参数唯一来源：本模块的设置（面板「扩展」→ 表情包（新库））。
     * 内置那套 config.stickers 不再作为来源——它只被镜像成「旧库路径全关」，
     * 免得 hub 那边的内置逻辑（发表情、自动配、提示收图）插一脚。
     */
    const settings = () => api.settings()
    const stickersOn = () => settings().enabled !== false

    /**
     * 把本模块的设置镜像进 config.stickers 里 hub 还认的那几个字段。
     * 为什么要镜像：hub 不看模块设置，只看 config；「她挑」模式的轻提示、以及
     * 夹小黄脸，都还在 hub 手里。不镜像就会两边判断不一致。
     * enabled 恒为 false：内置模块没在跑，hub 的旧库发表情/自动配路径必须保持关闭。
     */
    function mirrorToCoreConfig() {
      try {
        const s = settings()
        const cfg = api.config()
        const cur = cfg.stickers || {}
        const next = {
          ...cur,
          enabled: false, // 旧库路径一律关掉（双保险，内置模块本来就没跑）
          faces: s.faces !== false,
          collect: s.collect !== false,
          collectMode: s.collectMode || 'auto',
          fromGroups: s.fromGroups !== false,
          fromPrivate: s.fromPrivate !== false,
          // 这三个在「表达 → 表情包」页上还留着旧卡片，镜过去让数字和本页一致；
          // 在旧卡片上改也会被下一次镜像覆盖回来（那儿已经不是真相了）
          autoChance: Number(s.autoChance ?? 0.35),
          maxPerHour: Number(s.maxPerHour ?? 20),
          caption: s.caption !== false,
        }
        if (JSON.stringify(cur) !== JSON.stringify(next)) {
          api.setConfig({ ...cfg, stickers: next })
          log.debug('已把表情设置镜像到 config.stickers')
        }
      } catch (error) {
        log.warn('镜像表情设置失败（hub 那边的提示可能与设置不一致）：', error.message)
      }
    }

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

    /**
     * 问 Host：「这张是不是表情包？」
     * 模型调用可能要几秒，给 20 秒；失败就抛，让调用方退回按尺寸猜。
     */
    async function judgeRemote(buf) {
      const base = origin()
      if (!base) throw new Error('拿不到 DSH 的 HTTP 地址')
      const res = await fetch(`${base}/meme-brain/api?op=judge`, {
        method: 'POST',
        body: buf,
        headers: { 'content-type': 'application/octet-stream' },
        signal: AbortSignal.timeout(20000),
      })
      const j = await res.json().catch(() => null)
      if (!j) throw new Error(`判定返回的不是 JSON（HTTP ${res.status}）`)
      if (!j.ok) throw new Error(j.error?.message || j.error?.code || '判定失败')
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

    // ---------- 「刚才那张」与「刚才是谁」 ----------
    // 对话里改库需要两个现场信息：这次说的是哪张图、上一个说话的人是谁。
    // 都只在内存里记最近一次（重启就丢，可接受：这类指令都是即时发生的）。

    let lastImage = new Map()   // chatId -> { md5, at }
    let lastSender = new Map()  // chatId -> { userId, at }
    const RECENT_WINDOW = 10 * 60_000

    function noteImage(chatId, md5) {
      if (chatId && md5) lastImage.set(chatId, { md5: String(md5), at: Date.now() })
    }

    /** 取这个聊天最近那张图（10 分钟内），没有就 null */
    function recentImage(chatId) {
      const hit = lastImage.get(chatId)
      if (!hit) return null
      if (Date.now() - hit.at > RECENT_WINDOW) return null
      return items().find((it) => it.md5 === hit.md5) || { md5: hit.md5 }
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
      let out = items.slice()
      let touched = false

      // 1) 「发表情」总开关关着：她写的表情不解析，也不自动配
      if (!stickersOn()) {
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

      // 2) 自动配一张（概率用本模块的设置，0 = 关）
      const chance = Number(settings().autoChance ?? 0.35)
      if (chance > 0) {
        const hasPic = out.some((it) => it && (it.kind === 'image' || it.kind === 'sticker'))
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
      const n = Math.max(0, Number(settings().maxPerHour ?? 20) || 0)
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
        // 判重命中时把「撞上谁」查出来：日志里只说「和库里重复」等于没说
        const nearMd5 = r.near?.md5 || r.md5
        const hit = items().find((it) => it.md5 === nearMd5)
        const who = hit ? `「${hit.name || '未命名'}」(${String(nearMd5).slice(0, 8)})` : String(nearMd5).slice(0, 8)
        const dist = typeof r.near?.max === 'number' ? `，距离 ${r.near.max}` : ''
        return { ok: false, md5: nearMd5, reason: `和库里${who}重复${dist}` }
      }
      recent.push(Date.now())
      log.info(`表情入库 ${r.md5.slice(0, 8)}（${Math.round(buf.length / 1024)}KB）`)
      // 「看图起名」：本模块的设置（唯一花钱的开关）
      if (settings().caption !== false) {
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
      // 重复时把 md5 带回去：上层要拿它查出「已经在库里那张」叫什么
      if (!r.ok) return { ok: false, md5: r.md5, reason: r.reason, existed: /已经有了|重复/.test(String(r.reason || '')) }
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

    /**
     * 下载一个段再入库（工具用）。返回的 message 是给她的原话。
     *
     * 判重撞车时不只是回「已经有了」：如果她/主人顺口给了名字或标签，
     * 就把名字应用到**已有那张**上（"存一下这张，叫猫猫捂嘴" 应该生效，而不是白说一句）。
     */
    async function collectSeg(seg, opts = {}) {
      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        return { ok: false, message: '下载失败：' + error.message }
      }

      const name = String(opts.name || '').trim().slice(0, 12)
      const tags = Array.isArray(opts.tags) ? opts.tags.filter(Boolean).slice(0, 3) : []
      const r = await addFromBuffer(buf, { name, tags, from: opts.from || 'tool' })

      // 结果故意做得很淡：存图是后台动作，不该成为她的话题。
      // 但也绝不改写她的回复——「存图」和「怎么回」是两条独立的路。
      if (r.ok) return { ok: true, md5: r.md5, message: '好' }
      if (!r.existed) return { ok: false, message: r.reason || '没存成' }

      const hit = r.md5 ? items().find((it) => it.md5 === r.md5) : null
      const shown = hit && hit.name ? `「${hit.name}」` : ''

      if (name || tags.length) {
        try {
          await annotateRemote({
            md5: r.md5,
            ...(name ? { name } : {}),
            ...(tags.length ? { tags: tags.join(',') } : {}),
          })
          refresh().catch(() => {})
          return { ok: true, md5: r.md5, message: '好' }
        } catch (error) {
          log.debug('重复时改名失败：', error.message)
        }
      }
      // 本来就在库里：对她来说等于「已经办好了」，同样只回一个中性的字
      return { ok: true, md5: r.md5, message: shown ? `好（这张叫${shown}）` : '好' }
    }

    let capturing = Promise.resolve()
    const serialize = (fn) => {
      const next = capturing.then(fn, fn)
      capturing = next.then(() => {}, () => {})
      return next
    }

    /** 读图片尺寸（拿不到就返回 null，不抛） */
    function sizeOf(buf) {
      try {
        const inbound = api.lib('chat/inbound.js')
        const { width, height } = inbound.imageSize(buf)
        return { width, height }
      } catch (error) {
        return null
      }
    }

    /**
     * 普通图片（QQ 没标成表情段的）能不能当表情收。
     * 只在「普通图片也收」开着时才走到这里；闸门写死，避免又收进截图：
     *   - 近方形：宽高比 0.6 ~ 1.7（横幅截图/长图排除）
     *   - 边长 ≤ 600、体积 ≤ 512KB（921x713、878x620 那种截图排除）
     */
    function looksLikeSticker(buf) {
      if (buf.length > 512 * 1024) return false
      const size = sizeOf(buf)
      if (!size || !size.width || !size.height) return false
      const side = Math.max(size.width, size.height)
      if (side > 600) return false
      const ratio = size.width / size.height
      return ratio >= 0.6 && ratio <= 1.7
    }

    async function captureOne(seg, chatId) {
      if (!underQuota()) {
        log.debug('这一小时收得够多了（配额用完），跳过')
        return false
      }
      let buf
      try {
        buf = await fetchSegment(seg, maxBytes())
      } catch (error) {
        log.debug('收表情下载失败：', error.message)
        return false
      }
      // 判定「这到底是不是表情」只用确凿证据，不猜文件名：
      //   1. 字节是真动图（GIF 多帧 / 动 WebP / APNG）—— 内置从来收不到这类，正是我们要补的
      //   2. QQ 自己把它标成表情段（sub_type = 1 收藏表情 / 7 大表情 / 11 动图表情）
      // 之前还看「文件名像 <32位md5>.jpg 就当表情」，结果把 QQ 里所有图片都当表情收进来了
      // （实收了两张游戏截图：921x713 / 878x620）。文件名不能作为证据。
      const animated = Boolean(animatedKind(buf))
      const marked = ['1', '7', '11'].includes(subTypeOf(seg))

      if (!animated && !marked) {
        const s = settings()
        const mode = String(s.judgeMode || 'model')

        if (mode === 'off' || (mode === 'size' && s.collectPlain !== true)) {
          log.debug(`不像表情，跳过（sub_type=${subTypeOf(seg) || '无'}，${Math.round(buf.length / 1024)}KB；当前「普通图片怎么判」=${mode}）`)
          return false
        }

        if (mode === 'model') {
          // 唯一需要看图判断的类别：问模型。模型有结论就以它为准（内容 > 尺寸）
          let verdict = null
          try {
            verdict = await judgeRemote(buf)
          } catch (error) {
            log.debug('模型判定失败，退回按尺寸猜：', error.message)
          }
          if (verdict) {
            if (!verdict.sticker) {
              log.info(`这张不是表情包，不收（${verdict.why || '模型判断'}${verdict.cached ? '，缓存' : ''}）`)
              return false
            }
            log.info(`模型判定是表情包（${verdict.why || '无误'}${verdict.cached ? '，缓存' : ''}）`)
            const r = await ingest(buf, 'qq')
            noteImage(chatId, r.md5)
            if (r && !r.ok && r.reason) log.debug(`没入库：${r.reason}`)
            return Boolean(r && r.ok)
          }
          log.debug('模型没给结论，改用尺寸兜底')
        }

        if (!looksLikeSticker(buf)) {
          const size = sizeOf(buf)
          log.debug(`普通图片不像表情，跳过（${size ? `${size.width}x${size.height}` : '尺寸未知'}，${Math.round(buf.length / 1024)}KB）`)
          return false
        }
        log.info(`收了一张普通图片（${Math.round(buf.length / 1024)}KB）`)
      }

      const r = await ingest(buf, 'qq')
      // 记下「这个聊天最近一张图是哪张」，对话里纠正角色时要用（判重命中也要记）
      noteImage(chatId, r.md5)
      // 判重命中也是静默的「已经办好了」，但排查时要能看见，所以记一条 debug
      if (r && !r.ok && r.reason) log.debug(`没入库：${r.reason}`)
      return Boolean(r && r.ok)
    }

    async function capture(msg) {
      const s = settings()
      const nSticker = (msg.stickers || []).length
      const nImage = (msg.images || []).length
      // 入口观测：没这条日志就说明「模块没收到事件」，有但没后续就说明「事件里没图」。
      // 排查「某张图为什么没存」全靠这一行，别删。
      if (nSticker || nImage) {
        log.debug(`收到图片消息 ${msg.kind || '?'} ${msg.chatId || '?'}：表情段 ${nSticker}，图片段 ${nImage}`)
      } else if (/\[图片\]|\[动画表情\]/.test(String(msg.text || ''))) {
        log.debug(`收到一条「${String(msg.text).slice(0, 10)}」但没有任何可下载的图片段（可能是接收链路丢段），跳过`)
      }

      if (s.collect === false) return
      // 从群里 / 从私聊：分别能关
      if (msg.kind === 'group' && s.fromGroups === false) {
        log.debug('不从群里收表情，跳过')
        return
      }
      if (msg.kind !== 'group' && s.fromPrivate === false) {
        log.debug('不从私聊收表情，跳过')
        return
      }

      const ownerQQ = String(api.config().ownerQQ || '')
      const fromOwner = Boolean(ownerQQ) && String(msg.userId) === ownerQQ
      const mode = String(s.collectMode || 'auto')
      // 「她挑」：不自动收，先记着，她用 qq_collect_sticker 按编号收
      if (mode === 'ask') {
        log.debug('收取方式是「她挑」，不自动存')
        return
      }
      // 「只听主人的」：只有主人发的时候才自动收
      if (mode === 'owner' && !fromOwner) return

      const segs = []
      const seen = new Set()
      for (const seg of [...(msg.stickers || []), ...(msg.images || [])]) {
        const d = (seg && seg.data) || {}
        const k = String(d.file || d.url || '') + '|' + String(seg?.type || '')
        if (seen.has(k)) continue
        seen.add(k)
        segs.push(seg)
      }

      // 存图纯粹是后台动作：不受这一轮回复影响，也不影响这一轮回复。
      for (const seg of segs) await serialize(() => captureOne(seg, msg.chatId))
    }

    api.on('message', (msg) => {
      // 记现场：谁在说、这个聊天最近一张图是哪张（后面 qq_set_character 要用）
      if (msg.chatId) lastSender.set(msg.chatId, { userId: String(msg.userId || ''), at: Date.now() })
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
          name: 'qq_set_character',
          description: '主人让你改某张表情的角色（或外观/场景）时用这个。定位顺序：md5 前缀 > 名字 > 这个聊天里刚发的那张。只有主人能改。',
          properties: {
            character: str('角色名，比如 大肥鱼 / doro / 龙图。新名字会自动建进角色表并锁定'),
            sticker: str('要改哪张：名字或关键词。不填就用这个聊天里最近那张图'),
            md5: str('要改哪张：md5 前缀（最精确，可选）'),
            appearance: str('顺便改外观描述（可选）'),
            scene: str('顺便改场景，逗号分隔，最多 3 个（可选）'),
          },
          required: ['character'],
          execute: async ({ character, sticker, md5, appearance, scene }, toolCtx) => {
            const chatId = toolCtx?.chat?.chatId || current
            const ownerQQ = String(api.config().ownerQQ || '')
            const sender = String(lastSender.get(chatId)?.userId || '')
            const mode = String(settings().charEditMode || 'owner')
            if (mode === 'off') return { ok: false, message: '改库功能关着（参数页「谁能对话改库」）' }
            if (mode === 'owner' && ownerQQ && sender !== ownerQQ) {
              return { ok: false, message: '只有主人能改表情库' }
            }

            // 定位：md5 > 名字 > 这个聊天最近那张
            let hit = null
            if (md5) hit = items().find((it) => String(it.md5).startsWith(String(md5).toLowerCase())) || null
            if (!hit && sticker) hit = match(String(sticker))
            if (!hit && !sticker && !md5) hit = recentImage(chatId)
            if (!hit) {
              return {
                ok: false,
                message: sticker
                  ? `库里没找到「${sticker}」。可以说得具体点，或者让我用刚发的那张`
                  : '没认出你说的是哪一张。把它发出来、或者告诉我名字',
              }
            }

            try {
              const body = { md5: hit.md5, character: String(character) }
              if (typeof appearance === 'string' && appearance) body.appearance = appearance
              if (typeof scene === 'string' && scene) body.scene = scene
              const updated = await annotateRemote(body)
              refresh().catch(() => {})
              log.info(`对话改库：「${hit.name || hit.md5.slice(0, 8)}」→ 角色「${updated.character || character}」`)
              return {
                ok: true,
                md5: hit.md5,
                message: `改好了：「${hit.name || hit.md5.slice(0, 8)}」现在的角色是「${updated.character || character}」`,
              }
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
            const r = await collectSeg(seg, { name: String(name || '').slice(0, 12), tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: current, chatId: current })
            return r
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
            const r = await collectSeg(last.seg, { name: String(name || '').slice(0, 12), tags: Array.isArray(tags) ? tags.slice(0, 3) : [], from: 'owner', chatId: current })
            return r
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
          // 已经是干净的 { enabled: false } 就别再写；否则重建一次，
          // 顺手清掉 v1 冒充内置时留下的 forkedFrom / useBuiltin
          if (cur.enabled === false && Object.keys(cur).length === 1) continue
          next[id] = { enabled: false }
          retired.push(id)
        }
        if (!retired.length) return
        // 函数形式 = 整份替换；用深合并的话被删掉的 forkedFrom 会留下来
        api.setConfig((whole) => ({ ...whole, modules: next }))
        log.info(`已停用：${retired.join('、')}（代码原样保留，随时可以在「扩展」页重新打开）`)
      } catch (error) {
        log.warn('停用内置表情模块失败（会和本模块同时工作，注意重复）：', error.message)
      }
    }
    retireOldModules()
    migrateLegacySettings()
    mirrorToCoreConfig()

    /**
     * 迁一次旧设置 + 清掉已不存在的键。
     *
     * 两个坑：
     *   1. `api.setConfig(patch)` 是**深合并**，删键删不掉；要删必须用函数形式（整份替换）。
     *   2. `api.settings()` 是「默认值 + 存下来的值」合并，旧版留下的键会一直压在新默认值上，
     *      表现为「改了默认值却不生效」，而且面板里根本看不见它。
     *
     * 旧版的键（autoPick/autoAnalyze/ownerImages…）在，说明这份设置是 v1/v2 留下的：
     * 当时那几个参数还是在内置「表情包」页里设的，先把用户设过的值搬过来再清理。
     */
    function migrateLegacySettings() {
      try {
        const cfg = api.config()
        const cur = { ...(cfg.ext?.['meme-qq'] || {}) }
        const legacy = 'autoPick' in cur || 'autoAnalyze' in cur || 'ownerImages' in cur
        let changed = false

        if (legacy) {
          const src = cfg.stickers || {}
          for (const k of ['autoChance', 'maxPerHour', 'caption', 'faces', 'collect', 'collectMode', 'fromGroups', 'fromPrivate']) {
            if (src[k] !== undefined && cur[k] !== src[k]) {
              cur[k] = src[k]
              changed = true
            }
          }
          log.info('检测到旧版设置，已把当时在内置面板里设过的值搬过来')
        }

        const stale = Object.keys(cur).filter((k) => !(k in DEFAULTS))
        for (const k of stale) delete cur[k]
        if (stale.length) {
          changed = true
          log.info(`清掉旧版遗留设置：${stale.join('、')}`)
        }
        if (!changed) return

        // 函数形式 = 整份替换，删除才算数
        api.setConfig((whole) => ({ ...whole, ext: { ...whole.ext, 'meme-qq': cur } }))
      } catch (error) {
        log.debug('迁移旧设置失败（不影响运行）：', error.message)
      }
    }
    // 面板里改完设置（保存）时重新镜像一次，免得 hub 那边的提示和设置不同步
    api.on('config', () => mirrorToCoreConfig())

    // ---------- 让她知道 ----------

    api.rule(() => '你的表情包在一个统一库里，按角色/情绪/图上文字都能找。要发图就调一次 meme_send（它会直接把图发出去），调完不要在回复里再写 <sticker:…>，否则对方会收到两张；只在回复里写 <sticker:名字> 也可以。库里没有的就直说没有，不要编。\n当主人明确要你"把这张设成/改成某个角色"（比如「这张是 doro 第二形态」「把这张改成蘑菇头」）时，调一次 qq_set_character：不填 sticker 就用他刚发的那张，角色名照他说的写，然后回一句改成了什么。只有明确的改库要求才动这一手——随口评价一张图不算。\n存表情是顺手做的事，跟聊天是两件互不相干的事：不用提存图、不用说「存好了」、「记下了」，也不要提「库」这个字。别人发表情时，你照平时的习惯回——想说话就说话，想甩个表情就发个表情，别为了「回应他发表情」硬塞。')

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

    log.info('表情脑已就绪（参数在本页，内置表情模块已停用）')

    return { refresh, find, status: statusRemote, addFromBuffer, rename }
  },
}
