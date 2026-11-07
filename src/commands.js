// 命令实现：只做参数解析与输出编排，业务逻辑在 lib/pipeline.js 与 lib/query.js。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { openDb, findByPrefix, deleteItem, addEvent } from './lib/db.js'
import { INDEX_DB, ROOT, LIBRARY, ensureDirs, moveToTrash } from './lib/store.js'
import { doctor } from './lib/doctor.js'
import { importDirectory, rebuild, repair, backfillMeta } from './lib/pipeline.js'
import { formatList, formatDetail, formatDupes, formatTodo, formatSearch } from './lib/query.js'
import { annotate } from './lib/annotate.js'
import { saveCharacter, removeCharacter } from './lib/charEdit.js'
import { search } from './lib/search.js'
import { runAnalyze } from './lib/analyze.js'
import * as characterTable from './lib/characters.js'

const HELP = [
  '表情包管理 · 可用子命令',
  '',
  '  /meme doctor                      体检（只读）',
  '  /meme list [选项]                 列出记录',
  '        --limit=10  --offset=0  --state=stored  --character=角色（未知写 __none__）',
  '        --todo=unanalyzed|unnamed|notags|nochar   按待办筛',
  '        --q=关键词（名字/标签/外观/md5）  --appearance=外观关键词  --sort=newest|size|name',
  '  /meme show <md5前缀>              查看单张全部信息',
  '  /meme find [--q=词] [--character=角色] [--emotion=情绪] [--scene=场景] [--limit=6]',
  '        按「人话」找图：情绪会转成五维分数排序，和 AI 工具用的是同一套判断',
  '  /meme dupes                       查看重复簇',
  '  /meme todo                        看待办（未分析 / 未命名 / 疑似重复）',
  '  /meme tag <md5前缀> [--name= --tags= --character= --appearance= --text= --scene= --target= --score= --unpin]',
  '        人工标注任何字段；改模型字段（角色/外观/文字/场景/指向/分数）会自动上锁',
  '  /meme rm <md5前缀> [--yes]       删除（文件移到 trash/，不加 --yes 只预览）',
  '  /meme analyze [--limit=10] [--force] [--rename] [--md5=前缀] [--batch=4]',
  '        [--appearance=关键词] [--name=关键词] [--include-pinned]',
  '        --force 重跑已分析的图（不动名字）；--rename 才允许改写名字',
  '        人工锁定的条目默认跳过；--include-pinned 才连它一起重跑',
  '  /meme char list                   看角色表（带每张用了几次）',
  '  /meme char add <名字> [--look=外观] [--from=出处] [--aka=别名1,别名2] [--kind=character|meme]',
  '  /meme char add <新名> --rename=<旧名>   改名（库里引用旧名的图一起改并锁定）',
  '  /meme char rm <名字> [--force]    删除（库里有图在用会拒绝，--force 一起清空）',
  '  /meme backfill <源目录> [--force]  从源库 index.json 回填名字与标签',
  '  /meme import <目录> [--dry-run]   导入目录（先判重再写入）',
  '                                    路径支持 ~ 与 %USERPROFILE% 展开',
  '  /meme rebuild                     从库文件重建索引（保留分析结果）',
  '  /meme repair [--orphans|--missing] 修复不一致',
  '  /meme help                        显示本帮助',
  '',
  '库位置：' + ROOT,
].join('\n')

const ok = (text) => ({ kind: 'success', text })
const fail = (text) => ({ kind: 'error', text })

/**
 * 解析 "import /path --dry-run --limit=5" 这类输入。
 * flags 是对象：`--dry-run` → true，`--limit=5` → '5'。
 */
export function parseArgs(rawInput) {
  const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
  const flags = {}
  const args = []
  for (const p of parts) {
    if (p.startsWith('--')) {
      const body = p.slice(2)
      const eq = body.indexOf('=')
      if (eq === -1) flags[body.toLowerCase()] = true
      else flags[body.slice(0, eq).toLowerCase()] = body.slice(eq + 1)
    } else {
      args.push(p)
    }
  }
  const sub = (args.shift() || '').toLowerCase()
  return { sub, args, flags }
}

