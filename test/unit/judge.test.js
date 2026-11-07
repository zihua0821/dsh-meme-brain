// 「这张是不是表情包」的模型判定层。
//
// 这里钉住三件事：输出怎么解析（模型会多嘴）、缓存（同图不重复花钱）、没有模型时怎么失败。

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'meme-brain-judge-'))
process.env.DSH_MEME_BRAIN_ROOT = tmpRoot

const judge = await import('../../src/lib/judge.js')

after(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** 假的 llm / attachments：记录调用次数，按脚本回复 */
function fakeCtx(replies) {
  const calls = { stream: 0, admit: 0 }
  let i = 0
  return {
    calls,
    ctx: {
      attachments: {
        admitPromptContent: async (parts) => {
          calls.admit += 1
          return parts
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      llm: {
        stream: (opts) => {
          calls.stream += 1
          const reply = replies[Math.min(i, replies.length - 1)]
          i += 1
          return (async function* () {
            if (reply instanceof Error) throw reply
            yield { type: 'text-delta', text: reply }
          })()
        },
      },
    },
  }
}

const BUF = Buffer.from('GIF89a fake image bytes for judge')
const OTHER = Buffer.from('GIF89a another different image bytes')

test('模型说「是表情包」→ sticker:true，理由带回来', async () => {
  const { ctx, calls } = fakeCtx(['{"sticker":true,"why":"熊猫头玩梗"}'])
  const r = await judge.judgeBuffer(ctx, BUF)
  assert.equal(r.ok, true)
  assert.equal(r.sticker, true)
  assert.equal(r.why, '熊猫头玩梗')
  assert.equal(r.cached, false)
  assert.equal(calls.stream, 1, '问了一次模型')
})

test('同一张图第二次直接走缓存，不再调模型', async () => {
  const { ctx, calls } = fakeCtx(['{"sticker":true,"why":"不该被调用到"}'])
  const r = await judge.judgeBuffer(ctx, BUF)
  assert.equal(r.ok, true)
  assert.equal(r.cached, true, '命中缓存')
  assert.equal(calls.stream, 0, '一次模型都没调')
})

test('模型多嘴（带代码块/解释）也能解析出来', async () => {
  const { ctx } = fakeCtx(['```json\n{"sticker":false,"why":"游戏截图"}\n```\n说明：看到界面了'])
  const r = await judge.judgeBuffer(ctx, OTHER)
  assert.equal(r.ok, true)
  assert.equal(r.sticker, false)
  assert.equal(r.why, '游戏截图')
})

test('模型输出看不懂 → ok:false，让调用方退回尺寸判断', async () => {
  const { ctx } = fakeCtx(['我觉得这个挺有意思的'])
  const r = await judge.judgeBuffer(ctx, Buffer.from('GIF89a unparseable case'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_UNPARSEABLE')
})

test('模型调用抛错 → ok:false（code E_LLM）', async () => {
  const { ctx } = fakeCtx([new Error('网络超时')])
  const r = await judge.judgeBuffer(ctx, Buffer.from('GIF89a llm error case'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_LLM')
  assert.match(r.message, /网络超时/)
})

test('没有 llm 服务 → ok:false（code E_NO_LLM）', async () => {
  const r = await judge.judgeBuffer({}, Buffer.from('GIF89a no llm case'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_NO_LLM')
})

test('缓存落盘：文件里有这张图（下次会话也能免一次调用）', () => {
  assert.ok(existsSync(judge.JUDGE_CACHE), '缓存文件应该存在')
  const data = JSON.parse(readFileSync(judge.JUDGE_CACHE, 'utf8'))
  assert.equal(data.version, 1)
  assert.ok(Object.keys(data.items).length >= 1)
  const one = Object.values(data.items)[0]
  assert.equal(typeof one.sticker, 'boolean')
  assert.equal(typeof one.at, 'number')
})
