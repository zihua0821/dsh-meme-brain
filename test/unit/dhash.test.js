// dhash 纯函数单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COLS, ROWS, BITS, hashFromGray, bitsToHex, hexToBits, hamming, frameDistance, isDuplicate,
} from '../../src/lib/dhash.js'

/** 造一张纯函数可控的 9×8 灰度图 */
function gray(fn) {
  const g = new Uint8Array(COLS * ROWS)
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) g[y * COLS + x] = fn(x, y)
  return g
}

test('位宽是 64', () => {
  assert.equal(BITS, 64)
})

test('全等灰度 → 全 0 位', () => {
  const bits = hashFromGray(gray(() => 128))
  assert.equal(bits.length, 64)
  assert.equal(bits.reduce((a, b) => a + b, 0), 0)
})

test('从左到右递增 → 每行 8 个 0', () => {
  const bits = hashFromGray(gray((x) => x * 20))
  assert.equal(bits.reduce((a, b) => a + b, 0), 0)
})

test('从左到右递减 → 每行 8 个 1', () => {
  const bits = hashFromGray(gray((x) => 255 - x * 20))
  assert.equal(bits.reduce((a, b) => a + b, 0), 64)
})

test('灰度数据长度不对时报错', () => {
  assert.throws(() => hashFromGray(new Uint8Array(10)), /长度应为/)
})

test('十六进制往返一致', () => {
  const bits = hashFromGray(gray((x) => (x % 3) * 80))
  const hex = bitsToHex(bits)
  assert.equal(hex.length, 16)
  assert.deepEqual(hexToBits(hex), bits)
})

test('非法十六进制被拒绝', () => {
  assert.throws(() => hexToBits('xyz'))
  assert.throws(() => hexToBits('abcd'))
})

test('汉明距离：自己比自己是 0，取反是 64', () => {
  const bits = hashFromGray(gray((x, y) => x * 10 + y))
  const hex = bitsToHex(bits)
  const flipped = bitsToHex(bits.map((b) => 1 - b))
  assert.equal(hamming(hexToBits(hex), hexToBits(hex)), 0)
  assert.equal(hamming(hexToBits(hex), hexToBits(flipped)), 64)
})

test('多帧距离取逐帧平均与最大值', () => {
  const a = ['0000000000000000', '0000000000000000', '0000000000000000']
  const b = ['0000000000000000', '0000000000000003', '0000000000000000']
  const d = frameDistance(a, b)
  assert.equal(d.max, 2)
  assert.equal(d.avg, 2 / 3)
})

test('帧数不同时只比较公共部分', () => {
  const a = ['0000000000000000']
  const b = ['0000000000000000', 'ffffffffffffffff', 'ffffffffffffffff']
  const d = frameDistance(a, b)
  assert.equal(d.pairs.length, 1)
  assert.equal(d.avg, 0)
})

test('判重阈值：默认 avg≤4 且 max≤8', () => {
  assert.equal(isDuplicate({ avg: 0, max: 0 }), true)
  assert.equal(isDuplicate({ avg: 4, max: 8 }), true)
  assert.equal(isDuplicate({ avg: 4.1, max: 8 }), false)
  assert.equal(isDuplicate({ avg: 1, max: 9 }), false)
  assert.equal(isDuplicate({ avg: 11, max: 11 }, { thresholdAvg: 12, thresholdMax: 12 }), true)
})