/**
 * 展开路径：支持 ~、%NAME%、$env:NAME、${env:NAME}，并去掉包裹的引号。
 * 环境变量未定义时报错，避免静默拼出一个错误路径。
 */
export function expandPath(input) {
  let p = String(input || '').trim().replace(/^["']|["']$/g, '')
  if (!p) return p

  let missing = null
  const value = (name) => {
    const v = process.env[name]
    if (v === undefined) missing = name
    return v ?? ''
  }

  p = p
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => value(n))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => value(n))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, n) => value(n))

  if (missing) throw new Error(`环境变量 ${missing} 未定义`)

  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** 只在索引已存在时打开，避免只读命令顺带创建空库 */
function openExisting() {
  return existsSync(INDEX_DB) ? openDb(INDEX_DB) : null
}

function requireIndex() {
  const db = openExisting()
  if (!db) throw new Error('还没有索引，先运行 /meme import 或 /meme rebuild')
  return db
}

function withIndex(fn) {
  let db
  try {
    db = requireIndex()
    return fn(db)
  } finally {
    db?.close?.()
  }
}

function doctorText() {
  const db = openExisting()
  try {
    const { lines, ok: healthy } = doctor(db)
    return [...lines, '', healthy ? '✓ 体检通过' : '✗ 需要处理'].join('\n')
  } finally {
    db?.close?.()
  }
}

function fmtFailed(failed) {
  if (!failed.length) return ''
  const head = failed.slice(0, 5).map((f) => `  ${f.code}  ${f.file.split(/[\\/]/).pop()}  ${f.message.slice(0, 60)}`)
  const more = failed.length > 5 ? [`  … 另有 ${failed.length - 5} 个`] : []
  return ['', '失败明细：', ...head, ...more].join('\n')
}

function resolveDir(raw) {
  let dir
  try {
    dir = expandPath(raw)
  } catch (error) {
    throw new Error(error.message)
  }
  if (!existsSync(dir)) {
    throw new Error(
      `目录不存在：${dir}\n\n` +
        '提示：这里要填真实路径，不是 shell 命令。\n' +
        '可用 ~ 或 %USERPROFILE% 代替用户目录，例如：\n' +
        '  /meme import %USERPROFILE%\\.dsh\\plugins-data\\aurabot\\stickers',
    )
  }
  return dir
}

// ---------- 各子命令 ----------

async function cmdImport(raw, flags) {
  if (!raw) return fail('用法：/meme import <目录> [--dry-run]')
  let dir
  try {
    dir = resolveDir(raw)
  } catch (error) {
    return fail(error.message)
  }

  ensureDirs()
  const db = openDb(INDEX_DB)
  try {
    const dryRun = Boolean(flags['dry-run'])
    const r = await importDirectory(db, dir, { dryRun, source: 'import' })
    const head = dryRun
      ? `扫描 ${r.scanned} 张 · 将新增 ${r.added} 张 · 重复 ${r.duplicate} 张 · 失败 ${r.failed.length} 张（未写入任何文件）`
      : `扫描 ${r.scanned} 张 · 新增 ${r.added} 张 · 重复 ${r.duplicate} 张 · 失败 ${r.failed.length} 张`
    const tail = dryRun ? '' : `\n库位置：${LIBRARY}`
    return ok(head + fmtFailed(r.failed) + tail)
  } finally {
    db.close?.()
  }
}

async function cmdRebuild() {
  if (!existsSync(INDEX_DB)) ensureDirs()
  const db = openDb(INDEX_DB)
  try {
    const r = await rebuild(db)
    return ok(`重建完成：扫描 ${r.scanned} 个文件，写入 ${r.added} 条记录，失败 ${r.failed.length}` + fmtFailed(r.failed))
  } finally {
    db.close?.()
  }
}

