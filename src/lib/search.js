// 检索层：把「人话」翻译成索引查询，并按相关度排序。
//
// 为什么要单独一层：QQ 里的她、DSH 里的 agent、命令行的 /meme find 都要用同一套判断。
// 如果各自写一份 LIKE，三处结果就会不一致——那是这个项目最不能接受的失败方式。
//
// 两类信号：
//   1. 硬条件（角色 / 关键词 / 场景）—— SQL 过滤，命中就是命中
//   2. 软条件（情绪）—— 五维分数上的距离，越小越像
// 名字/标签/外观/图上文字都算关键词：这张图叫什么、写了什么，往往比分数更能说明用途。

import { queryItems } from './db.js'

/**
 * 情绪词 → 五维画像（0~1，情绪是 -1~1）。
 * 故意保持小表：宁可认不出（那就当没有情绪条件），也不要瞎猜。
 */
export const EMOTIONS = {
  生气: { aggression: 0.8, valence: -0.5 },
  愤怒: { aggression: 0.9, valence: -0.7 },
  火大: { aggression: 0.85, valence: -0.6 },
  开心: { valence: 0.8, arousal: 0.5 },
  高兴: { valence: 0.8, arousal: 0.5 },
  快乐: { valence: 0.8, arousal: 0.5 },
  大笑: { valence: 0.9, arousal: 0.85 },
  笑: { valence: 0.7, arousal: 0.5 },
  委屈: { valence: -0.6, arousal: 0.2 },
  难过: { valence: -0.8, arousal: 0.2 },
  哭: { valence: -0.8, arousal: 0.5 },
  无语: { valence: -0.2, absurdity: 0.6 },
  抽象: { absurdity: 0.9 },
  震惊: { arousal: 0.9, valence: 0 },
  害怕: { valence: -0.5, arousal: 0.7 },
  嘲讽: { aggression: 0.6, absurdity: 0.6 },
  阴阳: { aggression: 0.5, absurdity: 0.5 },
  撒娇: { intimacy: 0.9, valence: 0.5 },
  可爱: { intimacy: 0.7, valence: 0.6 },
  亲密: { intimacy: 0.9 },
  摆烂: { arousal: 0.1, valence: -0.2 },
  累: { arousal: 0.1, valence: -0.4 },
  平静: { arousal: 0.1 },
}

export const EMOTION_WORDS = Object.keys(EMOTIONS)

/**
 * 从一段话里认出情绪词。返回第一个命中的（长词优先，避免「笑」抢在「大笑」前面）。
 * @returns {{word: string, profile: object} | null}
 */
export function resolveEmotion(text) {
  const s = String(text || '').trim()
  if (!s) return null
  const words = [...EMOTION_WORDS].sort((a, b) => b.length - a.length)
  for (const w of words) {
    if (s.includes(w)) return { word: w, profile: EMOTIONS[w] }
  }
  return null
}

/** 五维距离：0 = 完全吻合，1 = 差到天边。只算目标里给出的维度。 */
export function emotionDistance(score, profile) {
  if (!score || !profile) return 1
  let sum = 0
  let n = 0
  for (const [key, want] of Object.entries(profile)) {
    const got = score[key]
    if (typeof got !== 'number' || !Number.isFinite(got)) continue
    const span = key === 'valence' ? 2 : 1 // 情绪是 -1~1，跨度是别人两倍
    sum += ((got - want) / span) ** 2
    n += 1
  }
  return n ? Math.sqrt(sum / n) : 1
}

