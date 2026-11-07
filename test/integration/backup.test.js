// 导出 / 导入：打包、还原、只补不覆盖。
//
// 这是「数据只有一份」的唯一保险，必须证明：
//   1. 导出的包能被自己读回来
//   2. 图 + 标注 + 角色表都能还原
//   3. 导入不会覆盖已有的（尤其是人工标注）

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { deflateRawSync, crc32 } from 'node:zlib'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-backup-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const archive = await import('../../src/lib/archive.js')
const backup = await import('../../src/lib/backup.js')
const characterTable = await import('../../src/lib/characters.js')

const opened = []
const openIndex = () => {
  const index = db.openDb(store.INDEX_DB)
  opened.push(index)
  return index
}

after(() => {
  for (const index of opened) {
    try {
      index.close?.()
    } catch {
      /* 已关闭 */
    }
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

store.ensureDirs()
const index = openIndex()
const buf = (s) => Buffer.from(s)
const md5Of = (b) => createHash('md5').update(b).digest('hex')

// ---------- zip 这一层 ----------

test('zip：写进去再读出来，字节一致（STORE）', () => {
  const zip = join(tmpRoot, 'a.zip')
  const r = archive.writeZip(zip, [
    { name: 'hello.txt', data: buf('你好，表情包') },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3, 4, 5]) },
  ])
  assert.equal(r.files, 2)

  const entries = archive.listZip(zip)
  assert.deepEqual(entries.map((e) => e.name), ['hello.txt', 'dir/b.bin'])
  assert.equal(archive.readZipEntry(zip, entries[0]).toString('utf8'), '你好，表情包')
  assert.deepEqual([...archive.readZipEntry(zip, entries[1])], [1, 2, 3, 4, 5])
})

test('zip：能读 DEFLATE 压缩的包（Windows 压缩过的备份也能导）', () => {
  // 手工造一个 method=8 的 zip：Windows「发送到压缩文件夹」打出来就是这种
  const name = Buffer.from('hello.txt', 'utf8')
  const data = buf('你好，压缩过的表情包')
  const packed = deflateRawSync(data)
  const crc = crc32(data) >>> 0
  const zip = join(tmpRoot, 'deflate.zip')

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8) // DEFLATE
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(packed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(packed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12)
  eocd.writeUInt32LE(30 + name.length + packed.length, 16)

  const fd = openSync(zip, 'w')
  writeSync(fd, local)
  writeSync(fd, name)
  writeSync(fd, packed)
  writeSync(fd, central)
  writeSync(fd, name)
  writeSync(fd, eocd)
  closeSync(fd)

  const entries = archive.listZip(zip)
  assert.equal(entries[0].method, 8)
  assert.equal(archive.readZipEntry(zip, entries[0]).toString('utf8'), '你好，压缩过的表情包')
})

// ---------- 导出/导入 ----------

/** 造一张真图（md5 由内容算出，这样导入的完整性校验才过得去） */
function seedImage(content, over = {}) {
  const b = buf(content)
  const md5 = md5Of(b)
  const rel = store.relPathFor(md5, 'gif')
  const abs = store.absPath(rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, b)
  db.insertItem(index, {
    md5, path: rel, ext: 'gif', bytes: b.length, width: 10, height: 10, frames: 1,
    hasAlpha: false, dhash: '0'.repeat(16), state: 'stored', createdAt: Date.now(), ...over,
  })
  return { md5, rel, abs, buf: b }
}

const A = seedImage('img-one', { name: '一张', character: '测试角色', charConf: '人工', pinned: 1, tags: '卖萌', score: '{"valence":0.5}' })
const B = seedImage('img-two', { name: '两张', tags: '无语' })