async function cmdRepair(flags) {
  if (!existsSync(INDEX_DB)) return fail('还没有索引，先运行 /meme rebuild')
  const onlyOrphans = Boolean(flags.orphans) && !flags.missing
  const onlyMissing = Boolean(flags.missing) && !flags.orphans
  const db = openDb(INDEX_DB)
  try {
    const r = await repair(db, { orphans: onlyMissing ? false : true, missing: onlyOrphans ? false : true })
    return ok(`修复完成：补录孤儿 ${r.adopted} 个，清理失效记录 ${r.purged} 条` + fmtFailed(r.failed))
  } finally {
    db.close?.()
  }
}

/** 软删除：文件进 trash/，索引删掉。硬删不提供（数据要能找回） */
function cmdRm(args, flags) {
  const prefix = args[0]
  if (!prefix) return '用法：/meme rm <md5前缀> [--yes]（文件会移到 trash/，索引删掉；不加 --yes 只预览）'
  return withIndex((db) => {
    const { row, ambiguous } = findByPrefix(db, prefix)
    if (!row) return `没找到以 ${prefix} 开头的记录`
    const label = `${row.name || '（未命名）'}（${row.md5.slice(0, 8)}）`

    if (!flags.yes) {
      return ambiguous
        ? `前缀命中多条，按第一条预览（加 --yes 才真删）：\n  ${label}`
        : `将要删除：${label}\n文件会移到 trash/，可以从那里恢复。确认请加 --yes`
    }

    const moved = moveToTrash(row.path)
    deleteItem(db, row.md5)
    addEvent(db, { md5: row.md5, action: 'retire', detail: JSON.stringify({ path: row.path, moved }) })
    return `已删除：${label}${moved ? '\n文件已移到 trash/' : '\n（库文件本来就不在，只删了索引）'}`
  })
}

async function cmdBackfill(raw, flags) {
  if (!raw) return fail('用法：/meme backfill <源目录> [--force]')
  let dir
  try {
    dir = resolveDir(raw)
  } catch (error) {
    return fail(error.message)
  }
  const db = openDb(INDEX_DB)
  try {
    const r = await backfillMeta(db, dir, { force: Boolean(flags.force) })
    return ok(
      `源库 ${r.available} 条 · 匹配 ${r.matched} 条 · 更新 ${r.updated} 条` +
        (r.updated ? '' : '\n（名字都已有值；要强制覆盖加 --force）'),
    )
  } finally {
    db.close?.()
  }
}

function cmdList(flags) {
  return withIndex((db) =>
    formatList(db, {
      state: typeof flags.state === 'string' ? flags.state : undefined,
      q: typeof flags.q === 'string' ? flags.q : undefined,
      appearance: typeof flags.appearance === 'string' ? flags.appearance : undefined,
      character: typeof flags.character === 'string' ? flags.character : undefined,
      todo: typeof flags.todo === 'string' ? flags.todo : undefined,
      sort: typeof flags.sort === 'string' ? flags.sort : 'newest',
      limit: flags.limit,
      offset: flags.offset,
    }),
  )
}

/** 人工标注：界面能改的，命令必须也能改（G-1） */
function cmdTag(args, flags) {
  const md5 = args[0]
  if (!md5) {
    return fail([
      '用法：/meme tag <md5前缀> [选项]',
      '  --name=短名 --tags=甲,乙 --character=角色',
      '  --appearance=外观 --text=图上文字 --scene=吃饭,日常 --target=自己|对方|第三方|无',
      '  --score=valence:0.5,arousal:0.3   （只改给了的维度）',
      '  --unpin 解锁',
      '注：改角色/外观/文字/场景/指向/分数会自动上锁，挡住 analyze --force',
    ].join('\n'))
  }
  return withIndex((db) => {
    const r = annotate(db, {
      md5,
      name: typeof flags.name === 'string' ? flags.name : undefined,
      tags: typeof flags.tags === 'string' ? flags.tags : undefined,
      character: typeof flags.character === 'string' ? flags.character : undefined,
      appearance: typeof flags.appearance === 'string' ? flags.appearance : undefined,
      text: typeof flags.text === 'string' ? flags.text : undefined,
      scene: typeof flags.scene === 'string' ? flags.scene : undefined,
      target: typeof flags.target === 'string' ? flags.target : undefined,
      score: typeof flags.score === 'string' ? flags.score : undefined,
      pin: flags.unpin ? false : undefined,
    })
    if (!r.ok) return fail(r.message || r.code)
    const lines = [`已保存 ${r.md5.slice(0, 8)}（改了 ${(r.changed || []).join('、') || '锁定状态'}）`]
    if (r.createdCharacter) lines.push('（角色表里原来没有，已新建一条，出处记为 ui）')
    if (r.cleared) lines.push('（角色已清空，交还给模型，同时解锁）')
    return ok(lines.join('\n'))
  })
}

