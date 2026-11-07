// 峰谷节奏：DeepSeek 高峰时段少说话，空闲时段活跃一点。
//
// 为什么单独一个模块：这是「聊天频率」策略，跟表情库、跟人格都无关。
// 关掉它不影响任何别的东西；别人不想用也不会被牵连。
//
// 峰谷规则和 `dsh-meter`（计价插件）保持一致：
//   - 工作日 09:00–12:00、14:00–18:00 是高峰
//   - 其余时间（含周末整天）是空闲，官方半价
//   - 时区固定 Asia/Shanghai（DeepSeek 按北京时间计费）
// 这些常量抄自 dsh-meter 的 DEEPSEEK_PEAK_WINDOWS / WEEKDAY_DAYS，
// 改那边的话这里也要改（在模块设置里可以覆盖时段，但节假日不认）。
//
// 干预点只有一个：`group/decide`——群里「这条回不回」的最终决定。
//   - 高峰：本来要回 → 按概率压下来（安静）
//   - 低谷：本来不回 → 按概率插一句（活跃）
// 私聊、被 @（mode=must）一律不干预：那是该回的话。

const DEFAULT_WINDOWS = '9-12,14-18'

/** 解析 "9-12,14-18" → [[9,12],[14,18]]；非法值回落到默认 */
export function parseWindows(text) {
  const out = []
  for (const part of String(text || '').split(/[,，;；]+/)) {
    const m = /^\s*(\d{1,2})\s*[-~到]\s*(\d{1,2})\s*$/.exec(part)
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2])
    if (a >= 0 && a < 24 && b > a && b <= 24) out.push([a, b])
  }
  return out.length ? out : parseWindows(DEFAULT_WINDOWS)
}

/**
 * 北京时间（UTC+8，无夏令时）的「小时 + 星期」。
 * 返回 hour=0..23，day=0..6（0 = 周日）
 */
export function beijingClock(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600_000)
  return { hour: d.getUTCHours(), day: d.getUTCDay() }
}

/**
 * 判断某一刻是不是高峰。
 * @returns {{peak: boolean, why: string}}
 */
export function stateAt(ms, windows = parseWindows(DEFAULT_WINDOWS)) {
  const { hour, day } = beijingClock(ms)
  const weekend = day === 0 || day === 6
  if (weekend) return { peak: false, why: '周末，空闲时段' }
  for (const [a, b] of windows) {
    if (hour >= a && hour < b) return { peak: true, why: `工作日 ${a}:00-${b}:00 高峰` }
  }
  return { peak: false, why: '工作日非高峰，空闲时段' }
}

/**
 * 群消息门控（纯函数，方便测试）。
 * @param {{reply?: boolean, mode?: string}} decision 原来的决定
 * @param {{enabled?: boolean, windows?: string, peakKeep?: number, offpeakInterject?: number, ms?: number, rand?: () => number}} opts
 * @returns {object|undefined} 要覆盖的决定，undefined = 不干预
 */
export function decideGroup(decision, opts = {}) {
  if (!decision) return undefined
  if (opts.enabled === false) return undefined
  // 被叫到必须回、正在参与话题：不动
  if (decision.mode === 'must') return undefined

  const st = stateAt(opts.ms ?? Date.now(), parseWindows(opts.windows))
  if (st.peak) {
    if (!decision.reply) return undefined
    const keep = Math.max(0, Math.min(100, Number(opts.peakKeep))) / 100
    const roll = (opts.rand ?? Math.random)()
    if (roll < keep) return undefined
    return { reply: false, reason: '高峰时段，安静', why: st.why }
  }

  if (decision.reply) return undefined
  const rate = Math.max(0, Math.min(100, Number(opts.offpeakInterject))) / 100
  const roll = (opts.rand ?? Math.random)()
  if (!(roll < rate)) return undefined
  return { reply: true, mode: 'interject', reason: '低谷时段，主动一点', why: st.why }
}

/** 高峰时给她的规则里多一句话（纯函数） */
export function ruleText(opts = {}, ms = Date.now()) {
  const st = stateAt(ms, parseWindows(opts.windows))
  if (!st.peak) return ''
  return '现在是 DeepSeek 的高峰时段，你已经把群里的插话压得很低；别人没叫你时，能不接话就不接。'
}

export default {
  id: 'peak-rhythm',
  name: '峰谷节奏',
  api: 1,
  description: 'DeepSeek 高峰时段少说话、空闲时段活跃一点（峰谷规则和计价插件一致）',
  defaults: {
    enabled: true,
    peakKeep: 20,        // 高峰时，本来要回的消息里保留多少 %
    offpeakInterject: 15, // 低谷时，本来不回的消息里额外插话多少 %
    windows: DEFAULT_WINDOWS,
  },
  settings: [
    { key: 'enabled', label: '启用峰谷节奏', type: 'switch', hint: '关掉就完全按原来的逻辑回话' },
    { key: 'peakKeep', label: '高峰时保留回复（%）', type: 'number', min: 0, max: 100, step: 5, hint: '0 = 高峰完全不回（被 @ 和私聊除外），100 = 不受影响' },
    { key: 'offpeakInterject', label: '低谷时主动插话（%）', type: 'number', min: 0, max: 100, step: 5, hint: '对「本来判定不回」的群消息额外插话的概率，0 = 不主动' },
    { key: 'windows', label: '高峰时段', type: 'text', placeholder: '9-12,14-18', hint: '按北京时间、工作日生效；格式如 9-12,14-18。周末整天算空闲' },
  ],

  setup(api) {
    const log = api.log
    const s = () => ({ ...api.settings() })

    const now = () => stateAt(Date.now(), parseWindows(s().windows))

    api.rule(() => ruleText(s()))

    api.on('group/decide', (decision) => {
      const cfg = s()
      const out = decideGroup(decision, { ...cfg })
      if (!out) return undefined
      // 只记「真的干预了」的那种，避免刷日志
      log.info(`${out.reason}（${out.why}）`)
      const { why, ...override } = out
      return override
    })

    api.command({
      name: '峰谷',
      description: '看当前峰谷状态和本模块的生效参数',
      run: async () => {
        const cfg = s()
        const st = now()
        const lines = [
          `现在：${st.peak ? '**高峰**' : '空闲（低谷）'} —— ${st.why}`,
          `高峰保留回复：${cfg.peakKeep}%　低谷主动插话：${cfg.offpeakInterject}%`,
          `高峰时段：${cfg.windows}（工作日，北京时间）　开关：${cfg.enabled === false ? '关' : '开'}`,
          st.peak ? '（现在她会尽量少说话）' : '（现在她比高峰时活跃）',
        ]
        return lines.join('\n')
      },
    })

    // 给测试和排查用：暴露纯函数
    return {
      stateAt: (ms) => stateAt(ms, parseWindows(s().windows)),
      current: now,
    }
  },
}
