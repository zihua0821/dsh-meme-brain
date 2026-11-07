// AI 工具：让 DSH 里的 agent 能查表情库。
//
// 只做两件事：找图（meme_find）、看库况（meme_status）。
// 判断全部复用 lib/search.js —— 工具、命令、HTTP 三处必须是同一套口径，
// 否则「她找到的」和「你在界面上看到的」会不一致，那是这个项目最不能接受的失败。
//
// 工具只读，不改库：改库要么走命令（人工）、要么走 HTTP（界面）。

import { existsSync } from 'node:fs'

import { openDb, facets } from './db.js'
import { INDEX_DB } from './store.js'
import { search, EMOTION_WORDS } from './search.js'
import { formatSearch } from './query.js'

const textBlock = (text) => [{ type: 'text', text }]

function withIndex(fn) {
  if (!existsSync(INDEX_DB)) return null
  const db = openDb(INDEX_DB)
  try {
    return fn(db)
  } finally {
    db.close?.()
  }
}

const str = (description) => ({ type: 'string', description })

/** 把检索结果压成给模型看的文本 */
function describeFind(value) {
  if (!value.ok) return value.message
  return value.text
}

export const FIND_TOOL = {
  name: 'meme_find',
  description: [
    '在本机表情包库里找图。库里的每张图都被视觉模型标注过：角色、外观、图上文字、场景、指向，',
    '以及五维分数（情绪 -1~1、强度、攻击、亲密、抽象，都是 0~1）。',
    '用户说「来张生气的大肥鱼」「有没有写着无所谓的图」「找张摆烂的」时用它。',
    'query 可以直接写整句，比如「生气的大肥鱼」——会拆成情绪 + 关键词；也可以只给 character / emotion。',
    '找到后把名字和图上文字告诉用户；用户要发图时再走发表情的流程。找不到就明说没有，不要编。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      query: str('关键词，可以是名字/标签/图上文字/外观，也可以写整句如「生气的大肥鱼」'),
      character: str('只找某个角色的图，比如 大肥鱼 / doro / 龙图 / 耄耋'),
      emotion: str(`情绪词，比如 ${EMOTION_WORDS.slice(0, 8).join('、')}。不填就从 query 里认`),
      scene: str('场景，比如 吃饭 / 工作 / 游戏 / 摸鱼 / 睡觉 / 社交 / 日常'),
      limit: { type: 'integer', description: '要几张，默认 6，最多 20' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string', description: '给人看的结果摘要' },
        count: { type: 'integer' },
        items: { type: 'array', items: { type: 'object' } },
      },
    },
    render: (_args, value) => textBlock(describeFind(value)),
  },
  isConcurrencySafe: () => true,
  execute: (args = {}) => {
    const r = withIndex((db) => search(db, {
      keyword: args.query,
      character: args.character,
      emotion: args.emotion,
      scene: args.scene,
      limit: args.limit,
    }))
    if (!r) return { ok: false, text: '还没有索引：先用 /meme import 导入表情库。', count: 0, items: [] }
    return { ok: true, text: formatSearch(r), count: r.items.length, items: r.items }
  },
}

export const STATUS_TOOL = {
  name: 'meme_status',
  description: '看本机表情包库的现状：总量、各角色有多少张、还有多少没标角色/没标签。回答「库里有多少表情」这类问题前先看它。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
      },
    },
    render: (_args, value) => textBlock(value.text),
  },
  isConcurrencySafe: () => true,
  execute: () => {
    const f = withIndex((db) => facets(db))
    if (!f) return { ok: false, text: '还没有索引：先用 /meme import 导入表情库。' }
    const chars = f.characters.map((c) => `${c.name} ${c.count}`).join('、') || '（还没有角色）'
    return {
      ok: true,
      text: [
        `表情库共 ${f.total} 张。`,
        `角色：${chars}${f.unknownCharacter ? `、未知角色 ${f.unknownCharacter}` : ''}。`,
        `待办：未分析 ${f.todo.unanalyzed}、未命名 ${f.todo.unnamed}、无标签 ${f.todo.notags}。`,
      ].join('\n'),
    }
  },
}

/**
 * 注册工具。返回撤掉它们的函数。
 * 拿不到 tools 服务时安静返回空函数：插件其余部分照常工作。
 */
export function registerTools(ctx) {
  const tools = ctx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') return () => {}

  const offs = []
  for (const def of [FIND_TOOL, STATUS_TOOL]) {
    try {
      offs.push(tools.register(def))
    } catch (error) {
      ctx.logger?.('meme-brain')?.warn?.(`工具 ${def.name} 注册失败：${error.message}`)
    }
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        /* 已经撤掉了 */
      }
    }
  }
}