/** 关键词命中在哪些字段（给自己看，也让工具能解释「为什么是这张」） */
export function hitFields(row, keyword) {
  const k = String(keyword || '').trim()
  if (!k) return []
  const out = []
  const has = (field, value) => value && String(value).includes(k) && out.push(field)
  has('name', row.name)
  has('tags', row.tags)
  has('text', row.text)
  has('appearance', row.appearance)
  has('character', row.character)
  return out
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/** 库里出现过的角色名（按张数倒序）。用来把「大肥鱼」从关键词里认出来 */
function charactersIn(index) {
  return index
    .prepare(`SELECT character AS name, COUNT(*) AS n FROM items
              WHERE character IS NOT NULL AND character <> ''
              GROUP BY character ORDER BY n DESC`)
    .all()
    .map((r) => String(r.name))
}

/** 去掉中文里对 LIKE 没意义的「的」和多余空格 */
const cleanKeyword = (s) => String(s || '')
  .replace(/^的+/, '')
  .replace(/的+$/, '')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * 检索表情。
 *
 * @param {object} index SQLite
 * @param {{keyword?:string, character?:string, emotion?:string, scene?:string, limit?:number}} opts
 *        keyword 也可以是「生气的大肥鱼」这种整句——会拆成情绪词 + 角色 + 其余关键词
 * @returns {{items: Array<object>, total: number, used: object}}
 */
export function search(index, opts = {}) {
  const limit = clampInt(opts.limit, 1, 20, 6)
  let keyword = String(opts.keyword || '').trim()
  let character = String(opts.character || '').trim()
  let emotion = opts.emotion ? resolveEmotion(opts.emotion) : null

  // 1) 先从整句里认情绪词：「生气的大肥鱼」→ 情绪=生气
  if (!emotion && keyword) {
    const hit = resolveEmotion(keyword)
    if (hit) {
      emotion = hit
      keyword = keyword.replace(hit.word, '')
    }
  }

  // 2) 再认角色：「大肥鱼生气」→ 角色=大肥鱼。不认这一步的话，
  //    「大肥鱼」会被当成文字关键词，只匹配名字里带这三个字的图，把同角色的其他图全漏掉。
  if (!character && keyword) {
    const names = charactersIn(index).sort((a, b) => b.length - a.length)
    const hit = names.find((n) => n && keyword.includes(n))
    if (hit) {
      character = hit
      keyword = keyword.replace(hit, '')
    }
  }

  keyword = cleanKeyword(keyword)

  const { rows, total } = queryItems(index, {
    q: keyword || undefined,
    character: character || undefined,
    scene: opts.scene || undefined,
    limit: 500,
    sort: 'newest',
  })

  const scored = rows.map((row) => {
    let score = null
    try {
      score = row.score ? JSON.parse(row.score) : null
    } catch {
      score = null
    }
    const fields = hitFields(row, keyword)
    // 名字命中 > 标签/文字 > 外观：名字就是这张图的用途
    const fieldBoost = fields.includes('name') ? 0.25 : fields.length ? 0.1 : 0
    const dist = emotion ? emotionDistance(score, emotion.profile) : null
    const relevance = emotion ? (1 - dist) + fieldBoost : (fields.length ? 1 : 0.5) + fieldBoost
    return { row, score, fields, dist, relevance }
  })

  // 排序必须确定：同分时先按入库时间新→旧，再按 md5。
  // 只按 relevance 排会在「同分」时落到 SQL 的并列顺序上——SQLite 对 ORDER BY 并列
  // 不保证顺序，Windows 和 Linux 可能不一样（同一句查询两个结果，检索层不能这样）。
  scored.sort((a, b) =>
    b.relevance - a.relevance
    || (Number(b.row.created_at) || 0) - (Number(a.row.created_at) || 0)
    || String(a.row.md5).localeCompare(String(b.row.md5)))
  const picked = scored.slice(0, limit)

  return {
    items: picked.map(({ row, score, fields, dist, relevance }) => ({
      md5: row.md5,
      name: row.name || '',
      character: row.character || '',
      tags: row.tags || '',
      appearance: row.appearance || '',
      text: row.text || '',
      scene: row.scene || '',
      score,
      path: row.path,
      fields,
      emotionDistance: dist === null ? null : Math.round(dist * 100) / 100,
      relevance: Math.round(relevance * 100) / 100,
    })),
    total,
    scanned: rows.length,
    used: {
      keyword: keyword || null,
      character: character || null,
      emotion: emotion ? emotion.word : null,
      scene: opts.scene || null,
    },
  }
}