function cmdShow(raw) {
  if (!raw) return fail('用法：/meme show <md5前缀>')
  return withIndex((db) => {
    const { row, ambiguous } = findByPrefix(db, raw)
    if (!row) return `没有找到以 ${raw} 开头的记录。`
    const text = formatDetail(row)
    return ambiguous ? `（前缀命中多条，显示第一条）\n\n${text}` : text
  })
}

function cmdDupes() {
  return withIndex((db) => formatDupes(db))
}

/** 找人话找图：和 meme_find 工具共用 lib/search.js */
function cmdFind(args, flags) {
  const positional = (args || []).join(' ').trim()
  return withIndex((db) => formatSearch(search(db, {
    keyword: typeof flags.q === 'string' ? flags.q : (positional || undefined),
    character: typeof flags.character === 'string' ? flags.character : undefined,
    emotion: typeof flags.emotion === 'string' ? flags.emotion : undefined,
    scene: typeof flags.scene === 'string' ? flags.scene : undefined,
    limit: flags.limit,
  })))
}

function cmdTodo() {
  return withIndex((db) => formatTodo(db))
}

async function cmdAnalyze(ctx, flags) {
  if (!existsSync(INDEX_DB)) return fail('还没有索引，先运行 /meme import')
  if (!ctx?.llm || !ctx?.attachments) return fail('当前宿主没有 llm / attachments 服务，无法分析')
  const db = openDb(INDEX_DB)
  try {
    const r = await runAnalyze(ctx, db, {
      limit: flags.limit,
      force: Boolean(flags.force),
      rename: Boolean(flags.rename),
      includePinned: Boolean(flags['include-pinned']),
      md5: typeof flags.md5 === 'string' ? flags.md5 : undefined,
      batchSize: flags.batch,
      appearance: typeof flags.appearance === 'string' ? flags.appearance : undefined,
      name: typeof flags.name === 'string' ? flags.name : undefined,
    })
    const lines = [`分析完成：成功 ${r.ok} 张，失败 ${r.failed.length} 张，补了 ${r.named} 个名字`]
    if (r.skipped?.length) {
      lines.push('', `跳过 ${r.skipped.length} 张（人工锁定）：`)
      for (const s of r.skipped.slice(0, 5)) lines.push(`  ${s.md5.slice(0, 8)}  ${s.message}`)
    }
    if (r.failed.length) {
      lines.push('', '失败明细：')
      for (const f of r.failed.slice(0, 5)) lines.push(`  ${f.md5.slice(0, 8)}  ${f.message.slice(0, 70)}`)
      if (r.failed.length > 5) lines.push(`  … 另有 ${r.failed.length - 5} 张`)
    }
    return ok(lines.join('\n'))
  } finally {
    db.close?.()
  }
}

