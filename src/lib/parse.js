// 解析：单一解码后端 sharp（ADR-0015），统一处理格式/尺寸/帧/透明/哈希。
//
// 输出结构与 docs/02-architecture.md §5 的 items 字段对应：
//   { format, width, height, frames, hasAlpha, dhash: [hex, hex, hex] }

import sharp from 'sharp'
import { COLS, ROWS, hashFromGray, bitsToHex } from './dhash.js'

/** 单文件上限（ADR-0014） */
export const MAX_BYTES = 16 * 1024 * 1024

/** libvips 能读、我们也愿意接的格式 */
const SUPPORTED = new Set(['jpeg', 'png', 'gif', 'webp', 'tiff', 'heif'])

export class ParseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ParseError'
    this.code = code
  }
}

/** 三帧采样位置：首、中、末；不足三帧时重复使用现有帧 */
export function sampleIndices(frames) {
  const n = Math.max(1, Math.floor(frames))
  if (n === 1) return [0, 0, 0]
  if (n === 2) return [0, 0, 1]
  return [0, Math.floor((n - 1) / 2), n - 1]
}

/** 把一帧压成 9×8 灰度（合成白底后再转灰） */
async function grayFrame(buf, page) {
  const raw = await sharp(buf, { page })
    .flatten({ background: '#ffffff' })
    .resize(COLS, ROWS, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
  return raw
}

/**
 * 解析一张图片。
 * @param {Buffer|Uint8Array} input
 * @returns {Promise<{format:string,width:number,height:number,frames:number,hasAlpha:boolean,dhash:string[],bytes:number}>}
 * @throws {ParseError} code 为 E_PARSE_TOO_LARGE / E_PARSE_UNSUPPORTED / E_PARSE_CORRUPT
 */
export async function parseImage(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const bytes = buf.length
  if (bytes === 0) throw new ParseError('E_PARSE_CORRUPT', '空文件')
  if (bytes > MAX_BYTES) {
    throw new ParseError('E_PARSE_TOO_LARGE', `${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${MAX_BYTES / 1024 / 1024}MB`)
  }

  let meta
  try {
    meta = await sharp(buf, { animated: true }).metadata()
  } catch (error) {
    const msg = String(error?.message || error)
    const unsupported = /unsupported|not supported|unknown format|Input buffer/i.test(msg)
    throw new ParseError(unsupported ? 'E_PARSE_UNSUPPORTED' : 'E_PARSE_CORRUPT', msg)
  }

  const format = String(meta.format || '').toLowerCase()
  if (!SUPPORTED.has(format)) {
    throw new ParseError('E_PARSE_UNSUPPORTED', `格式 ${format || '未知'} 不在支持列表`)
  }

  // 动图时 metadata.height 是「所有帧垂直堆叠」的高度，必须用 pageHeight
  const width = meta.pageWidth || meta.width || 0
  const height = meta.pageHeight || meta.height || 0
  if (!width || !height) throw new ParseError('E_PARSE_CORRUPT', '读不到尺寸')

  const frames = Math.max(1, meta.pages || 1)
  const dhash = []
  for (const page of sampleIndices(frames)) {
    let raw
    try {
      raw = await grayFrame(buf, page)
    } catch (error) {
      throw new ParseError('E_PARSE_CORRUPT', `第 ${page} 帧解码失败：${error.message}`)
    }
    dhash.push(bitsToHex(hashFromGray(raw)))
  }

  return {
    format,
    width,
    height,
    frames,
    hasAlpha: Boolean(meta.hasAlpha),
    dhash,
    bytes,
  }
}
