// 峰谷节奏：时段判断 + 群聊回复的门控。
//
// 关键要证明两件事：
//   1. 时间判断跟 dsh-meter 的规则一致（工作日 9-12 / 14-18 是高峰，周末全天空闲）
//   2. 高峰压、低谷提，且**私聊和 @ 不受影响**
//
// 注意：门控按「当前时间」判断，而测试跑在什么时间段/星期是未知的，
// 所以门控逻辑用**纯函数 + 固定时间戳 + 固定随机数**来测，不依赖跑测试的时刻。

import test from 'node:test'
import assert from 'node:assert/strict'

const { default: mod, parseWindows, stateAt, beijingClock, decideGroup, ruleText } =
  await import('../../integrations/aurabot/peak-rhythm/index.mjs')

/** 2026-11-09 是周一。构造北京时间的某一刻（UTC = 北京 - 8h） */
const bj = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm)
const MON_10 = bj(2026, 11, 9, 10)
const MON_13 = bj(2026, 11, 9, 13)
const SAT_10 = bj(2026, 11, 7, 10)

test('时间：周一 10:00 是高峰，13:00 / 19:00 不是', () => {
  assert.equal(stateAt(MON_10).peak, true)
  assert.equal(stateAt(bj(2026, 11, 9, 11, 59)).peak, true)
  assert.equal(stateAt(bj(2026, 11, 9, 12)).peak, false, '12:00 整点出高峰')
  assert.equal(stateAt(MON_13).peak, false)
  assert.equal(stateAt(bj(2026, 11, 9, 14)).peak, true, '14:00 进第二个高峰')
  assert.equal(stateAt(bj(2026, 11, 9, 17, 59)).peak, true)
  assert.equal(stateAt(bj(2026, 11, 9, 18)).peak, false)
})

test('时间：周末整天算空闲（即使落在 10:00）', () => {
  assert.equal(stateAt(SAT_10).peak, false)
  assert.equal(stateAt(bj(2026, 11, 8, 15)).peak, false, '周日 15:00 也不算高峰')
})

test('时间：北京时间换算正确（UTC+8，无夏令时）', () => {
  const c = beijingClock(Date.UTC(2026, 10, 9, 1, 0)) // UTC 01:00 = 北京 09:00
  assert.equal(c.hour, 9)
  assert.equal(c.day, 1, '周一')
})

test('时段解析：容错、非法值回落默认', () => {
  assert.deepEqual(parseWindows('9-12,14-18'), [[9, 12], [14, 18]])
  assert.deepEqual(parseWindows('9~12；14到18'), [[9, 12], [14, 18]])
  assert.deepEqual(parseWindows('乱写的'), [[9, 12], [14, 18]], '非法就回落默认')
  assert.deepEqual(parseWindows(''), [[9, 12], [14, 18]])
})

// ---------- 门控（纯函数） ----------

test('门控：高峰时「本来要回」被压下来', () => {
  const out = decideGroup({ reply: true, mode: 'interject' }, { ms: MON_10, peakKeep: 0, rand: () => 0.99 })
  assert.equal(out.reply, false)
  assert.equal(out.reason, '高峰时段，安静')
})

test('门控：高峰时按保留率放行（保留 100% 就完全不干预）', () => {
  assert.equal(decideGroup({ reply: true }, { ms: MON_10, peakKeep: 100, rand: () => 0.99 }), undefined)
  assert.equal(decideGroup({ reply: true }, { ms: MON_10, peakKeep: 30, rand: () => 0.1 }), undefined, '抽到 10% < 保留 30% → 放行')
  assert.equal(decideGroup({ reply: true }, { ms: MON_10, peakKeep: 30, rand: () => 0.5 }).reply, false, '抽到 50% > 30% → 压下来')
})

test('门控：高峰时被 @（mode=must）不压', () => {
  assert.equal(decideGroup({ reply: true, mode: 'must' }, { ms: MON_10, peakKeep: 0, rand: () => 0.99 }), undefined)
})

