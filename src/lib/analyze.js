// 分析层：让视觉模型看表情，产出「名字 / 角色 / 文字 / 六维分值 / 场景」。
//
// 提示词与解析分开导出，便于用纯函数测试（不调模型）。

import { readFileSync } from 'node:fs'

import { absPath } from './store.js'
import * as db from './db.js'
import * as characterTable from './characters.js'

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

export const SCORE_KEYS = ['valence', 'arousal', 'aggression', 'intimacy', 'absurdity']
export const TARGETS = ['自己', '对方', '第三方', '无']
export const SCENES = ['吃饭', '工作', '游戏', '摸鱼', '睡觉', '社交', '日常']

const FIELD_ALIASES = {
  角色: 'character',
  角色把握: 'charConf',
  文字: 'text',
  情绪: 'valence',
  强度: 'arousal',
  攻击: 'aggression',
  亲密: 'intimacy',
  抽象: 'absurdity',
  指向: 'target',
  场景: 'scene',
  名字: 'name',
  一句话: 'summary',
  外观: 'appearance',
}

/** 系统提示词：固定锚点，保证多次评分口径一致 */
export function buildSystemPrompt(characters = []) {
  const list = characters.length
    ? [
        '【本库已知角色】只能从这份名单里选，不要编造名单外的名字；不在名单里写「未知」并在描述里写清外观。',
        ...characters.slice(0, 40).map((c) => `- ${c.name}${c.look ? `：${c.look}` : ''}`),
      ].join('\n')
    : '【本库尚无角色名单】角色一律写「未知」，并在描述里写清外观。'

  return [
    '你给表情包做标注。只输出规定格式的行，不要解释、不要 Markdown、不要寒暄。',
    '',
    list,
    '',
    '每个维度都是 0~1 的小数（情绪是 -1~1），按下述锚点判断：',
    '情绪valence：-1 非常难过/崩溃，0 中性，1 非常开心',
    '强度arousal：0 平静静态，0.5 一般，1 爆发夸张',
    '攻击aggression：0 温和无害，0.5 轻微调侃，1 打人骂人见血',
    '亲密intimacy：0 疏离公事，0.5 普通朋友，1 撒娇贴贴',
    '抽象absurdity：0 正经写实，0.5 轻微夸张，1 纯梗图无厘头',
    `指向target：只能填 ${TARGETS.join(' / ')}`,
    `场景scene：从 ${SCENES.join('、')} 里选 0~3 个，逗号分隔`,
    '文字text：图上真实出现的文字；没有就写「无」，不要猜。',
    '外观appearance：只写看得见的特征——发色发型、服装、配饰、物种/动物特征、图形元素，不超过 30 字；不要写情绪、不要猜身份。',
    '名字name：不超过 12 个字的短名，要能让人一眼想起这张图。',
    '一句话summary：不超过 20 字，描述画面在表达什么。',
  ].join('\n')
}

