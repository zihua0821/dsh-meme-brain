// 索引层：SQLite（node:sqlite 内置，无第三方依赖）
//
// 约定：
//   - 任何结构变化都必须新增一条 migration，并递增 schema_version；
//   - 迁移前自动备份由调用方（commands）负责；
//   - 这里只做读写，不做业务判断。

import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 当前代码期望的 schema 版本 */
export const SCHEMA_VERSION = 3

const MIGRATIONS = [
  // v1：初始结构
  (db) => {
    db.exec(`
      CREATE TABLE items (
        md5         TEXT PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        ext         TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        width       INTEGER,
        height      INTEGER,
        frames      INTEGER NOT NULL DEFAULT 1,
        has_alpha   INTEGER NOT NULL DEFAULT 0,
        dhash       TEXT NOT NULL,
        name        TEXT,
        tags        TEXT,
        state       TEXT NOT NULL,
        text        TEXT,
        character   TEXT,
        char_conf   TEXT,
        score       TEXT,
        scene       TEXT,
        analyzed_at REAL,
        model       TEXT,
        source      TEXT,
        dup_of      TEXT,
        dup_distance INTEGER,
        pinned      INTEGER NOT NULL DEFAULT 0,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
      );
      CREATE INDEX idx_items_state ON items(state);
      CREATE INDEX idx_items_char  ON items(character);
      CREATE INDEX idx_items_dup   ON items(dup_of);

      CREATE TABLE events (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     REAL NOT NULL,
        md5    TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        actor  TEXT
      );
      CREATE INDEX idx_events_at ON events(at);
    `)
  },
  // v2：补上「指向」列（M5 才发现它只被解析、没被保存）
  (db) => {
    db.exec('ALTER TABLE items ADD COLUMN target TEXT')
  },
  // v3：外观描述（M6 之前需要它来做角色聚类）
  (db) => {
    db.exec('ALTER TABLE items ADD COLUMN appearance TEXT')
  },
]

/** 打开（必要时创建）索引并迁移到最新版本 */
export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  migrate(db)
  return db
}

export function currentVersion(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  return row ? Number(row.value) : 0
}

function migrate(db) {
  let v = currentVersion(db)
  if (v >= MIGRATIONS.length) return v
  for (let i = v; i < MIGRATIONS.length; i++) MIGRATIONS[i](db)
  v = MIGRATIONS.length
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(v))
  return v
}

const now = () => Date.now()

/** 插入一条记录（已存在则忽略，返回 false） */
export function insertItem(db, item) {
  const t = now()
  const res = db.prepare(`
    INSERT INTO items (md5, path, ext, bytes, width, height, frames, has_alpha, dhash,
                       name, tags, state, text, character, char_conf, score, scene,
                       analyzed_at, model, source, dup_of, dup_distance, pinned, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(md5) DO NOTHING
  `).run(
    item.md5, item.path, item.ext, item.bytes, item.width ?? null, item.height ?? null,
    item.frames ?? 1, item.hasAlpha ? 1 : 0, item.dhash,
    item.name ?? null, item.tags ?? null, item.state ?? 'stored',
    item.text ?? null, item.character ?? null, item.charConf ?? null,
    item.score ?? null, item.scene ?? null,
    item.analyzedAt ?? null, item.model ?? null, item.source ?? null,
    item.dupOf ?? null, item.dupDistance ?? null, item.pinned ? 1 : 0, t, t,
  )
  return Number(res.changes) > 0
}

export function getItem(db, md5) {
  return db.prepare('SELECT * FROM items WHERE md5 = ?').get(md5) || null
}

export function getByPath(db, path) {
  return db.prepare('SELECT * FROM items WHERE path = ?').get(path) || null
}

export function allItems(db) {
  return db.prepare('SELECT * FROM items').all()
}

/** 判重只需要 md5 + dhash */
export function allHashes(db) {
  return db.prepare('SELECT md5, dhash, path FROM items').all()
}

