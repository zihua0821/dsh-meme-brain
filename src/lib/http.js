// HTTP 层：界面与外部程序的唯一入口。
//
// 约束（ADR-0005 / G-2）：这里只做参数校验与转发，业务全部落在 lib/pipeline.js、lib/db.js、lib/query.js。

import { existsSync, readFileSync } from 'node:fs'

import { openDb, queryItems, findByPrefix, facets } from './db.js'
import { annotate } from './annotate.js'
import { runAnalyze } from './analyze.js'
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

const publicItem = (r) => ({
  md5: r.md5,
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
      return sendJson(res, 200, { ok: true, data: facets(db) })
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
        pin: body.pin,
      })
      if (!r.ok) {
        const status = r.code === 'E_NOT_FOUND' ? 404 : 400
        return sendJson(res, status, { ok: false, error: { code: r.code, message: r.message } })
      }
      const after = findByPrefix(db, r.md5).row
      return sendJson(res, 200, {
        ok: true,
        data: { ...detailItem(after), createdCharacter: r.createdCharacter, cleared: r.cleared },
      })
    }

    if (op === 'analyze') {
      return await analyzeOne(ctx, db, res, String(body.md5 || ''))
    }

    return sendJson(res, 400, { ok: false, error: { code: 'E_BAD_OP', message: `未知 op：${op}` } })
  } finally {
    db.close?.()
  }
}

// 正在分析的 md5：防止连点把同一张送去模型好几次（既费钱又互相覆盖结果）
const inFlight = new Set()

/**
 * 分析单张。业务全部在 lib/analyze.js，这里只负责：
 * 校验、串行化、把结果翻译成界面能读的形状。
 */
async function analyzeOne(ctx, db, res, prefix) {
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
    const result = await runAnalyze(ctx, db, { md5: row.md5, force: true, rename: false, includePinned: false })
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