test('导出：生成 zip，带 manifest、角色表和每张图', () => {
  characterTable.upsert({ name: '测试角色', kind: 'character', look: '蓝发' })
  const r = backup.exportLibrary(index)
  assert.equal(r.ok, true)
  assert.equal(r.items, 2)
  assert.ok(existsSync(r.path))
  assert.ok(statSync(r.path).size > 0)

  const entries = archive.listZip(r.path).map((e) => e.name).sort()
  assert.deepEqual(entries, [
    'characters.json',
    `library/${A.md5}.gif`,
    `library/${B.md5}.gif`,
    'manifest.json',
  ].sort())

  const raw = archive.readZipEntry(r.path, archive.listZip(r.path).find((e) => e.name === 'manifest.json'))
  const manifest = JSON.parse(raw.toString('utf8'))
  assert.equal(manifest.count, 2)
  assert.equal(manifest.items.find((i) => i.md5 === A.md5).pinned, 1, '锁定状态要带上')
  assert.ok(manifest.characters.some((c) => c.name === '测试角色'), '角色表要带上')
})

test('导入：清空后能还原图 + 全部标注', () => {
  const zip = backup.exportLibrary(index).path

  for (const row of db.allItems(index)) {
    db.deleteItem(index, row.md5)
    rmSync(store.absPath(row.path), { force: true })
  }
  assert.equal(db.allItems(index).length, 0)

  const r = backup.importLibrary(index, { from: zip })
  assert.equal(r.ok, true)
  assert.equal(r.added, 2, `两张都要补回来（failed: ${JSON.stringify(r.failed)}）`)

  const one = db.getItem(index, A.md5)
  assert.ok(one)
  assert.equal(one.name, '一张')
  assert.equal(one.character, '测试角色')
  assert.equal(one.char_conf, '人工', '人工把握度要保留')
  assert.equal(one.pinned, 1, '锁定要保留')
  assert.equal(one.tags, '卖萌')
  assert.equal(one.score, '{"valence":0.5}')
  assert.ok(existsSync(store.absPath(one.path)), '图要落回磁盘')
  assert.equal(readFileSync(store.absPath(one.path)).toString(), 'img-one', '字节完全一致')
})

test('导入：已有的条目不会被覆盖（只补空字段）', () => {
  const zip = backup.exportLibrary(index).path
  db.updateItem(index, A.md5, { name: '我改过的名字', character: '手工角色', char_conf: '人工', tags: '' })

  const r = backup.importLibrary(index, { from: zip })
  assert.equal(r.ok, true)
  assert.equal(r.added, 0, '不重复加')
  assert.ok(r.skipped + r.merged >= 2)

  const one = db.getItem(index, A.md5)
  assert.equal(one.name, '我改过的名字', '人工改的名字不被覆盖')
  assert.equal(one.character, '手工角色', '人工标的角色不被覆盖')
  assert.equal(one.tags, '卖萌', '空字段由包补上')
})

test('导入：不是本系统的包会明确拒绝', () => {
  const foreign = join(tmpRoot, 'foreign.zip')
  archive.writeZip(foreign, [{ name: 'readme.txt', data: buf('hello') }])
  const r = backup.importLibrary(index, { from: foreign })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NO_MANIFEST')
})

test('导入：路径不存在会明确报错', () => {
  const r = backup.importLibrary(index, { from: join(tmpRoot, 'nope.zip') })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NOT_FOUND')
})

test('导入：包里图被篡改（md5 对不上）会被拒收', () => {
  const zip = join(tmpRoot, 'tampered.zip')
  const md5 = '9'.repeat(32)
  const manifest = { app: 'dsh-meme-brain', version: 1, count: 1, characters: [], items: [{ md5, ext: 'gif', name: '假的' }] }
  archive.writeZip(zip, [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: `library/${md5}.gif`, data: buf('内容不一样') },
  ])
  const r = backup.importLibrary(index, { from: zip })
  assert.equal(r.ok, true)
  assert.equal(r.added, 0, 'md5 对不上不能入库')
  assert.equal(r.failed.length, 1)
  assert.match(r.failed[0].message, /md5/)
})
