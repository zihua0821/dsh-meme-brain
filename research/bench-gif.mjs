import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseGIF, decompressFrames } from "gifuct-js"
const dir = join(process.env.USERPROFILE, ".dsh", "plugins-data", "aurabot", "stickers")
const lib = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))
const gifs = []
for (const it of lib.items) {
  const buf = readFileSync(join(dir, it.file))
  if (buf.subarray(0, 4).toString("ascii") !== "GIF8") continue
  let frames = 0
  for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x21 && buf[i+1] === 0xf9) frames++
  gifs.push({ file: it.file, bytes: it.bytes, frames })
}
gifs.sort((a, b) => b.bytes - a.bytes)
console.log("最大的 5 张动图解码耗时：")
for (const g of gifs.slice(0, 5)) {
  const buf = readFileSync(join(dir, g.file))
  const t0 = Date.now()
  const fr = decompressFrames(parseGIF(buf), true)
  const ms = Date.now() - t0
  console.log(`  ${String(Math.round(g.bytes/1024)).padStart(5)}KB  ${String(g.frames).padStart(3)}帧  解码 ${String(ms).padStart(4)}ms  → 解出 ${fr.length} 帧`)
}
