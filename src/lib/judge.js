// 「这张图到底是不是表情包」——用模型判，不用几何猜。
//
// 为什么需要（ADR-0020）：
//   - `sub_type` / 尺寸 / 宽高比都是**代理指标**：群里发的表情包经常就是一个普通图片段，
//     而游戏截图同样是「小、近方、普通图片段」，两者在元数据上一模一样。
//   - 唯一的区别在**画面内容**，所以只能看图判断。
//
// 三件事保证它便宜且不失控：
//   1. 缓存：按 md5 记住结论，同一张图重发不再花钱（库要长期用，重复图很多）
//   2. 只判一次：模块只对「既不是动图、QQ 也没标表情段」的图调用本模块
//   3. 兜底：模型不可用就返回 ok:false，让调用方退回按尺寸猜，不阻塞收图

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { ROOT } from './store.js'

export const JUDGE_CACHE = `${ROOT}/judge-cache.json`
const MAX_CACHE = 3000

/** 判定提示词：只输出一行 JSON，宁可说「不是」也不要瞎认 */
export function buildJudgePrompt() {
  return [
    '你是表情包判别器。给你一张聊天里出现的图，判断它是不是「表情包 / 梗图」。',
    '只输出一行 JSON，不要解释、不要 Markdown、不要代码块：',
    '{"sticker":true,"why":"12字以内的理由"}',
    '',
    '算表情包：用来表达情绪或玩梗的图。构图简单、主体突出；常见夸张表情、卡通角色、动物搞怪、粗体大字或无字、背景干净、方形或接近方形。',
    '不算：聊天/游戏/网页截图（有界面、状态栏、按钮、多行小字）、长截图、文档表格、风景或人像照片、商品图、聊天记录合并图。',
    '拿不准时看有没有「想让人会心一笑」的表达意图；纯记录信息用的图算不是。',
  ].join('\n')
}

/**
 * 解析模型输出。
 * 模型偶尔会多嘴（代码块、解释、多个 JSON），所以按「从宽松到严格」依次尝试，最后兜底看关键词。
 *
 * @returns {{sticker: boolean, why: string} | null} null = 没看懂
 */
export function parseVerdict(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  // 1) 直接是 JSON
  const tryJson = (s) => {
    try {
      const v = JSON.parse(s)
      if (v && typeof v.sticker === 'boolean') return { sticker: v.sticker, why: String(v.why || '').slice(0, 40) }
    } catch {
      /* 继续 */
    }
    return null
  }

  const direct = tryJson(raw)
  if (direct) return direct

  // 2) 文本里嵌了 JSON（最常见的多嘴形态）
  const m = raw.match(/\{[\s\S]*?"sticker"[\s\S]*?\}/)
  if (m) {
    const parsed = tryJson(m[0])
    if (parsed) return parsed
  }

  // 3) 只有 "sticker": true/false
  const kv = raw.match(/"sticker"\s*:\s*(true|false)/i)
  if (kv) return { sticker: kv[1].toLowerCase() === 'true', why: '' }

  // 4) 兜底：中文判断词。**先看否定**——「不是表情包」里也含「是表情包」
  if (/(不是|不算|并非|不属于|不能算)表情/.test(raw)) {
    return { sticker: false, why: raw.slice(0, 40) }
  }
  if (/截图|长截图|照片|文档|表格|商品图|聊天记录/.test(raw)) {
    return { sticker: false, why: raw.slice(0, 40) }
  }
  if (/(是|属于|算|算是)表情包/.test(raw)) {
    return { sticker: true, why: raw.slice(0, 40) }
  }
  return null
}

function loadCache() {
  try {
    if (!existsSync(JUDGE_CACHE)) return {}
    const data = JSON.parse(readFileSync(JUDGE_CACHE, 'utf8').replace(/^\uFEFF/, ''))
    return data && typeof data.items === 'object' && data.items ? data.items : {}
  } catch {
    // 缓存坏了不能影响收图：当作空
    return {}
  }
}

function saveCache(items) {
  const keys = Object.keys(items)
  // 只留最近 MAX_CACHE 条（多余的按时间砍掉，防止文件无限长）
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0))
    for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete items[k]
  }
  const tmp = `${JUDGE_CACHE}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 0), 'utf8')
  renameSync(tmp, JUDGE_CACHE)
}

const md5Of = (buf) => createHash('md5').update(buf).digest('hex')

/**
 * 判断一张图是不是表情包。
 *
 * @param {object} ctx 宿主上下文（需要 attachments / llm / agentDefaultModel）
 * @param {Buffer} buf 图片字节
 * @returns {Promise<{ok: boolean, sticker?: boolean, why?: string, md5: string, cached?: boolean, code?: string, message?: string}>}
 */
export async function judgeBuffer(ctx, buf) {
  const md5 = md5Of(buf)
  const cache = loadCache()
  if (cache[md5] && typeof cache[md5].sticker === 'boolean') {
    return { ok: true, sticker: cache[md5].sticker, why: cache[md5].why || '', md5, cached: true }
  }

  if (!ctx?.llm || !ctx?.attachments) {
    return { ok: false, code: 'E_NO_LLM', message: '当前宿主没有 llm / attachments 服务', md5 }
  }
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (!selection?.provider || !selection?.model) {
    return { ok: false, code: 'E_NO_MODEL', message: '拿不到默认模型', md5 }
  }

  const mediaType = detectMediaType(buf)
  let admitted
  try {
    admitted = await ctx.attachments.admitPromptContent([
      { type: 'text', text: '这张图是不是表情包？只回一行 JSON。' },
      // attachments 要的是 base64 字符串（不是 Buffer），和 analyze.js 保持一致
      { type: 'image', data: buf.toString('base64'), mediaType, name: 'judge' },
    ])
  } catch (error) {
    return { ok: false, code: 'E_ATTACH', message: `附件处理失败：${error.message}`, md5 }
  }

  let text = ''
  try {
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: buildJudgePrompt(),
      messages: [{ role: 'user', content: admitted }],
      temperature: 0,
      maxTokens: 60,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch (error) {
    return { ok: false, code: 'E_LLM', message: `模型调用失败：${error.message}`, md5 }
  }

  const verdict = parseVerdict(text)
  if (!verdict) {
    return { ok: false, code: 'E_UNPARSEABLE', message: `看不懂模型输出：${text.slice(0, 60)}`, md5 }
  }

  cache[md5] = { sticker: verdict.sticker, why: verdict.why, at: Date.now() }
  try {
    saveCache(cache)
  } catch {
    // 写缓存失败不影响判定结果
  }
  return { ok: true, sticker: verdict.sticker, why: verdict.why, md5, cached: false }
}

function detectMediaType(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg'
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png'
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}
