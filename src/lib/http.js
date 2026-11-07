// HTTP 层：界面与外部程序的唯一入口。
//
// 约束（ADR-0005 / G-2）：这里只做参数校验与转发，业务全部落在 lib/pipeline.js、lib/db.js、lib/query.js。

import { existsSync, readFileSync } from 'node:fs'

import { openDb, queryItems, findByPrefix, facets } from './db.js'
import { annotate } from './annotate.js'
import { runAnalyze } from './analyze.js'
import { search } from './search.js'
import { ingestBuffer } from './pipeline.js'
import * as characterTable from './characters.js'
import { saveCharacter, removeCharacter } from './charEdit.js'
import { judgeBuffer } from './judge.js'
import { INDEX_DB, absPath } from './store.js'

const ROUTE = '/meme-brain/api'

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

function isLoopback(req) {
  const a = String(req.socket?.remoteAddress || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** 读原始字节（补录上传图片用；base64 会让 16MB 的图变成 22MB，没必要） */
function readRaw(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${Math.round(limit / 1048576)}MB）`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const publicItem = (r) => ({
  md5: r.md5,
  // path 给外部程序用（QQ 模块要拿它读文件发图）；相对库根，不泄绝对路径
  path: r.path,
  name: r.name || '',
  tags: r.tags || '',
  state: r.state,
  bytes: r.bytes,
  width: r.width,
  height: r.height,
  frames: r.frames,
  ext: r.ext,
  character: r.character || '',
  analyzed: Boolean(r.analyzed_at),
  url: `${ROUTE}?op=image&md5=${r.md5}`,
})

/** score 列存的是 JSON 字符串；解析失败一律当作「没有分数」，不抛错 */
export function parseScore(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * 详情视图：列表字段 + 全部分析结果。
 * 界面上「看到详细分析」全靠这里把列名翻成界面字段；界面自己不拼业务字段。
 */
export function detailItem(r) {
  return {
    ...publicItem(r),
    charConf: r.char_conf || '',
    appearance: r.appearance || '',
    text: r.text || '',
    target: r.target || '',
    scene: r.scene || '',
    score: parseScore(r.score),
    analyzedAt: r.analyzed_at || null,
    model: r.model || '',
    dhash: r.dhash || '',
    hasAlpha: Boolean(r.has_alpha),
    pinned: Boolean(r.pinned),
    source: r.source || '',
    path: r.path,
    dupOf: r.dup_of || '',
    dupDistance: r.dup_distance ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 打开索引；不存在时返回 null（只读请求不应创建空库） */
function open(readOnly) {
  if (!existsSync(INDEX_DB)) return null
  return openDb(INDEX_DB)
}

function handleGet(url, res) {
  const op = url.searchParams.get('op') || 'list'

  if (op === 'image') {
    const md5 = String(url.searchParams.get('md5') || '')
    const db = open()
    if (!db) return sendJson(res, 404, { ok: false, error: { code: 'E_NO_INDEX' } })
    try {
      const { row } = findByPrefix(db, md5)
      if (!row) return sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND' } })
      const abs = absPath(row.path)
      if (!existsSync(abs)) return sendJson(res, 404, { ok: false, error: { code: 'E_FILE_MISSING' } })
      const buf = readFileSync(abs)
      res.writeHead(200, {
        'Content-Type': MIME[row.ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
      })
      res.end(buf)
      return undefined
    } finally {
      db.close?.()
    }
  }

  const db = open()
  try {
    if (!db) {
      return sendJson(res, 200, { ok: true, data: { total: 0, items: [], indexed: false } })
    }

    if (op === 'list') {
      const { total, rows } = queryItems(db, {
        q: url.searchParams.get('q') || undefined,
        state: url.searchParams.get('state') || undefined,
        character: url.searchParams.get('character') || undefined,
        todo: url.searchParams.get('todo') || undefined,
        sort: url.searchParams.get('sort') || 'newest',
        limit: url.searchParams.get('limit') || 60,
        offset: url.searchParams.get('offset') || 0,
      })
      return sendJson(res, 200, { ok: true, data: { total, items: rows.map(publicItem), indexed: true } })
    }

    if (op === 'facets') {
      const f = facets(db)
      // 角色候选要含**角色表全量**：库里还没用到的（count=0）也带上，
      // 否则界面的角色下拉只显示「已经标过图」的那几个，新加的角色永远不出现。
      // 顺序：用过的按张数降序，没用到的按名字排后面。
      const used = new Map(f.characters.map((c) => [c.name, c.count]))
      const merged = characterTable.list()
        .map((c) => ({ name: c.name, count: used.get(c.name) || 0 }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'))
      // 兜底：库里出现过、但表里没有的名字也要保留（历史脏数据不能让筛选消失）
      for (const c of f.characters) {
        if (!merged.some((m) => m.name === c.name)) merged.push(c)
      }
      return sendJson(res, 200, { ok: true, data: { ...f, characters: merged } })
    }

    // 角色表：表里的条目 + 每张在库里占多少（界面用来看「有哪些人、各多少张」）
    if (op === 'chars') {
      const counts = new Map(facets(db).characters.map((c) => [c.name, c.count]))
      const items = characterTable.list().map((c) => ({
        name: c.name,
        kind: c.kind || 'character',
        look: c.look || '',
        from: c.from || '',
        aka: Array.isArray(c.aka) ? c.aka : [],
        count: counts.get(c.name) || 0,
      }))
      return sendJson(res, 200, {
        ok: true,
        data: { items, total: items.length, loadError: characterTable.lastLoadError },
      })
    }

    if (op === 'find') {
      const r = search(db, {
        keyword: url.searchParams.get('q') || undefined,
        character: url.searchParams.get('character') || undefined,
        emotion: url.searchParams.get('emotion') || undefined,
        scene: url.searchParams.get('scene') || undefined,
        limit: url.searchParams.get('limit') || undefined,
      })
      return sendJson(res, 200, { ok: true, data: r })
    }

    if (op === 'item') {
      const { row, ambiguous } = findByPrefix(db, url.searchParams.get('md5') || '')
      if (!row) return sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND' } })
      return sendJson(res, 200, { ok: true, data: { ...detailItem(row), ambiguous } })
    }

    return sendJson(res, 400, { ok: false, error: { code: 'E_BAD_OP', message: `未知 op：${op}` } })
  } finally {
    db?.close?.()
  }
}

async function handlePost(url, req, res, ctx) {
  const op = url.searchParams.get('op') || ''

  // op=add 收原始字节，其余收 JSON
  if (op === 'add') return addOne(url, req, res)
  // op=judge 也收原始字节：判「这张是不是表情包」，不写库
  if (op === 'judge') return judgeOne(ctx, req, res)

  const body = await readJson(req)
  const db = open()
  if (!db) return sendJson(res, 409, { ok: false, error: { code: 'E_NO_INDEX' } })

  try {
    if (op === 'annotate') {
      const r = annotate(db, {
        md5: String(body.md5 || ''),
        name: body.name,
        tags: body.tags,
        character: body.character,
        appearance: body.appearance,
        text: body.text,
        scene: body.scene,
        target: body.target,
        score: body.score,
        pin: body.pin,
      })
      if (!r.ok) {
        const status = r.code === 'E_NOT_FOUND' ? 404 : 400
        return sendJson(res, status, { ok: false, error: { code: r.code, message: r.message } })
      }
      const after = findByPrefix(db, r.md5).row
      return sendJson(res, 200, {
        ok: true,
        data: { ...detailItem(after), createdCharacter: r.createdCharacter, cleared: r.cleared, changed: r.changed },
      })
    }

    if (op === 'char-save') {
      const r = saveCharacter(db, {
        name: body.name,
        originalName: body.originalName,
        look: body.look,
        from: body.from,
        aka: body.aka,
        kind: body.kind,
      })
      if (!r.ok) return sendJson(res, r.code === 'E_NOT_FOUND' ? 404 : 400, { ok: false, error: { code: r.code, message: r.message } })
      return sendJson(res, 200, { ok: true, data: r })
    }

    if (op === 'char-rm') {
      const r = removeCharacter(db, body.name, { force: body.force === true })
      if (!r.ok) {
        const status = r.code === 'E_IN_USE' ? 409 : r.code === 'E_NOT_FOUND' ? 404 : 400
        return sendJson(res, status, { ok: false, error: { code: r.code, message: r.message, count: r.count } })
      }
      return sendJson(res, 200, { ok: true, data: r })
    }

    if (op === 'analyze') {
      return await analyzeOne(ctx, db, res, String(body.md5 || ''), { tagsOnly: body.tagsOnly === true })
    }

    return sendJson(res, 400, { ok: false, error: { code: 'E_BAD_OP', message: `未知 op：${op}` } })
  } finally {
    db.close?.()
  }
}

// 正在分析的 md5：防止连点把同一张送去模型好几次（既费钱又互相覆盖结果）
const inFlight = new Set()

/**
 * 判断一张图的字节是不是「表情包」（不写库）。
 *
 * 为什么不并进 op=add：判定要花一次模型调用，而大多数图（动图 / QQ 标记的表情段）
 * 根本不需要判。把它做成独立入口，模块只在「拿不准」的时候来问，钱花在刀刃上。
 */
async function judgeOne(ctx, req, res) {
  let buf
  try {
    buf = await readRaw(req)
  } catch (error) {
    return sendJson(res, 413, { ok: false, error: { code: 'E_TOO_LARGE', message: error.message } })
  }
  if (!buf || !buf.length) {
    return sendJson(res, 400, { ok: false, error: { code: 'E_EMPTY_BODY', message: '没有收到图片字节' } })
  }

  const r = await judgeBuffer(ctx, buf)
  if (!r.ok) {
    return sendJson(res, 503, { ok: false, error: { code: r.code, message: r.message } })
  }
  return sendJson(res, 200, {
    ok: true,
    data: { sticker: r.sticker, why: r.why, md5: r.md5, cached: Boolean(r.cached) },
  })
}

/**
 * 收一张图的字节并入库（QQ 补录用）。
 *
 * 判重规则在 lib/pipeline.js 的 ingestBuffer 里，和目录导入共用一份：
 * 这里绝不自己判断「像不像」。
 */
async function addOne(url, req, res) {
  let buf
  try {
    buf = await readRaw(req)
  } catch (error) {
    return sendJson(res, 413, { ok: false, error: { code: 'E_TOO_LARGE', message: error.message } })
  }
  if (!buf || !buf.length) {
    return sendJson(res, 400, { ok: false, error: { code: 'E_EMPTY_BODY', message: '没有收到图片字节' } })
  }

  const db = open()
  if (!db) {
    db?.close?.()
    return sendJson(res, 409, { ok: false, error: { code: 'E_NO_INDEX' } })
  }
  try {
    const source = url.searchParams.get('source') || 'qq'
    const r = await ingestBuffer(db, buf, { source })
    // added 时把刚入库的详情带回去，补录方可以直接拿去起名/打标签
    const item = r.status === 'added' ? findByPrefix(db, r.md5).row : null
    return sendJson(res, 200, {
      ok: true,
      data: {
        added: r.status === 'added',
        md5: r.md5,
        near: r.near || null,
        item: item ? detailItem(item) : null,
      },
    })
  } catch (error) {
    const code = error.code || 'E_PARSE'
    return sendJson(res, 400, { ok: false, error: { code, message: error.message } })
  } finally {
    db.close?.()
  }
}

/**
 * 分析单张。业务全部在 lib/analyze.js，这里只负责：
 * 校验、串行化、把结果翻译成界面能读的形状。
 */
async function analyzeOne(ctx, db, res, prefix, opts = {}) {
  const { row } = findByPrefix(db, prefix)
  if (!row) return sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND' } })

  if (!ctx?.llm || !ctx?.attachments) {
    return sendJson(res, 409, {
      ok: false,
      error: { code: 'E_NO_LLM', message: '当前宿主没有 llm / attachments 服务，无法分析' },
    })
  }

  if (inFlight.has(row.md5)) {
    return sendJson(res, 409, { ok: false, error: { code: 'E_BUSY', message: '这张正在分析中，等它跑完' } })
  }

  inFlight.add(row.md5)
  try {
    // force：按钮的语义就是「现在就（重新）分析这一张」
    const result = await runAnalyze(ctx, db, {
      md5: row.md5,
      force: true,
      rename: false,
      includePinned: false,
      // 只补标签：不动角色/名字/分数，锁定条目也允许补
      tagsOnly: opts.tagsOnly === true,
    })
    const after = findByPrefix(db, row.md5).row
    return sendJson(res, 200, {
      ok: true,
      data: {
        item: detailItem(after),
        result: { ok: result.ok, failed: result.failed, skipped: result.skipped },
      },
    })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: { code: 'E_ANALYZE', message: error.message } })
  } finally {
    inFlight.delete(row.md5)
  }
}

/**
 * 注册路由。调用方必须保证 webServer 服务存在。
 * @param {object} ctx 插件上下文（已 inject webServer）
 */
export function registerApi(ctx) {
  const webServer = ctx.webServer
  return ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: ROUTE,
      async handler(req, res) {
        if (!isLoopback(req)) {
          return sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN' } })
        }
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          if (req.method === 'POST') return await handlePost(url, req, res, ctx)
          return handleGet(url, res)
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: error.message } })
        }
      },
    }),
  )
}