/** 用户消息文本 */
export function buildUserText(count) {
  return [
    `请对下面 ${count} 张图**逐张**输出。每张以一行「帧: N」开头（N 从 1 开始），紧接着这些行：`,
    '角色 / 角色把握 / 文字 / 外观 / 情绪 / 强度 / 攻击 / 亲密 / 抽象 / 指向 / 场景 / 名字 / 一句话',
    '',
    '示例：',
    '帧: 1',
    '角色: 未知',
    '角色把握: 低',
    '文字: 无所谓 反正我不要脸',
    '外观: 灰白短发、黑色卫衣、瘫坐在沙发上',
    '情绪: -0.2',
    '强度: 0.6',
    '攻击: 0.4',
    '亲密: 0.2',
    '抽象: 0.7',
    '指向: 自己',
    '场景: 摸鱼,日常',
    '名字: 摆烂摊手',
    '一句话: 瘫在沙发上表示无所谓',
  ].join('\n')
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** 名字是否可用：至少 2 个字，且至少含一个中文或字母（过滤 "6"、"？？" 这类垃圾值） */
export function isUsableName(s) {
  const v = String(s || '').trim()
  return v.length >= 2 && /[\u4e00-\u9fa5A-Za-z]/.test(v)
}

function num(v, lo, hi, fallback = null) {
  if (v === undefined || v === null) return fallback
  const s = String(v).trim()
  if (!s) return fallback
  const n = Number(s.replace(/[^\d.+-]/g, ''))
  if (!Number.isFinite(n)) return fallback
  return Math.round(clamp(n, lo, hi) * 100) / 100
}

/**
 * 解析模型输出。容忍中英文冒号、多余空格、缺失字段。
 * @returns {Array<object>} 按帧号排序的结果
 */
export function parseAnalysis(raw) {
  const text = String(raw || '')
  const marks = [...text.matchAll(/帧\s*[:：]\s*(\d+)/g)]
  if (!marks.length) return []

  const out = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length
    const body = text.slice(start, end)
    const f = { index: Number(marks[i][1]) }

    for (const line of body.split(/\r?\n/)) {
      const m = /^\s*([^:：]+)\s*[:：]\s*(.*)$/.exec(line)
      if (!m) continue
      const key = FIELD_ALIASES[m[1].trim()]
      if (!key) continue
      f[key] = m[2].trim()
    }

    const score = {}
    for (const k of SCORE_KEYS) score[k] = num(f[k], k === 'valence' ? -1 : 0, 1, null)

    const name = (() => {
      const raw = String(f.name || '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      if (isUsableName(raw)) return raw
      const alt = String(f.summary || '').replace(/[「」"'“”]/g, '').trim().slice(0, 12)
      return isUsableName(alt) ? alt : ''
    })()
    const target = TARGETS.includes(String(f.target || '').trim()) ? String(f.target).trim() : '无'
    const scene = String(f.scene || '')
      .split(/[,，/\s]+/)
      .map((s) => s.trim())
      .filter((s) => SCENES.includes(s))
      .slice(0, 3)
      .join(',')
    const text0 = String(f.text || '').trim()
    const charConf = ['高', '中', '低'].includes(String(f.charConf || '').trim()) ? String(f.charConf).trim() : '低'
    const character = String(f.character || '').trim() === '未知' ? '' : String(f.character || '').trim().slice(0, 20)

    out.push({
      index: f.index,
      score,
      target,
      scene,
      text: text0 && text0 !== '无' ? text0.slice(0, 100) : '',
      appearance: String(f.appearance || '').replace(/^无$/, '').slice(0, 60),
      character,
      charConf,
      name,
      summary: String(f.summary || '').slice(0, 40),
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

/** 一次调用：把若干张图交给模型 */
export async function callModel(ctx, { images, characters }) {
  const attachments = ctx.attachments
  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (!selection?.provider || !selection?.model) throw new Error('拿不到默认模型')

  const parts = [{ type: 'text', text: buildUserText(images.length) }]
  for (const img of images) {
    parts.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'meme' })
  }
  const admitted = await attachments.admitPromptContent(parts)

  const stream = ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    system: buildSystemPrompt(characters),
    messages: [{ role: 'user', content: admitted }],
    temperature: 0,
    maxTokens: 4000,
  })

  let text = ''
  let failure = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') failure = chunk.reason.failure
      else if (chunk.reason.kind === 'max-tokens') failure = { message: '输出被截断（max-tokens）' }
      else if (chunk.reason.kind === 'aborted') failure = { message: '请求被中止' }
    }
  }
  if (failure) throw new Error(failure.message || failure.code || '模型调用失败')
  return text
}

/** 是否为占位名（导入时留下的 动图12 / 表情3） */
export const isPlaceholderName = (name) => !name || /^(动图|表情)\d+$/.test(String(name).trim())

/**
 * 批量分析。
 * @param {object} ctx 宿主上下文（需 attachments / llm / agentDefaultModel）
 * @param {object} index SQLite
 * @param {{limit?:number, force?:boolean, batchSize?:number, md5?:string, onProgress?:Function}} opts
 */
export async function runAnalyze(ctx, index, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 10))
  const batchSize = Math.max(1, Math.min(6, Number(opts.batchSize) || 4))
  const force = Boolean(opts.force)
  const includePinned = Boolean(opts.includePinned)

  const skipped = []
  let rows
  if (opts.md5) {
    rows = [db.findByPrefix(index, opts.md5).row].filter(Boolean)
    // 指定单张时也要尊重人工锁定，但要说清楚为什么没跑（不能静默跳过）
    rows = rows.filter((row) => {
      if (!row.pinned || includePinned) return true
      skipped.push({ md5: row.md5, message: '已人工锁定，跳过（确实要重跑加 --include-pinned）' })
      return false
    })
  } else {
    const conds = []
    const params = []
    if (!force) conds.push('analyzed_at IS NULL')
    if (!includePinned) conds.push('pinned = 0')
    if (opts.appearance) {
      conds.push('appearance LIKE ?')
      params.push(`%${opts.appearance}%`)
    }
    if (opts.name) {
      conds.push('name LIKE ?')
      params.push(`%${opts.name}%`)
    }
    const where = conds.length ? conds.join(' AND ') : '1 = 1'
    rows = index.prepare(`SELECT * FROM items WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit)
  }

  const characters = characterTable.promptList()
  const model = ctx.agentDefaultModel?.currentSelection?.()?.model || ''
  const result = { total: rows.length, ok: 0, failed: [], named: 0, skipped }

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize)
    const images = []
    const usable = []
    for (const row of chunk) {
      try {
        images.push({ data: readFileSync(absPath(row.path)).toString('base64'), mediaType: MIME[row.ext] || 'image/jpeg', md5: row.md5 })
        usable.push(row)
      } catch (error) {
        result.failed.push({ md5: row.md5, message: `读文件失败：${error.message}` })
      }
    }
    if (!images.length) continue

    let parsed
    try {
      const raw = await callModel(ctx, { images, characters })
      parsed = parseAnalysis(raw)
      if (!parsed.length) throw new Error('模型输出里没有可解析的「帧: N」')
    } catch (error) {
      for (const row of usable) {
        result.failed.push({ md5: row.md5, message: error.message })
        db.addEvent(index, { md5: row.md5, action: 'analyze_failed', detail: error.message })
      }
      continue
    }

    usable.forEach((row, k) => {
      const a = parsed.find((p) => p.index === k + 1) || parsed[k]
      if (!a) {
        result.failed.push({ md5: row.md5, message: '缺少该帧的结果' })
        return
      }
      // 角色名先规范化：剥掉「（梗模板）」这类后缀、对齐别名；对不上就记未知
      const charName = characterTable.normalizeName(a.character)
      const patch = {
        score: JSON.stringify(a.score),
        scene: a.scene || null,
        target: a.target || null,
        appearance: a.appearance || null,
        text: a.text || null,
        character: charName || null,
        char_conf: charName ? a.charConf : '低',
        analyzed_at: Date.now(),
        model,
      }
      if ((isPlaceholderName(row.name) || opts.rename) && a.name) patch.name = a.name
      db.updateItem(index, row.md5, patch)
      if (patch.name) result.named++
      result.ok++
    })

    opts.onProgress?.(Math.min(i + batchSize, rows.length), rows.length)
  }

  db.addEvent(index, {
    action: 'analyze',
    detail: JSON.stringify({ ok: result.ok, failed: result.failed.length, skipped: skipped.length, model }),
  })
  return result
}
