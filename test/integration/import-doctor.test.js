// 集成测试：导入 → 判重 → 体检 → 破坏 → 修复
// 全部在临时目录中完成，不碰真实库。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

// 环境变量必须在 import 之前生效，因此用动态 import
const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const pipeline = await import('../../src/lib/pipeline.js')
const { doctor } = await import('../../src/lib/doctor.js')

const fixtures = join(import.meta.dirname, '..', 'fixtures')

/** 记录所有打开的索引，结束后统一关闭再删目录（否则 WAL 文件会锁住） */
const opened = []
function openIndex() {
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

function makeSource() {
  const dir = join(tmpRoot, 'source')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixtures, 'dup-a.jpg'), join(dir, 'a.jpg'))
  copyFileSync(join(fixtures, 'dup-b.jpg'), join(dir, 'b.jpg'))
  copyFileSync(join(fixtures, 'control.png'), join(dir, 'c.png'))
  return dir
}

const libFiles = () =>
  existsSync(store.LIBRARY)
    ? readdirSync(store.LIBRARY, { recursive: true }).filter((f) => String(f).match(/\.(jpg|png|gif|webp)$/i))
    : []

test('导入：先 dry-run（不写盘）再实跑（判重生效）', async () => {
  const source = makeSource()
  store.ensureDirs()
  const index = openIndex()

  // 1. dry-run
  const dry = await pipeline.importDirectory(index, source, { dryRun: true })
  assert.equal(dry.scanned, 3)
  assert.equal(dry.added, 2, 'a.jpg 与 c.png 应可入库，b.jpg 与 a.jpg 判重')
  assert.equal(dry.duplicate, 1)
  assert.equal(libFiles().length, 0, 'dry-run 不得写文件')
  assert.equal(db.counts(index).total, 0, 'dry-run 不得写索引')

  // 2. 实跑
  const real = await pipeline.importDirectory(index, source)
  assert.equal(real.scanned, 3)
  assert.equal(real.added, 2)
  assert.equal(real.duplicate, 1)
  assert.equal(libFiles().length, 2)
  assert.equal(db.counts(index).total, 2)

  // 3. 再次导入同一目录：全部判重
  const again = await pipeline.importDirectory(index, source)
  assert.equal(again.added, 0)
  assert.equal(again.duplicate, 3)
  assert.equal(db.counts(index).total, 2, '重复导入不应增加记录')
})

test('体检：数量一致、无孤儿、能报出重复簇', () => {
  const index = openIndex()
  const r = doctor(index)
  assert.equal(r.stats.files, 2)
  assert.equal(r.stats.total, 2)
  assert.equal(r.stats.orphans, 0)
  assert.equal(r.stats.missing, 0)
  assert.equal(r.ok, true, r.lines.join('\n'))
})

test('破坏：删掉一张库文件后体检必须报缺文件，修复后恢复', async () => {
  const index = openIndex()

  const victim = store.listLibraryFiles()[0]
  unlinkSync(victim.abs)

  const broken = doctor(index)
  assert.equal(broken.stats.missing, 1, '应检测到索引有、磁盘无')
  assert.equal(broken.ok, false)

  const fixed = await pipeline.repair(index, { orphans: true, missing: true })
  assert.equal(fixed.purged, 1)

  const healed = doctor(index)
  assert.equal(healed.stats.missing, 0)
  assert.equal(healed.ok, true, healed.lines.join('\n'))
})

test('重建：保留已有的人工字段', async () => {
  const index = openIndex()

  const [row] = db.allItems(index)
  assert.ok(row, '应至少有一条记录')
  db.updateItem(index, row.md5, { name: '测试名字', tags: '卖萌,测试' })

  const r = await pipeline.rebuild(index)
  assert.equal(r.scanned, 1)
  assert.equal(r.added, 1)

  const afterRow = db.getItem(index, row.md5)
  assert.equal(afterRow.name, '测试名字', '重建后名字必须保留')
  assert.equal(afterRow.tags, '卖萌,测试')
})
