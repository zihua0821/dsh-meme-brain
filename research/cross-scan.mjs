// 跨库判重：Aurabot 的 140 张 vs dsh-meme 的 24 张
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { parseGIF, decompressFrames } from 'gifuct-js'

const AUR = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const DSH = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-meme', 'memes', 'dafeiyu-001', 'memes')

function decode(buf, file) {
  if (/\.png$/i.test(file)) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data } }
  if (/\.gif$/i.test(file)) {
    const f = decompressFrames(parseGIF(buf), true)[0]
    if (!f) throw new Error('空gif')
    const { width: w, height: h } = f.dims
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < f.patch.length / 4; i++) { const s = i * 4; data[s] = f.patch[s]; data[s+1] = f.patch[s+1]; data[s+2] = f.patch[s+2]; data[s+3] = f.patch[s+3] }
    return { width: w, height: h, data }
  }
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: img.data }
}
function graySmall(img, cols, rows) {
  const out = [], cw = img.width / cols, ch = img.height / rows
  for (let y = 0; y < rows; y++) {
    const line = []
    for (let x = 0; x < cols; x++) {
      const x0 = Math.floor(x*cw), x1 = Math.max(x0+1, Math.floor((x+1)*cw))
      const y0 = Math.floor(y*ch), y1 = Math.max(y0+1, Math.floor((y+1)*ch))
      let s = 0, n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) {
        const i = (yy*img.width+xx)*4
        s += 0.299*img.data[i] + 0.587*img.data[i+1] + 0.114*img.data[i+2]; n++
      }
      line.push(n ? s/n : 0)
    }
    out.push(line)
  }
  return out
}
const dhash = (g) => { const b = []; for (let y=0;y<8;y++) for (let x=0;x<8;x++) b.push(g[y][x] > g[y][x+1] ? 1 : 0); return b }
const dist = (a,b) => a.reduce((n,v,i)=> n + (v===b[i]?0:1), 0)

const rows = []
for (const it of JSON.parse(readFileSync(join(AUR, 'index.json'), 'utf8')).items) {
  try {
    const img = decode(readFileSync(join(AUR, it.file)), it.file)
    rows.push({ src: 'aurabot', name: it.name || '(无名)', md5: it.md5, bits: dhash(graySmall(img, 9, 8)) })
  } catch {}
}
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
for (const f of walk(DSH)) {
  try {
    const img = decode(readFileSync(f), f)
    rows.push({ src: 'dsh-meme', name: basename(f), md5: '', bits: dhash(graySmall(img, 9, 8)) })
  } catch {}
}
const a = rows.filter((r) => r.src === 'aurabot'), d = rows.filter((r) => r.src === 'dsh-meme')
console.log(`aurabot ${a.length} 张 / dsh-meme ${d.length} 张\n`)

const cross = []
for (const x of a) for (const y of d) { const dd = dist(x.bits, y.bits); if (dd <= 8) cross.push({ dd, x, y }) }
cross.sort((p, q) => p.dd - q.dd)
console.log(`=== 跨库疑似重复：${cross.length} 对 ===`)
for (const c of cross) console.log(`  d=${String(c.dd).padStart(2)}  ${c.x.name}  ↔  ${c.y.name}`)
