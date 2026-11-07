// 距离分布：确认阈值 8 有没有安全边际
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { parseGIF, decompressFrames } from 'gifuct-js'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const lib = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

function decode(buf, file) {
  if (/\.png$/i.test(file)) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data } }
  if (/\.gif$/i.test(file)) {
    const f = decompressFrames(parseGIF(buf), true)[0]
    const { width: w, height: h } = f.dims
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < f.patch.length / 4; i++) { const si = i * 4; const di = si; data[di] = f.patch[si]; data[di + 1] = f.patch[si + 1]; data[di + 2] = f.patch[si + 2]; data[di + 3] = f.patch[si + 3] }
    return { width: w, height: h, data }
  }
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: img.data }
}
function graySmall(img, w, h) {
  const out = new Float64Array(w * h)
  const cw = img.width / w, ch = img.height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * ch), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ch))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * cw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * cw))
      let s = 0, n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) { const i = (yy * img.width + xx) * 4; s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]; n++ }
      out[y * w + x] = n ? s / n : 0
    }
  }
  return out
}
function dHash(img) {
  const g = graySmall(img, 9, 8), bits = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0)
  return bits
}
const dist = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

const rows = lib.items.map((it) => {
  const img = decode(readFileSync(join(dir, it.file)), it.file)
  return { md5: it.md5, name: it.name || '(无名)', w: img.width, h: img.height, bytes: it.bytes, bits: dHash(img) }
})

const pairs = []
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) pairs.push({ d: dist(rows[i].bits, rows[j].bits), i, j })
pairs.sort((a, b) => a.d - b.d)

console.log(`共 ${pairs.length} 对，最像的 12 对：`)
for (const p of pairs.slice(0, 12)) {
  const a = rows[p.i], b = rows[p.j]
  console.log(`  d=${String(p.d).padStart(2)}  ${a.name}  ↔  ${b.name}   (${a.w}x${a.h} / ${b.w}x${b.h})`)
}
const hist = {}
for (const p of pairs) hist[p.d] = (hist[p.d] || 0) + 1
console.log('\n距离分布：')
Object.keys(hist).map(Number).sort((a, b) => a - b).slice(0, 14).forEach((k) => console.log(`  d=${String(k).padStart(2)}  ${hist[k]} 对`))