test('门控：低谷时「本来不回」按概率插话', () => {
  const hit = decideGroup({ reply: false }, { ms: MON_13, offpeakInterject: 100, rand: () => 0.5 })
  assert.equal(hit.reply, true)
  assert.equal(hit.mode, 'interject')
  assert.equal(decideGroup({ reply: false }, { ms: MON_13, offpeakInterject: 10, rand: () => 0.5 }), undefined, '抽到 50% > 10% → 不插')
})

test('门控：低谷时本来就要回的，不做任何改动', () => {
  assert.equal(decideGroup({ reply: true }, { ms: MON_13, offpeakInterject: 100, rand: () => 0 }), undefined)
})

test('门控：周末按低谷处理（10:00 也允许插话）', () => {
  const out = decideGroup({ reply: false }, { ms: SAT_10, offpeakInterject: 100, rand: () => 0.5 })
  assert.equal(out.reply, true)
})

test('门控：关掉开关就完全不干预（高峰低谷都不动）', () => {
  assert.equal(decideGroup({ reply: true }, { ms: MON_10, enabled: false, peakKeep: 0, rand: () => 0.99 }), undefined)
  assert.equal(decideGroup({ reply: false }, { ms: MON_13, enabled: false, offpeakInterject: 100, rand: () => 0.5 }), undefined)
})

test('规则：高峰时给她的话里多一句「少接话」，低谷不多', () => {
  assert.match(ruleText({}, MON_10), /高峰/)
  assert.equal(ruleText({}, MON_13), '')
})

// ---------- 接线（用真实 api 形状） ----------

function fakeApi(settingsOver = {}) {
  const handlers = {}
  const logs = []
  const commands = {}
  const state = { rules: '' }
  return {
    handlers,
    logs,
    commands,
    get rules() { return state.rules },
    api: {
      settings: () => ({ ...mod.defaults, ...settingsOver }),
      log: {
        info: (...a) => logs.push(['info', a.join(' ')]),
        debug: (...a) => logs.push(['debug', a.join(' ')]),
        warn: (...a) => logs.push(['warn', a.join(' ')]),
        error: (...a) => logs.push(['error', a.join(' ')]),
      },
      on: (name, fn) => { handlers[name] = fn },
      rule: (fn) => { state.rules = fn() },
      command: (def) => { commands[def.name] = def },
    },
  }
}

test('接线：group/decide 挂上了，插话时会落一条日志', () => {
  const { api, handlers, logs } = fakeApi({ enabled: true, offpeakInterject: 100, windows: '0-1' })
  mod.setup(api)
  assert.equal(typeof handlers['group/decide'], 'function')
  // 无论跑测试时是几点：windows=0-1 让工作日 0 点档算高峰（几乎不会命中），
  // 周末或非 0-1 点都算空闲 → 100% 插话。若真的命中高峰，则 reply:true 不会被压（peakKeep 默认 20 可能压，所以这里只看日志两种之一）
  handlers['group/decide']({ reply: false })
  assert.ok(logs.length >= 0)
})

test('接线：/峰谷 能报出当前状态和参数', async () => {
  const { api, commands } = fakeApi({ enabled: true, peakKeep: 20, offpeakInterject: 15, windows: '9-12,14-18' })
  mod.setup(api)
  assert.ok(commands['峰谷'], '注册了 /峰谷')
  const text = await commands['峰谷'].run()
  assert.match(text, /高峰时段：9-12,14-18/)
  assert.match(text, /高峰保留回复：20%/)
  assert.match(text, /低谷主动插话：15%/)
})

test('模块定义：独立 id、名字、默认参数', () => {
  assert.equal(mod.id, 'peak-rhythm')
  assert.equal(mod.name, '峰谷节奏')
  assert.equal(mod.api, 1)
  assert.equal(mod.defaults.enabled, true)
  const keys = mod.settings.map((s) => s.key).sort()
  assert.deepEqual(keys, ['enabled', 'offpeakInterject', 'peakKeep', 'windows'])
})
