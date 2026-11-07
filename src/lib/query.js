// 查询与展示：把索引里的记录变成人能读的文本。
// 只做读取与格式化，不修改任何数据。

import { queryItems, findByPrefix, summary, allItems } from './db.js'
import { findClusters } from './dedupe.js'

const kb = (n) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)
const when = (ts) => (ts ? new Date(ts).toISOString().slice(5, 16).replace('T', ' ') : '—')
const short = (md5) => String(md5).slice(0, 8)

/** 列表：一行一张 */
export function formatList(index, opts = {}) {
  const { total, rows } = queryItems(index, opts)
  if (!total) return '库里还没有匹配的记录。'

  const offset = Number(opts.offset) || 0
  const lines = [`共 ${total} 条，显示第 ${offset + 1}–${offset + rows.length} 条`, '']
  for (const r of rows) {
    const name = r.name || '（未命名）'
    const dims = r.width && r.height ? `${r.width}×${r.height}` : '—'
    const frames = r.frames > 1 ? `${r.frames}帧` : '静图'
    const marks = []
    if (r.pinned) marks.push('锁定')
    if (r.analyzed_at) marks.push('已分析')
    lines.push(`  ${short(r.md5)}  ${name}`)
    lines.push(`           ${kb(r.bytes)} · ${r.ext} · ${dims} · ${frames} · ${r.state}${marks.length ? ' · ' + marks.join('/') : ''}`)
  }
  if (total > offset + rows.length) {
    lines.push('', `还有 ${total - offset - rows.length} 条，用 --offset=${offset + rows.length} 继续`)
  }
  return lines.join('\n')
}

/** 单张：全部字段 */
export function formatDetail(row) {
  if (!row) return '没找到这条记录。'
  const dims = row.width && row.height ? `${row.width}×${row.height}` : '—'
  const lines = [
    `md5        ${row.md5}`,
    `名字       ${row.name || '（未命名）'}`,
    `标签       ${row.tags || '—'}`,
    `角色       ${row.character ? `${row.character}（把握 ${row.char_conf || '?'}）` : '未知'}`,
    `场景       ${row.scene || '—'}`,
    `指向       ${row.target || '—'}`,
    `外观       ${row.appearance || '—'}`,
    `图上文字   ${row.text || '—'}`,
    `文件       ${row.ext} · ${kb(row.bytes)} · ${dims} · ${row.frames} 帧${row.has_alpha ? ' · 带透明' : ''}`,
    `指纹       ${row.dhash}`,
    `状态       ${row.state}${row.pinned ? '（人工锁定）' : ''}`,
    `来源       ${row.source || '—'}`,
    `入库       ${when(row.created_at)}`,
    `分析       ${row.analyzed_at ? `${when(row.analyzed_at)} by ${row.model || '?'}` : '未分析'}`,
    `评分       ${row.score || '（未分析）'}`,
    `库内路径   ${row.path}`,
  ]
  if (row.dup_of) lines.push(`重复于     ${short(row.dup_of)}（距离 ${row.dup_distance ?? '?'}）`)
  return lines.join('\n')
}

/** 重复簇 */
export function formatDupes(index) {
  const rows = allItems(index)
  const clusters = findClusters(rows.map((r) => ({ md5: r.md5, dhash: String(r.dhash).split(',') })))
  if (!clusters.length) return `库内 ${rows.length} 张，未发现重复簇。`

  const byMd5 = new Map(rows.map((r) => [r.md5, r]))
  const lines = [`库内 ${rows.length} 张，发现 ${clusters.length} 组重复：`, '']
  clusters.forEach((c, i) => {
    lines.push(`组 ${i + 1}　最远距离 ${c.maxDistance}`)
    for (const m of c.members) {
      const r = byMd5.get(m.md5) || {}
      lines.push(`  ${short(m.md5)}  ${r.name || '（未命名）'}  ${kb(r.bytes || 0)}  ${r.path || ''}`)
    }
  })
  return lines.join('\n')
}

/** 待办：还没做的事 */
export function formatTodo(index) {
  const s = summary(index)
  const rows = allItems(index)
  const unnamed = rows.filter((r) => !r.name).length
  const noTags = rows.filter((r) => !r.tags).length
  const clusters = findClusters(rows.map((r) => ({ md5: r.md5, dhash: String(r.dhash).split(',') })))

  return [
    `总数         ${s.total}`,
    '',
    `未分析       ${s.unanalyzed}　（M5 会批量处理）`,
    `未命名       ${unnamed}　（导入时没带名字，可用 /meme backfill 回填）`,
    `无标签       ${noTags}`,
    `疑似重复     ${clusters.length} 组`,
    `解析失败     ${s.states.failed || 0}`,
    `已退役       ${s.states.retired || 0}`,
  ].join('\n')
}
