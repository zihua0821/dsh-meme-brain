// 回归测试：真实夹具上的解析与判重
// 基线见 test/fixtures/README.md —— 这些断言失败意味着算法发生了非预期变化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseImage, ParseError, sampleIndices, MAX_BYTES } from '../../src/lib/parse.js'
import { compare, findClusters } from '../../src/lib/dedupe.js'

const fixtures = join(import.meta.dirname, '..', 'fixtures')
const load = (name) => readFileSync(join(fixtures, name))

test('解析 JPEG：尺寸与三帧哈希', async () => {
  const r = await parseImage(load('dup-a.jpg'))
  assert.equal(r.format, 'jpeg')
  assert.equal(r.width, 240)
  assert.equal(r.height, 177)
  assert.equal(r.frames, 1)
  assert.equal(r.dhash.length, 3)
  for (const h of r.dhash) assert.match(h, /^[0-9a-f]{16}$/)
})

test('已知重复对：距离 0，判为重复', async () => {
  const a = await parseImage(load('dup-a.jpg'))
  const b = await parseImage(load('dup-b.jpg'))
  const d = compare(a.dhash, b.dhash)
  assert.equal(d.dup, true, `期望判重，实际 avg=${d.avg} max=${d.max}`)
  assert.equal(d.max, 0, '两张图应完全一致')
})

test('无关图：不判重，且距离明显大于阈值', async () => {
  const a = await parseImage(load('dup-a.jpg'))
  const c = await parseImage(load('control.png'))
  const d = compare(a.dhash, c.dhash)
  assert.equal(d.dup, false)
  assert.ok(d.max > 8, `期望 max>8，实际 ${d.max}`)
})

test('WebP 可解析（sharp 覆盖格式）', async () => {
  const r = await parseImage(load('control.webp'))
  assert.equal(r.format, 'webp')
  assert.ok(r.width > 0 && r.height > 0)
  assert.equal(r.dhash.length, 3)
})

test('动图：帧数与透明标记', async () => {
  const r = await parseImage(load('anim.gif'))
  assert.equal(r.format, 'gif')
  assert.equal(r.frames, 15)
  assert.equal(r.hasAlpha, true)
  assert.equal(r.dhash.length, 3)
  // 三帧采样不应全部相同（否则说明只解了首帧）
  assert.ok(new Set(r.dhash).size >= 2, '三帧哈希完全相同，可能没有真正取到不同帧')
})

test('同一动图重复解析结果稳定', async () => {
  const a = await parseImage(load('anim.gif'))
  const b = await parseImage(load('anim.gif'))
  assert.deepEqual(a.dhash, b.dhash)
})

test('聚类：重复对进同一簇，对照图独立', async () => {
  const a = await parseImage(load('dup-a.jpg'))
  const b = await parseImage(load('dup-b.jpg'))
  const c = await parseImage(load('control.png'))
  const items = [
    { md5: 'a', dhash: a.dhash },
    { md5: 'b', dhash: b.dhash },
    { md5: 'c', dhash: c.dhash },
  ]
  const clusters = findClusters(items)
  assert.equal(clusters.length, 1)
  assert.deepEqual(clusters[0].members.map((m) => m.md5).sort(), ['a', 'b'])
})

test('采样位置：1/2/多帧', () => {
  assert.deepEqual(sampleIndices(1), [0, 0, 0])
  assert.deepEqual(sampleIndices(2), [0, 0, 1])
  assert.deepEqual(sampleIndices(10), [0, 4, 9])
})

test('错误分支：空文件 / 垃圾数据 / 超大文件', async () => {
  await assert.rejects(() => parseImage(Buffer.alloc(0)), (e) => e instanceof ParseError && e.code === 'E_PARSE_CORRUPT')

  await assert.rejects(
    () => parseImage(Buffer.from('这不是图片，只是一段文字'.repeat(10))),
    (e) => e instanceof ParseError && ['E_PARSE_UNSUPPORTED', 'E_PARSE_CORRUPT'].includes(e.code),
  )

  await assert.rejects(() => parseImage(Buffer.alloc(MAX_BYTES + 1)), (e) => e instanceof ParseError && e.code === 'E_PARSE_TOO_LARGE')
})
