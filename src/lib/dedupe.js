// 判重：两两比较 + 聚类。
//
// 库规模 ≤ 1 万张时直接暴力比对（毫秒级）；更大规模再引入分桶，
// 见 docs/02-architecture.md §7.3。

import { frameDistance, isDuplicate } from './dhash.js'

/** 默认阈值（实测：真重复 0，库内最近非重复 11） */
export const DEFAULT_THRESHOLDS = { thresholdAvg: 4, thresholdMax: 8 }

/**
 * 比较两组哈希，返回距离与是否判重。
 * @param {string[]} a 十六进制哈希数组
 * @param {string[]} b
 */
export function compare(a, b, thresholds = {}) {
  const d = frameDistance(a, b)
  return { ...d, dup: isDuplicate(d, { ...DEFAULT_THRESHOLDS, ...thresholds }) }
}

/**
 * 在集合内找出重复簇。只做单链聚类：A 与 B 判重、B 与 C 判重时，三者同簇。
 * @param {Array<{md5:string, dhash:string[]}>} items
 * @param {object} thresholds
 * @returns {Array<{members:Array<object>, maxDistance:number}>}
 */
export function findClusters(items, thresholds = {}) {
  const opts = { ...DEFAULT_THRESHOLDS, ...thresholds }
  const list = Array.isArray(items) ? items : []
  const used = new Set()
  const clusters = []

  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue
    const group = [i]
    let worst = 0
    for (let j = i + 1; j < list.length; j++) {
      if (used.has(j)) continue
      const d = frameDistance(list[i].dhash, list[j].dhash)
      if (isDuplicate(d, opts)) {
        group.push(j)
        used.add(j)
        worst = Math.max(worst, d.max)
      }
    }
    if (group.length > 1) {
      used.add(i)
      clusters.push({ members: group.map((k) => list[k]), maxDistance: worst })
    }
  }

  return clusters
}

/**
 * 为一张新图在整个集合中找最相似的若干张（不判重，只排序）。
 * 用于"疑似重复"的灰区提示。
 */
export function nearest(items, dhash, limit = 5) {
  return (items || [])
    .map((it) => {
      const d = frameDistance(dhash, it.dhash)
      return { item: it, ...d }
    })
    .sort((x, y) => x.avg - y.avg || x.max - y.max)
    .slice(0, Math.max(1, limit))
}
