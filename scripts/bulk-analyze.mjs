// 批量标注：把库里「还没认出角色」的图过一遍模型（用现在的 28 条角色表）。
//
// 为什么用 HTTP 而不是 import runAnalyze：
//   分析需要宿主上下文（llm / attachments），那是 DSH 进程里的服务。
//   这个脚本是外部进程，只能通过 Host 的 HTTP 接口让它干活。
//
// 用法：
//   node scripts/bulk-analyze.mjs                # 处理所有「未知角色」
//   node scripts/bulk-analyze.mjs --todo=notags  # 处理无标签的
//   node scripts/bulk-analyze.mjs --limit=20 --concurrency=3
//   node scripts/bulk-analyze.mjs --dry          # 只列清单，不调用模型

const args = process.argv.slice(2)
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const dry = args.includes('--dry')
const todo = flag('todo', 'nochar')
const limit = Number(flag('limit', '0')) || 0
const concurrency = Math.max(1, Math.min(4, Number(flag('concurrency', '3')) || 3))

const BASE = flag('base', 'http://127.0.0.1:9884/meme-brain/api')

async function getJson(path) {
  const res = await fetch(`${BASE}?${path}`)
  const j = await res.json().catch(() => null)
  if (!j || !j.ok) throw new Error(j?.error?.message || j?.error?.code || `HTTP ${res.status}`)
  return j.data
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}?${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const j = await res.json().catch(() => null)
  if (!j) throw new Error(`返回的不是 JSON（HTTP ${res.status}）`)
  if (!j.ok) throw new Error(j.error?.message || j.error?.code || '请求失败')
  return j.data
}

const list = await getJson(`op=list&todo=${encodeURIComponent(todo)}&limit=500`)
let queue = Array.isArray(list.items) ? list.items : []
if (limit) queue = queue.slice(0, limit)

console.log(`待处理 ${queue.length} 张（todo=${todo}${limit ? `，limit=${limit}` : ''}，并发 ${concurrency}）`)
if (dry) {
  for (const it of queue) console.log(`  ${it.md5.slice(0, 8)}  ${it.name || '（未命名）'}`)
  process.exit(0)
}
if (!queue.length) process.exit(0)

const started = Date.now()
const done = []
const failed = []
let cursor = 0
let finished = 0

const pad = (n) => String(n).padStart(3, ' ')

async function worker(id) {
  for (;;) {
    const i = cursor++
    if (i >= queue.length) return
    const it = queue[i]
    const before = { md5: it.md5, name: it.name || '', character: it.character || '' }
    try {
      const d = await postJson('op=analyze', { md5: it.md5 })
      const after = d.item || {}
      const rec = {
        ...before,
        character: after.character || '',
        charConf: after.charConf || '',
        name: after.name || before.name,
        why: d.result?.skipped?.length ? `跳过：${d.result.skipped[0].message}` : '',
      }
      done.push(rec)
      finished += 1
      const mark = rec.character ? `→ ${rec.character}（${rec.charConf || '?'}）` : '→ 仍未知'
      console.log(`[${pad(finished)}/${queue.length}] ${before.md5.slice(0, 8)}  ${(before.name || '未命名').slice(0, 12).padEnd(12)} ${mark}`)
    } catch (error) {
      failed.push({ ...before, error: error.message })
      finished += 1
      console.log(`[${pad(finished)}/${queue.length}] ${before.md5.slice(0, 8)}  ✗ ${error.message}`)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)))

const secs = Math.round((Date.now() - started) / 1000)
const assigned = done.filter((d) => d.character)
const stillUnknown = done.filter((d) => !d.character)
const byChar = {}
for (const d of assigned) byChar[d.character] = (byChar[d.character] || 0) + 1

console.log('')
console.log(`完成 ${done.length} 张，失败 ${failed.length} 张，用时 ${Math.floor(secs / 60)}分${secs % 60}秒`)
console.log(`认出角色 ${assigned.length} 张，仍然未知 ${stillUnknown.length} 张`)
if (assigned.length) {
  console.log('角色分布：')
  for (const [k, v] of Object.entries(byChar).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
}
if (failed.length) {
  console.log('失败明细：')
  for (const f of failed.slice(0, 10)) console.log(`  ${f.md5.slice(0, 8)}  ${f.error.slice(0, 80)}`)
}

const { writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const report = join(tmpdir(), `meme-bulk-${Date.now()}.json`)
writeFileSync(report, JSON.stringify({ todo, total: queue.length, done, failed }, null, 2), 'utf8')
console.log(`报告：${report}`)
