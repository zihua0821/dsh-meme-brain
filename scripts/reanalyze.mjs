// 定点重跑：对指定的几张重新分析（角色表改过之后用来纠正旧判定）。
//
// 用法：
//   node scripts/reanalyze.mjs --by-character=doge,cheems,乖巧宝宝
//   node scripts/reanalyze.mjs --by-name=柯基 --limit=20
//   node scripts/reanalyze.mjs --md5=6667ea58,5174e976
//   node scripts/reanalyze.mjs --by-character=doge --dry

const { DatabaseSync } = await import('node:sqlite')
const { homedir } = await import('node:os')
const { join } = await import('node:path')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const dry = args.includes('--dry')
const chars = flag('by-character', '')
const byName = flag('by-name', '')
const md5s = flag('md5', '')
const limit = Number(flag('limit', '0')) || 0

const BASE = flag('base', 'http://127.0.0.1:9884/meme-brain/api')
const db = new DatabaseSync(join(homedir(), '.dsh', 'meme-brain', 'index.db'), { readOnly: true })

let rows = []
if (md5s) {
  const list = md5s.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of list) {
    const r = db.prepare('select md5, name, character from items where md5 like ?').get(`${p}%`)
    if (r) rows.push(r)
  }
} else if (chars) {
  const list = chars.split(',').map((s) => s.trim()).filter(Boolean)
  const q = `select md5, name, character from items where character in (${list.map(() => '?').join(',')})`
  rows = db.prepare(q).all(...list)
} else if (byName) {
  rows = db.prepare('select md5, name, character from items where name like ? or appearance like ?').all(`%${byName}%`, `%${byName}%`)
} else {
  console.error('要给一个范围：--by-character= / --by-name= / --md5=')
  process.exit(1)
}
db.close()

if (limit) rows = rows.slice(0, limit)
console.log(`要重跑 ${rows.length} 张`)
if (dry) {
  for (const r of rows) console.log(`  ${r.md5.slice(0, 8)}  ${r.name}  现在=${r.character || '未知'}`)
  process.exit(0)
}

let changed = 0
let stillSame = 0
let failed = 0
for (const [i, r] of rows.entries()) {
  const before = r.character || ''
  try {
    const res = await fetch(`${BASE}?op=analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ md5: r.md5 }),
      signal: AbortSignal.timeout(120000),
    })
    const j = await res.json()
    if (!j.ok) throw new Error(j.error?.message || j.error?.code)
    const after = j.data.item?.character || ''
    const mark = before === after ? `保持在 ${after || '未知'}` : `${before || '未知'} → ${after || '未知'}`
    if (before !== after) changed += 1
    else stillSame += 1
    console.log(`[${String(i + 1).padStart(3)}/${rows.length}] ${r.md5.slice(0, 8)}  ${(r.name || '').slice(0, 12).padEnd(12)} ${mark}`)
  } catch (error) {
    failed += 1
    console.log(`[${String(i + 1).padStart(3)}/${rows.length}] ${r.md5.slice(0, 8)}  ✗ ${error.message}`)
  }
}

console.log('')
console.log(`结果变了 ${changed} 张，没变 ${stillSame} 张，失败 ${failed} 张`)
