// 直观演示 dHash 是怎么把人眼看到的"一样"变成 64 个 0/1 的
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import jpeg from 'jpeg-js'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const FILES = {
  A: ['manual-a7523e8e1130a11807e2c2668e60f18d.jpg', '摆烂摊手的厚脸皮（第一次收录）'],
  B: ['manual-8e237dc0ecb0d561b05f9cd5c0e7746b.jpg', '摆烂式厚脸皮（第二次收录）'],
  C: ['manual-9ab36afc51a1a8dbe36b661882d478dd.jpg', '对照组：另一张表情'],
}

function decode(buf) {
  const img = jpeg.decode(buf, { useTArray: true })
  return { width: img.width, height: img.height, data: img.data }
}

/** 盒式平均缩到 cols×rows 的灰度，这就是"把图压小到只剩轮廓" */
function graySmall(img, cols, rows) {
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
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
          n++
        }
      }
      line.push(n ? sum / n : 0)
    }
    out.push(line)
  }
  return out
}

const RAMP = ' .:-=+*#%@'
const art = (g) => g.map((row) => row.map((v) => RAMP[Math.min(9, Math.floor((v / 256) * 10))].repeat(2)).join('')).join('\n')

function dhashOf(g) {
  const bits = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g[y][x] > g[y][x + 1] ? 1 : 0)
  return bits
}
const hex = (bits) => {
  let s = ''
  for (let i = 0; i < bits.length; i += 4) s += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  return s
}
const dist = (a, b) => a.reduce((n, v, i) => n + (v === b[i] ? 0 : 1), 0)

const res = {}
for (const [k, [f, label]] of Object.entries(FILES)) {
  const img = decode(readFileSync(join(dir, f)))
  const g = graySmall(img, 9, 8)
  const bits = dhashOf(g)
  res[k] = { bits, label }
  console.log(`\n${'='.repeat(72)}`)
  console.log(`${k}  ${label}   原图 ${img.width}x${img.height}`)
  console.log('='.repeat(72))
  console.log(`第 1 步：压成 9×8 的灰度格（只剩明暗，颜色和细节全扔了）\n`)
  console.log(art(g))
  console.log(`\n第 2 步：每一行从左往右比大小 —— 左边比右边亮记 1，否则记 0`)
  console.log(`  第 1 行：${g[0].map((v) => v.toFixed(0).padStart(3)).join('')}`)
  console.log(`          ${g[0].slice(0, 8).map((v, i) => `${v > g[0][i + 1] ? '1' : '0'} `).join('')}   ← 8 个比特`)
  console.log(`第 3 步：8 行拼起来 = 64 位\n`)
  for (let y = 0; y < 8; y++) console.log(`  ${bits.slice(y * 8, y * 8 + 8).join(' ')}`)
  console.log(`\n  指纹（十六进制）：${hex(bits)}`)
}

console.log(`\n${'='.repeat(72)}`)
console.log('对比')
console.log('='.repeat(72))
console.log(`A（第一次收录）  ${hex(res.A.bits)}`)
console.log(`B（第二次收录）  ${hex(res.B.bits)}`)
console.log(`C（另一张表情）  ${hex(res.C.bits)}`)
console.log('')
console.log(`A ↔ B  不同的位：${dist(res.A.bits, res.B.bits)} / 64   → 同一张图`)
console.log(`A ↔ C  不同的位：${dist(res.A.bits, res.C.bits)} / 64   → 完全不同的图`)
