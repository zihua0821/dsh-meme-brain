// 按「外观描述」给表情聚类，供人工命名角色。
//
// 思路：中文按二元组切分，用 IDF 加权（"猫""卡通""模糊"这类高频词自动降权），
// 再做贪心聚类。输出按组大小排序，每组给代表性描述 + 样本名字。
//
// 用法：node scripts/cluster-appearance.mjs [阈值=0.5] [最少组员=3]

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const THRESHOLD = Number(process.argv[2] || 0.5)
const MIN_SIZE = Number(process.argv[3] || 3)

const db = new DatabaseSync(join(homedir(), '.dsh', 'meme-brain', 'index.db'), { readOnly: true })
const rows = db
  .prepare("SELECT md5, name, appearance FROM items WHERE appearance IS NOT NULL AND appearance <> ''")
  .all()
db.close()

const clean = (s) => String(s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')

/** 二元组集合 */
function bigrams(text) {
  const t = clean(text)
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  if (t.length === 1) set.add(t)
  return set
}

const docs = rows.map((r) => ({ ...r, grams: bigrams(r.appearance) }))

// 文档频率 → IDF
const df = new Map()
for (const d of docs) for (const g of d.grams) df.set(g, (df.get(g) || 0) + 1)
const N = docs.length
const idf = (g) => Math.log((N + 1) / ((df.get(g) || 0) + 0.5))
const weight = (d) => {
  let s = 0
  for (const g of d.grams) s += idf(g)
  return s
}
for (const d of docs) d.w = weight(d)

/**
 * IDF 加权相似度：取「Jaccard」与「包含度」的较大值。
 * 包含度 = 共享权重 / 较小一方的权重 —— 描述一长一短时更合理。
 */
function sim(a, b) {
  let inter = 0
  const small = a.grams.size <= b.grams.size ? a : b
  const large = small === a ? b : a
  for (const g of small.grams) if (large.grams.has(g)) inter += idf(g)
  const union = a.w + b.w - inter
  const jaccard = union > 0 ? inter / union : 0
  const smaller = Math.min(a.w, b.w)
  const contain = smaller > 0 ? inter / smaller : 0
  return Math.max(jaccard, contain)
}

// 贪心聚类：与簇内任一成员相似度 ≥ 阈值即并入
const assigned = new Set()
const clusters = []
for (let i = 0; i < docs.length; i++) {
  if (assigned.has(i)) continue
  const group = [i]
  assigned.add(i)
  for (let j = i + 1; j < docs.length; j++) {
    if (assigned.has(j)) continue
    if (group.some((k) => sim(docs[k], docs[j]) >= THRESHOLD)) {
      group.push(j)
      assigned.add(j)
    }
  }
  clusters.push(group)
}

clusters.sort((a, b) => b.length - a.length)

// 每组挑一个「最具代表性」的描述：与该组其他成员平均相似度最高
function represent(group) {
  let best = group[0]
  let bestScore = -1
  for (const k of group) {
    if (group.length === 1) return docs[k]
    let s = 0
    for (const o of group) if (o !== k) s += sim(docs[k], docs[o])
    if (s > bestScore) {
      bestScore = s
      best = k
    }
  }
  return docs[best]
}

const big = clusters.filter((c) => c.length >= MIN_SIZE)
const singles = clusters.filter((c) => c.length < MIN_SIZE)

console.log(`共 ${docs.length} 条外观描述，阈值 ${THRESHOLD}，最少组员 ${MIN_SIZE}`)
console.log(`分成 ${clusters.length} 组：${big.length} 组 ≥${MIN_SIZE} 张，其余 ${singles.length} 组较小\n`)

big.forEach((group, idx) => {
  const rep = represent(group)
  const names = group.map((k) => docs[k].name).filter(Boolean)
  console.log(`组 ${String(idx + 1).padStart(2)}　${group.length} 张`)
  console.log(`  代表外观  ${rep.appearance}`)
  console.log(`  样本名字  ${names.slice(0, 6).join(' / ')}${names.length > 6 ? ` …(+${names.length - 6})` : ''}`)
  // 组内高频词，帮助判断这组是什么
  const freq = new Map()
  for (const k of group) for (const g of docs[k].grams) freq.set(g, (freq.get(g) || 0) + 1)
  const top = [...freq.entries()]
    .filter(([g, n]) => n >= Math.max(2, Math.ceil(group.length * 0.6)) && idf(g) > 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([g]) => g)
  if (top.length) console.log(`  高频特征  ${top.join(' ')}`)
  console.log('')
})

if (singles.length) {
  console.log(`另有 ${singles.length} 组小簇（<${MIN_SIZE} 张），多为独有画面：`)
  for (const group of singles.slice(0, 12)) {
    const d = docs[group[0]]
    console.log(`  ${group.length} 张　${d.appearance}　← ${d.name}`)
  }
  if (singles.length > 12) console.log(`  … 还有 ${singles.length - 12} 组`)
}
