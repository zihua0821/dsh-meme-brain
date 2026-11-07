// 极简 ZIP 读写（不引依赖）。
//
// 为什么自己写：项目只有 sharp 一个原生依赖，为了备份功能再装一个 zip 库不值。
// 只需要支持两种：**STORE（0）**和 **DEFLATE（8）**——
// 图片本身已经压过，用 STORE 即可；manifest 很小，用 DEFLATE 省不了多少，也一并用 STORE。
// 但**导入**要能读别人用 Windows/其他工具打的 deflate 包，所以读这边两种都支持。

import { closeSync, openSync, readSync, writeSync, fstatSync } from 'node:fs'
import { inflateRawSync, crc32 } from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

const DOS_TIME = 0
const DOS_DATE = 0x21 // 1980-01-01

/**
 * 写一个 zip。条目按顺序流式写入，不在内存里攒整包（库有 170MB）。
 *
 * @param {string} outPath
 * @param {Array<{name: string, data?: Buffer, file?: string}>} entries
 * @returns {{files: number, bytes: number}}
 */
export function writeZip(outPath, entries) {
  const fd = openSync(outPath, 'w')
  const central = []
  let offset = 0
  let written = 0

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8')
      // 先算大小和 CRC（本地头里必须先写 CRC，所以文件条目要过两遍）
      let size
      let crc
      if (entry.data) {
        size = entry.data.length
        crc = crc32(entry.data) >>> 0
      } else {
        const ffd = openSync(entry.file, 'r')
        try {
          const { size: total } = fstatSync(ffd)
          size = total
          const chunk = Buffer.allocUnsafe(1024 * 1024)
          let left = total
          let acc = 0
          while (left > 0) {
            const n = readSync(ffd, chunk, 0, Math.min(chunk.length, left), total - left)
            if (!n) break
            acc = crc32(chunk.subarray(0, n), acc)
            left -= n
          }
          crc = acc >>> 0
        } finally {
          closeSync(ffd)
        }
      }

      const local = Buffer.alloc(30)
      local.writeUInt32LE(LOCAL_SIG, 0)
      local.writeUInt16LE(20, 4)        // version needed
      local.writeUInt16LE(0x0800, 6)    // flag: UTF-8 名字
      local.writeUInt16LE(0, 8)         // method: STORE
      local.writeUInt16LE(DOS_TIME, 10)
      local.writeUInt16LE(DOS_DATE, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(size, 18)     // compressed = 原样
      local.writeUInt32LE(size, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)

      writeSync(fd, local)
      writeSync(fd, nameBuf)
      written += local.length + nameBuf.length

      if (entry.data) {
        writeSync(fd, entry.data)
      } else {
        const ffd = openSync(entry.file, 'r')
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024)
          let pos = 0
          for (;;) {
            const n = readSync(ffd, chunk, 0, chunk.length, pos)
            if (!n) break
            writeSync(fd, chunk, 0, n)
            pos += n
          }
        } finally {
          closeSync(ffd)
        }
      }
      written += size

      central.push({ nameBuf, crc, size, offset })
      offset += 30 + nameBuf.length + size
    }

    const centralStart = offset
    for (const c of central) {
      const head = Buffer.alloc(46)
      head.writeUInt32LE(CENTRAL_SIG, 0)
      head.writeUInt16LE(20, 4)       // version made by
      head.writeUInt16LE(20, 6)       // version needed
      head.writeUInt16LE(0x0800, 8)
      head.writeUInt16LE(0, 10)       // method
      head.writeUInt16LE(DOS_TIME, 12)
      head.writeUInt16LE(DOS_DATE, 14)
      head.writeUInt32LE(c.crc, 16)
      head.writeUInt32LE(c.size, 20)
      head.writeUInt32LE(c.size, 24)
      head.writeUInt16LE(c.nameBuf.length, 28)
      head.writeUInt16LE(0, 30)
      head.writeUInt16LE(0, 32)
      head.writeUInt16LE(0, 34)
      head.writeUInt16LE(0, 36)
      head.writeUInt32LE(0, 38)
      head.writeUInt32LE(c.offset, 42)
      writeSync(fd, head)
      writeSync(fd, c.nameBuf)
      offset += 46 + c.nameBuf.length
    }

    const centralSize = offset - centralStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(EOCD_SIG, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralStart, 16)
    eocd.writeUInt16LE(0, 20)
    writeSync(fd, eocd)

    return { files: central.length, bytes: written }
  } finally {
    closeSync(fd)
  }
}

/** 读 zip 的中央目录，返回条目表 */
export function listZip(zipPath) {
  const fd = openSync(zipPath, 'r')
  try {
    const { size } = fstatSync(fd)
    // EOCD 在文件尾，最多再往前找 64KB
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip（没找到中央目录结尾）')
    const count = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    const dir = Buffer.alloc(centralSize)
    readSync(fd, dir, 0, centralSize, centralOffset)

    const entries = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip 中央目录损坏')
      const method = dir.readUInt16LE(p + 10)
      const crc = dir.readUInt32LE(p + 16)
      const compSize = dir.readUInt32LE(p + 20)
      const size0 = dir.readUInt32LE(p + 24)
      const nameLen = dir.readUInt16LE(p + 28)
      const extraLen = dir.readUInt16LE(p + 30)
      const commentLen = dir.readUInt16LE(p + 32)
      const localOffset = dir.readUInt32LE(p + 42)
      const name = dir.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      entries.push({ name, method, crc, compSize, size: size0, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    closeSync(fd)
  }
}

/** 读一个条目解压后的字节 */
export function readZipEntry(zipPath, entry) {
  const fd = openSync(zipPath, 'r')
  try {
    const head = Buffer.alloc(30)
    readSync(fd, head, 0, 30, entry.localOffset)
    if (head.readUInt32LE(0) !== LOCAL_SIG) throw new Error('zip 本地头损坏')
    const nameLen = head.readUInt16LE(26)
    const extraLen = head.readUInt16LE(28)
    const data = Buffer.alloc(entry.compSize)
    readSync(fd, data, 0, entry.compSize, entry.localOffset + 30 + nameLen + extraLen)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflateRawSync(data)
    throw new Error(`不支持的压缩方式 ${entry.method}`)
  } finally {
    closeSync(fd)
  }
}
