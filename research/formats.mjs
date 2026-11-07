// 按魔数（而不是扩展名）统计表情库的真实格式与动图帧数
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.USERPROFILE, '.dsh', 'plugins-data', 'aurabot', 'stickers')
const lib = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return { fmt: 'jpeg' }
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('ascii') === 'PNG') {
    const apng = buf.includes(Buffer.from('acTL'))
    return { fmt: apng ? 'apng' : 'png' }
  }
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    // 数 Graphics Control Extension（0x21 0xF9）就是帧数
    let frames = 0
    for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9) frames++
    return { fmt: 'gif', frames }
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const vp8x = buf.subarray(12, 16).toString('ascii')
    const anim = buf.includes(Buffer.from('ANIM'))
    return { fmt: 'webp', anim, chunk: vp8x }
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { fmt: 'bmp' }
  return { fmt: 'other:' + buf.subarray(0, 8).toString('hex') }
}

const stats = {}
const rows = []
for (const it of lib.items) {
  let buf
  try {
    buf = readFileSync(join(dir, it.file))
  } catch { continue }
  const s = sniff(buf)
  const ext = (it.file.match(/\.([a-z0-9]+)$/i) || [, '?'])[1].toLowerCase()
  const key = s.fmt === 'gif' ? (s.frames > 1 ? 'gif(动图)' : 'gif(单帧)') : s.fmt === 'webp' ? (s.anim ? 'webp(动图)' : 'webp(静态)') : s.fmt
  stats[key] = (stats[key] || 0) + 1
  rows.push({ ...s, key, ext, name: it.name || '(无名)', bytes: it.bytes })
}

console.log('=== 真实格式分布（按魔数）===')
Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`))

const mislabeled = rows.filter((r) => (r.key.startsWith('jpeg') && r.ext !== 'jpg' && r.ext !== 'jpeg') ||
  (r.key.startsWith('png') && r.ext !== 'png') || (r.key.startsWith('gif') && r.ext !== 'gif') || (r.key.startsWith('webp') && r.ext !== 'webp'))
console.log(`\n=== 扩展名与真实格式不符：${mislabeled.length} 张 ===`)
mislabeled.slice(0, 12).forEach((r) => console.log(`  .${r.ext} → 实际 ${r.key}   ${r.name}`))

const gifs = rows.filter((r) => r.key === 'gif(动图)')
if (gifs.length) {
  const fs2 = gifs.map((r) => r.frames)
  fs2.sort((a, b) => a - b)
  console.log(`\n=== 动图帧数 ===`)
  console.log(`  共 ${gifs.length} 张动图，帧数 最少 ${fs2[0]} / 中位 ${fs2[Math.floor(fs2.length / 2)]} / 最多 ${fs2[fs2.length - 1]}`)
  console.log(`  体积最大 ${Math.round(Math.max(...gifs.map((r) => r.bytes)) / 1024)}KB`)
}
