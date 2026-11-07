// 感知哈希可行性验证：同一张表情因重新编码导致 md5 不同，能否用 dHash/aHash 认出来
// 用法：node sticker-dedup-test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')

/** 解成 { width, height, data: RGBA } */
function decode(buf, file) {
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf)
    return { width: png.width, height: png.height, data: png.data }
  }
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: img.data }
}

/** 盒式平均降采样到 w×h 的灰度 */
function graySmall(img, w, h) {
  const out = new Float64Array(w * h)
  const cw = img.width / w
  const ch = img.height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * ch)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ch))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * cw)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * cw))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4
          // 亮度（BT.601），忽略 alpha
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
          n++
        }
      }
      out[y * w + x] = n ? sum / n : 0
    }
  }
  return out
}

/** 差值哈希：9×8 灰度，逐行比较相邻像素 → 64 bit */
function dHash(img) {
  const g = graySmall(img, 9, 8)
  const bits = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits.push(g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0)
  }
  return bits
}

/** 均值哈希：8×8 灰度，与均值比较 → 64 bit */
function aHash(img) {
  const g = graySmall(img, 8, 8)
  const mean = g.reduce((a, b) => a + b, 0) / g.length
  return [...g].map((v) => (v > mean ? 1 : 0))
}

const dist = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)
const hex = (bits) => bits.reduce((s, b, i) => (i % 4 === 0 ? s + parseInt(bits.slice(i, i + 4).join(''), 2).toString(16) : s), '')

const FILES = {
  A: 'manual-a7523e8e1130a11807e2c2668e60f18d.jpg', // 摆烂摊手的厚脸皮 6827B
  B: 'manual-8e237dc0ecb0d561b05f9cd5c0e7746b.jpg', // 摆烂式厚脸皮   6903B
  C: 'manual-ce400e6121539e1f719da2b46d3392e5.jpg', // 表情3 对照组
  D: 'manual-31a5717bdf9af1d79ef073c10fe1573b.jpg', // 表情2 对照组
  E: 'manual-9ab36afc51a1a8dbe36b661882d478dd.jpg', // 表情5 对照组
}

const hashes = {}
for (const [k, f] of Object.entries(FILES)) {
  try {
    const img = decode(readFileSync(join(dir, f)), f)
    const d = dHash(img)
    const a = aHash(img)
    hashes[k] = { d, a, size: `${img.width}x${img.height}` }
    console.log(`${k}  ${img.width}x${img.height}  dHash=${hex(d)}  aHash=${hex(a)}`)
  } catch (error) {
    console.log(`${k}  解码失败：${error.message}`)
  }
}

console.log('\n=== 两两距离（dHash / aHash，0 表示完全一样，64 是最大）===')
const keys = Object.keys(hashes)
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const x = keys[i]
    const y = keys[j]
    const dd = dist(hashes[x].d, hashes[y].d)
    const da = dist(hashes[x].a, hashes[y].a)
    const mark = dd <= 10 ? '  ← 疑似重复' : ''
    console.log(`  ${x} ↔ ${y}   d=${String(dd).padStart(2)}  a=${String(da).padStart(2)}   (${hashes[x].size} vs ${hashes[y].size})${mark}`)
  }
}
