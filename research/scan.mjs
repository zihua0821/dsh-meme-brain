// 全库感知哈希扫描：找出「肉眼重复但 md5 不同」的表情
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { parseGIF, decompressFrames } from 'gifuct-js'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const lib = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

function decode(buf, file) {
  if (/\.png$/i.test(file)) {
    const p = PNG.sync.read(buf)
    return { width: p.width, height: p.height, data: p.data }
  }
  if (/\.gif$/i.test(file)) {
    const frames = decompressFrames(parseGIF(buf), true)
    const f = frames[0]
    if (!f) throw new Error('空 GIF')
    const { width: w, height: h } = f.dims
    // patch 是 RGBA，展开到整幅画布（左上角对齐，够算哈希了）
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < f.patch.length / 4; i++) {
      const px = i % w
      const py = Math.floor(i / w)
      const si = i * 4
      const di = (py * w + px) * 4
      data[di] = f.patch[si]
      data[di + 1] = f.patch[si + 1]
      data[di + 2] = f.patch[si + 2]
      data[di + 3] = f.patch[si + 3]
    }
    return { width: w, height: h, data }
  }
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: img.data }
}

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
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
          n++
        }
      }
      out[y * w + x] = n ? sum / n : 0
    }
  }
  return out
}

function dHash(img) {
  const g = graySmall(img, 9, 8)
  const bits = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0)
  return bits
}
const dist = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

const rows = []
let skipped = 0
for (const it of lib.items) {
  try {
    const img = decode(readFileSync(join(dir, it.file)), it.file)
    rows.push({ md5: it.md5, name: it.name || '(无名)', file: it.file, bytes: it.bytes, bits: dHash(img) })
  } catch (error) {
    skipped++
  }
}
console.log(`成功算哈希 ${rows.length} 张，跳过 ${skipped} 张\n`)

const TH = 8 // 汉明距离阈值
const seen = new Set()
const clusters = []
for (let i = 0; i < rows.length; i++) {
  if (seen.has(i)) continue
  const group = [i]
  for (let j = i + 1; j < rows.length; j++) {
    if (seen.has(j)) continue
    if (dist(rows[i].bits, rows[j].bits) <= TH) {
      group.push(j)
      seen.add(j)
    }
  }
  if (group.length > 1) {
    seen.add(i)
    clusters.push(group)
  }
}

console.log(`=== 距离 ≤ ${TH} 的重复簇：${clusters.length} 组 ===`)
for (const g of clusters) {
  const min = Math.min(...g.map((i) => rows[i].bytes))
  const max = Math.max(...g.map((i) => rows[i].bytes))
  console.log(`\n[${g.length} 张] 体积 ${min}~${max}B`)
  for (const i of g) {
    const r = rows[i]
    console.log(`   ${r.md5.slice(0, 8)}  ${String(Math.round(r.bytes / 1024)).padStart(5)}KB  ${r.name}`)
  }
}
