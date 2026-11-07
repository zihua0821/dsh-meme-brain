// 分析模块的纯函数测试（不调用模型）
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseAnalysis, buildSystemPrompt, buildUserText, isPlaceholderName, isUsableName, SCENES } from '../../src/lib/analyze.js'

const SAMPLE = [
  '帧: 1',
  '角色: 未知',
  '角色把握: 低',
  '文字: 无所谓 反正我不要脸',
  '情绪: -0.2',
  '强度: 0.65',
  '攻击: 0.4',
  '亲密: 0.15',
  '抽象: 0.7',
  '指向: 自己',
  '场景: 摸鱼,日常',
  '名字: 「摆烂摊手」',
  '一句话: 瘫在沙发上表示无所谓',
  '',
  '帧: 2',
  '角色: 凯露',
  '角色把握: 高',
  '文字: 无',
  '情绪: 0.9',
  '强度: 1.2',
  '攻击: -0.3',
  '亲密: 0.5',
  '抽象: 0.2',
  '指向: 对方',
  '场景: 吃饭',
  '名字: 凯露干饭',
  '一句话: 抱着碗猛吃',
].join('\n')

test('解析：两帧、字段齐全', () => {
  const r = parseAnalysis(SAMPLE)
  assert.equal(r.length, 2)

  assert.equal(r[0].index, 1)
  assert.equal(r[0].character, '')
  assert.equal(r[0].charConf, '低')
  assert.equal(r[0].text, '无所谓 反正我不要脸')
  assert.equal(r[0].target, '自己')
  assert.equal(r[0].scene, '摸鱼,日常')
  assert.equal(r[0].name, '摆烂摊手', '应去掉书名号')
  assert.equal(r[0].score.valence, -0.2)

  assert.equal(r[1].character, '凯露')
  assert.equal(r[1].charConf, '高')
  assert.equal(r[1].text, '', '「无」应归一成空')
  assert.equal(r[1].score.arousal, 1, '超过 1 应被夹到 1')
  assert.equal(r[1].score.aggression, 0, '负数应被夹到 0')
})

test('解析：缺字段不炸，未知值归默认', () => {
  const r = parseAnalysis('帧: 1\n名字: 只有名字\n场景: 不存在的场景\n指向: 外星人')
  assert.equal(r.length, 1)
  assert.equal(r[0].name, '只有名字')
  assert.equal(r[0].scene, '')
  assert.equal(r[0].target, '无')
  assert.equal(r[0].score.valence, null)
})

test('解析：没有「帧:」标记时返回空数组', () => {
  assert.deepEqual(parseAnalysis('抱歉，我看不出来'), [])
  assert.deepEqual(parseAnalysis(''), [])
})

test('解析：容忍中文冒号与多余空格', () => {
  const r = parseAnalysis('帧：3\n情绪 ：0.5\n名字：  测试  ')
  assert.equal(r.length, 1)
  assert.equal(r[0].index, 3)
  assert.equal(r[0].score.valence, 0.5)
  assert.equal(r[0].name, '测试')
})

test('占位名识别', () => {
  assert.equal(isPlaceholderName('动图41'), true)
  assert.equal(isPlaceholderName('表情3'), true)
  assert.equal(isPlaceholderName(''), true)
  assert.equal(isPlaceholderName('猫猫抱碗'), false)
})

test('垃圾名字被拒：单字符、纯数字、纯符号', () => {
  assert.equal(isUsableName('6'), false)
  assert.equal(isUsableName('？？'), false)
  assert.equal(isUsableName('1234'), false)
  assert.equal(isUsableName('猫'), false, '单字太短')
  assert.equal(isUsableName('猫猫'), true)
  assert.equal(isUsableName('cat'), true)
})

test('名字是垃圾时回退到一句话摘要', () => {
  const r = parseAnalysis('帧: 1\n名字: 6\n一句话: 瘫在沙发上摆烂')
  assert.equal(r[0].name, '瘫在沙发上摆烂')

  const r2 = parseAnalysis('帧: 1\n名字: 6\n一句话: 7')
  assert.equal(r2[0].name, '', '都不可用则留空，交给上层保留原名')
})

test('解析出指向、场景与外观', () => {
  const r = parseAnalysis('帧: 1\n指向: 对方\n场景: 游戏,社交\n外观: 蓝绿长发、粉挑染、黑猫发箍')
  assert.equal(r[0].target, '对方')
  assert.equal(r[0].scene, '游戏,社交')
  assert.equal(r[0].appearance, '蓝绿长发、粉挑染、黑猫发箍')
})

test('外观为「无」时归一成空串', () => {
  assert.equal(parseAnalysis('帧: 1\n外观: 无')[0].appearance, '')
})

test('标签：只留闭集词表里的词，去重，最多 3 个', () => {
  const r = parseAnalysis('帧: 1\n标签: 无语, 摸鱼, 自己编的词, 无语, 生气, 吃瓜')[0]
  assert.equal(r.tags, '无语,摸鱼,生气', '去掉词表外的、去重、截到 3 个')
})

test('标签：模型写同义词不会被收进来（防止检索被拆散）', () => {
  const r = parseAnalysis('帧: 1\n标签: 无奈子, emo, 无语子')[0]
  assert.equal(r.tags, '', '词表外的同义词一律不收')
})

test('标签：逗号、顿号、斜杠、空格都能当分隔符', () => {
  assert.equal(parseAnalysis('帧: 1\n标签: 卖萌、委屈/开心 震惊')[0].tags, '卖萌,委屈,开心')
})

test('提示词把标签词表写死了（闭集，不让模型自由发挥）', () => {
  const sys = buildSystemPrompt([])
  assert.match(sys, /标签tags/)
  for (const w of ['卖萌', '无语', '嘲讽']) assert.ok(sys.includes(w), `词表里应有 ${w}`)
  assert.match(buildUserText(1), /标签: 无语,摸鱼/, '示例里也给了标签')
})

test('提示词包含锚点与场景清单', () => {
  const sys = buildSystemPrompt([])
  assert.match(sys, /情绪valence/)
  assert.match(sys, /角色一律写「未知」/)

  const withChars = buildSystemPrompt([{ name: '凯露', look: '黑发猫耳' }])
  assert.match(withChars, /凯露：黑发猫耳/)

  const user = buildUserText(3)
  assert.match(user, /下面 3 张图/)
  assert.match(user, /帧: 1/)
  for (const s of SCENES) assert.match(buildSystemPrompt([]), new RegExp(s))
})
