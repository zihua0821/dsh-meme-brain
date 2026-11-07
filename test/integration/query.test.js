// M3 集成测试：列表 / 单张 / 重复 / 待办 / 回填
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-q-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const store = await import('../../src/lib/store.js')
const db = await import('../../src/lib/db.js')
const pipeline = await import('../../src/lib/pipeline.js')
const query = await import('../../src/lib/query.js')
const { parseArgs } = await import('../../src/commands.js')

const fixtures = join(import.meta.dirname, '..', 'fixtures')
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

const md5Of = (buf) => createHash('md5').update(buf).digest('hex')

test('参数解析：--key=value 与裸开关', () => {
  const a = parseArgs('list --limit=5 --state=stored')
  assert.equal(a.sub, 'list')
  assert.equal(a.flags.limit, '5')
  assert.equal(a.flags.state, 'stored')

  const b = parseArgs('import C:\\x --dry-run')
  assert.equal(b.sub, 'import')
  assert.equal(b.args[0], 'C:\\x')
  assert.equal(b.flags['dry-run'], true)
})

test('列表 / 单张 / 重复 / 待办', async () => {
  const source = join(tmpRoot, 'src')
  mkdirSync(source, { recursive: true })
  copyFileSync(join(fixtures, 'dup-a.jpg'), join(source, 'a.jpg'))
  copyFileSync(join(fixtures, 'control.png'), join(source, 'c.png'))

  store.ensureDirs()
  const index = openIndex()
  await pipeline.importDirectory(index, source)
  assert.equal(db.counts(index).total, 2)

  const list = query.formatList(index, { limit: 2 })
  assert.match(list, /共 2 条/)
  assert.match(list, /（未命名）/)

  const [row] = db.allItems(index)
  const detail = query.formatDetail(row)
  assert.match(detail, new RegExp(row.md5))
  assert.match(detail, /指纹/)
  assert.match(detail, /未分析/)

  assert.match(query.formatDupes(index), /未发现重复簇/)
  assert.match(query.formatTodo(index), /总数\s+2/)
})

test('回填：按 md5 从源 index.json 补名字与标签', async () => {
  const source = join(tmpRoot, 'src')
  const index = openIndex()

  const aBuf = readFileSync(join(fixtures, 'dup-a.jpg'))
  const cBuf = readFileSync(join(fixtures, 'control.png'))
  const manifest = {
    items: [
      { md5: md5Of(aBuf), name: '摆烂摊手', tags: ['得意', '摸鱼'] },
      { md5: md5Of(cBuf), name: '气到掀桌', tags: ['生气'] },
    ],
  }
  writeFileSync(join(source, 'index.json'), JSON.stringify(manifest), 'utf8')

  const r = await pipeline.backfillMeta(index, source)
  assert.equal(r.matched, 2)
  assert.equal(r.updated, 2)

  const names = db.allItems(index).map((x) => x.name).sort()
  assert.deepEqual(names, ['摆烂摊手', '气到掀桌'])

  const list = query.formatList(index, { limit: 5 })
  assert.match(list, /摆烂摊手/)
  assert.doesNotMatch(list, /（未命名）/)

  // 再跑一次：不应重复更新
  const again = await pipeline.backfillMeta(index, source)
  assert.equal(again.updated, 0)
})