export function updateItem(db, md5, patch) {
  const keys = Object.keys(patch)
  if (!keys.length) return false
  const sets = keys.map((k) => `${toColumn(k)} = ?`).join(', ')
  const vals = keys.map((k) => normalize(patch[k]))
  const res = db.prepare(`UPDATE items SET ${sets}, updated_at = ? WHERE md5 = ?`).run(...vals, now(), md5)
  return Number(res.changes) > 0
}

function toColumn(key) {
  const map = {
    hasAlpha: 'has_alpha', charConf: 'char_conf', analyzedAt: 'analyzed_at',
    dupOf: 'dup_of', dupDistance: 'dup_distance',
  }
  return map[key] || key
}

function normalize(v) {
  if (v === true) return 1
  if (v === false) return 0
  return v ?? null
}

export function deleteItem(db, md5) {
  const res = db.prepare('DELETE FROM items WHERE md5 = ?').run(md5)
  return Number(res.changes) > 0
}

export function counts(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM items').get()
  return { total: Number(row?.n || 0) }
}

export function countByState(db) {
  const rows = db.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all()
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]))
}

export function addEvent(db, { md5 = null, action, detail = null, actor = 'system' }) {
  db.prepare('INSERT INTO events(at, md5, action, detail, actor) VALUES(?,?,?,?,?)')
    .run(now(), md5, action, detail, actor)
}

export function recentEvents(db, limit = 20) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
}

/**
 * 条件查询（列表用）。
 * @param {object} index
 * @param {{state?:string, q?:string, sort?:string, limit?:number, offset?:number}} opts
 */
export function queryItems(index, opts = {}) {
  const where = []
  const params = []
  if (opts.state) {
    where.push('state = ?')
    params.push(opts.state)
  }
  if (opts.q) {
    where.push('(name LIKE ? OR tags LIKE ? OR md5 LIKE ? OR appearance LIKE ?)')
    const like = `%${opts.q}%`
    params.push(like, like, like, like)
  }
  if (opts.appearance) {
    where.push('appearance LIKE ?')
    params.push(`%${opts.appearance}%`)
  }
  if (opts.character) {
    where.push('character = ?')
    params.push(opts.character)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order =
    opts.sort === 'size' ? 'bytes DESC'
      : opts.sort === 'name' ? 'COALESCE(name, md5) ASC'
        : opts.sort === 'oldest' ? 'created_at ASC'
          : 'created_at DESC'
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 10))
  const offset = Math.max(0, Number(opts.offset) || 0)

  const total = Number(index.prepare(`SELECT COUNT(*) AS n FROM items ${w}`).get(...params)?.n || 0)
  const rows = index.prepare(`SELECT * FROM items ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset)
  return { total, rows }
}

/** 按完整 md5 或前缀查找；前缀命中多条时返回第一条并标记歧义 */
export function findByPrefix(index, prefix) {
  const p = String(prefix || '').trim().toLowerCase()
  if (!p) return { row: null, ambiguous: false }
  if (p.length === 32) return { row: index.prepare('SELECT * FROM items WHERE md5 = ?').get(p) || null, ambiguous: false }
  const rows = index.prepare('SELECT * FROM items WHERE md5 LIKE ? LIMIT 5').all(`${p}%`)
  return { row: rows[0] || null, ambiguous: rows.length > 1 }
}

/** 统计：总量、各状态、未分析数量 */
export function summary(index) {
  const total = Number(index.prepare('SELECT COUNT(*) AS n FROM items').get()?.n || 0)
  const states = Object.fromEntries(
    index.prepare('SELECT state, COUNT(*) AS n FROM items GROUP BY state').all().map((r) => [r.state, Number(r.n)]),
  )
  const unanalyzed = Number(index.prepare('SELECT COUNT(*) AS n FROM items WHERE analyzed_at IS NULL').get()?.n || 0)
  return { total, states, unanalyzed }
}