function cmdChar(args, flags) {
  const sub = (args[0] || 'list').toLowerCase()
  if (sub === 'list') {
    const rows = characterTable.list()
    if (!rows.length) return '角色表是空的。用 /meme char add <名字> --look=<外观特征> 添加。'
    const counts = new Map()
    try {
      withIndex((db) => {
        for (const r of db.prepare("SELECT character AS n, COUNT(*) AS c FROM items WHERE character IS NOT NULL AND character <> '' GROUP BY character").all()) {
          counts.set(r.n, Number(r.c))
        }
      })
    } catch {
      /* 没有索引就只列名字 */
    }
    const lines = [`角色表 ${rows.length} 条：`, '']
    for (const c of rows) {
      const used = counts.get(c.name) || 0
      lines.push(`  ${c.name}${c.kind === 'meme' ? '（梗模板）' : ''}  ${used ? `${used} 张` : '未使用'}`)
      if (c.look) lines.push(`      外观：${c.look}`)
      if (c.from) lines.push(`      出处：${c.from}`)
      if (c.aka?.length) lines.push(`      别名：${c.aka.join(' / ')}`)
    }
    return lines.join('\n')
  }

  if (sub === 'add' || sub === 'set') {
    const name = args[1]
    if (!name) return fail('用法：/meme char add <名字> [--look=外观] [--from=出处] [--aka=别名1,别名2] [--kind=character|meme]')
    return withIndex((db) => {
      const r = saveCharacter(db, {
        name,
        originalName: typeof flags.rename === 'string' ? flags.rename : undefined,
        look: typeof flags.look === 'string' ? flags.look : undefined,
        from: typeof flags.from === 'string' ? flags.from : undefined,
        aka: typeof flags.aka === 'string' ? flags.aka : undefined,
        kind: typeof flags.kind === 'string' ? flags.kind : undefined,
      })
      if (!r.ok) return fail(r.message || r.code)
      const total = characterTable.list().length
      const parts = [r.created ? `已新增：${r.name}` : `已保存：${r.name}`]
      if (r.renamedFrom) parts.push(`（由「${r.renamedFrom}」改名，库里 ${r.moved} 张跟着改并锁定）`)
      parts.push(`角色表现在 ${total} 条`)
      return parts.join('')
    })
  }

  if (sub === 'rm' || sub === 'remove') {
    const name = args[1]
    if (!name) return fail('用法：/meme char rm <名字> [--force]（库里还有图在用时会拒绝，--force 才一起清空）')
    return withIndex((db) => {
      const r = removeCharacter(db, name, { force: Boolean(flags.force) })
      if (!r.ok) return fail(r.message || r.code)
      return `已删除：${r.name}${r.cleared ? `（同时清空了 ${r.cleared} 张图的角色）` : ''}`
    })
  }

  return fail(`未知的 char 子命令：${sub}`)
}

/**
 * 命令入口
 * @param {string} rawInput 斜杠后的原始输入
 * @param {object} [ctx] 宿主上下文（analyze 需要 llm / attachments）
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
export async function run(rawInput, ctx) {
  const { sub, args, flags } = parseArgs(rawInput)
  try {
    switch (sub) {
      case '':
      case 'help':
        return ok(HELP)
      case 'doctor':
        return ok(doctorText())
      case 'list':
        return ok(cmdList(flags))
      case 'show':
        return ok(cmdShow(args[0]))
      case 'tag':
      case 'annotate':
        return cmdTag(args, flags)
      case 'rm':
      case 'delete':
        return ok(cmdRm(args, flags))
      case 'dupes':
        return ok(cmdDupes())
      case 'find':
      case 'search':
        return ok(cmdFind(args, flags))
      case 'todo':
        return ok(cmdTodo())
      case 'analyze':
        return await cmdAnalyze(ctx, flags)
      case 'char':
        return ok(cmdChar(args, flags))
      case 'backfill':
        return await cmdBackfill(args[0], flags)
      case 'import':
        return await cmdImport(args[0], flags)
      case 'rebuild':
        return await cmdRebuild()
      case 'repair':
        return await cmdRepair(flags)
      default:
        return fail(`未知子命令：${sub}\n\n${HELP}`)
    }
  } catch (error) {
    return sub === 'list' || sub === 'show' || sub === 'dupes' || sub === 'todo' || sub === 'find' || sub === 'search'
      ? fail(error.message)
      : fail(`执行失败：${error.message}`)
  }
}
