// 检查透明底对 dHash 的影响：GIF 表情大量带透明通道
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGIF, decompressFrames } from 'gifuct-js'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const lib = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

function framesOf(file) {
  const buf = readFileSync(join(dir, file))
  if (buf.subarray(0, 4).toString('ascii') !== 'GIF8') return null
  const fr = decompressFrames(parseGIF(buf), true)
  if (!fr.length) return null
  const f = fr[0]
  const { width: w, height: h } = f.dims
  // patch 可能不是整幅，按左上角贴到画布
  const data = new Uint8Array(w * h * 4)
  const pw = f.dims.width
  const ph = f.dims.height
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const si = (y * pw + x) * 4
      const di = (y * w + x) * 4
      data[di] = f.patch[si]
      data[di + 1] = f.patch[si + 1]
      data[di + 2] = f.patch[si + 2]
      data[di + 3] = f.patch[si + 3]
    }
  }
  return { width: w, height: h, data }
}

function graySmall(img, cols, rows, whiteBg) {
  const out = []
  const cw = img.width / cols
  const ch = img.height / rows
  for (let y = 0; y < rows; y++) {
    const line = []
    for (let x = 0; x < cols; x++) {
      const x0 = Math.floor(x * cw)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * cw))
      const y0 = Math.floor(y * ch)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ch))
      let s = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4
          let r = img.data[i]
          let g = img.data[i + 1]
          let b = img.data[i + 2]
          const a = img.data[i + 3] / 255
          if (whiteBg) {
            // 合成到白底：半透明按 alpha 混合，全透明直接取白
            r = r * a + 255 * (1 - a)
            g = g * a + 255 * (1 - a)
            b = b * a + 255 * (1 - a)
          }
          s += 0.299 * r + 0.587 * g + 0.114 * b
          n++
        }
      }
      line.push(n ? s / n : 0)
    }
    out.push(line)
  }
  return out
}

const dhash = (g) => {
  const bits = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y][x] > g[y][x + 1] ? 1 : 0)
  return bits
}
const dist = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

let checked = 0
let transparent = 0
const diffs = []
for (const it of lib.items) {
  let img
  try { img = framesOf(it.file) } catch { continue }
  if (!img) continue
  checked++
  let lowAlpha = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 128) lowAlpha++
  const ratio = lowAlpha / (img.width * img.height)
  if (ratio > 0.02) transparent++
  const plain = dhash(graySmall(img, 9, 8, false))
  const white = dhash(graySmall(img, 9, 8, true))
  const d = dist(plain, white)
  if (d > 0) diffs.push({ d, ratio: Math.round(ratio * 100), name: it.name || '(无名)' })
}
diffs.sort((a, b) => b.d - a.d)
console.log(`检查 GIF ${checked} 张`)
console.log(`明显带透明的（>2% 像素 alpha<128）：${transparent} 张，占 ${Math.round((transparent / checked) * 100)}%`)
console.log(`"忽略 alpha" 与 "合成白底" 两种算法结果不同的：${diffs.length} 张`)
console.log('\n差异最大的 10 张：')
diffs.slice(0, 10).forEach((x) => console.log(`  距离 ${String(x.d).padStart(2)}   透明占比 ${String(x.ratio).padStart(3)}%   ${x.name}`))
