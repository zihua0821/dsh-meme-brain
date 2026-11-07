// 感知哈希：9×8 灰度 → 64 bit dHash
//
// 规则（见 docs/02-architecture.md §7.2）：
//   每行从左往右两两比较，左边更亮记 1，否则记 0；8 行共 64 bit。
//   三帧（首/中/末）各算一份，比较时取逐帧汉明距离。

export const COLS = 9
export const ROWS = 8
export const BITS = ROWS * (COLS - 1) // 64

/**
 * 从 9×8 灰度图计算 dHash 位。
 * @param {Uint8Array|Buffer} gray 长度必须是 COLS*ROWS
 * @returns {number[]} 64 个 0/1
 */
export function hashFromGray(gray) {
  if (!gray || gray.length !== COLS * ROWS) {
    throw new Error(`灰度数据长度应为 ${COLS * ROWS}，实际 ${gray?.length}`)
  }
  const bits = []
  for (let y = 0; y < ROWS; y++) {
    const base = y * COLS
    for (let x = 0; x < COLS - 1; x++) {
      bits.push(gray[base + x] > gray[base + x + 1] ? 1 : 0)
    }
  }
  return bits
}

/** 64 bit → 16 位十六进制 */
export function bitsToHex(bits) {
  let out = ''
  for (let i = 0; i < bits.length; i += 4) {
    out += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  }
  return out
}

/** 十六进制 → 位数（长度不符时抛错，避免静默算错） */
export function hexToBits(hex) {
  const h = String(hex || '').trim()
  if (!/^[0-9a-f]{16}$/i.test(h)) throw new Error(`非法哈希：${hex}`)
  const bits = []
  for (const ch of h) {
    const n = parseInt(ch, 16)
    bits.push((n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1)
  }
  return bits
}

/** 两个等长位串的汉明距离 */
export function hamming(a, b) {
  if (a.length !== b.length) throw new Error('位串长度不一致')
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

/**
 * 两组多帧哈希的逐帧距离。
 * 帧数不同时只比较公共部分（静态图会把同一帧采样三次，因此仍可比较）。
 * @param {string[]} ha 十六进制数组
 * @param {string[]} hb
 * @returns {{avg:number, max:number, pairs:number[]}}
 */
export function frameDistance(ha, hb) {
  const n = Math.min(ha.length, hb.length)
  if (n === 0) throw new Error('至少需要一帧哈希')
  const pairs = []
  for (let i = 0; i < n; i++) pairs.push(hamming(hexToBits(ha[i]), hexToBits(hb[i])))
  const sum = pairs.reduce((s, v) => s + v, 0)
  return { avg: sum / n, max: Math.max(...pairs), pairs }
}

/**
 * 是否判为重复。
 * 默认 avg ≤ 4 且 max ≤ 8（实测：真重复 0，库内最近非重复 11）。
 */
export function isDuplicate({ avg, max }, { thresholdAvg = 4, thresholdMax = 8 } = {}) {
  return avg <= thresholdAvg && max <= thresholdMax
}
