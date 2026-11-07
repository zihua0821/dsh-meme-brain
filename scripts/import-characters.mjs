// 角色表批量导入：网络表情包文化里成型的「角色 / 梗模板」。
//
// 为什么是一个脚本而不是手工敲 N 遍 /meme char add：
//   1. 可重复执行（upsert 幂等），以后加人就在数组里加一条再跑
//   2. 角色表是**闭集**——名单越长，模型越容易把「像的」认成「就是」。
//      所以每条 look 都写成**排他性特征**（「真实白猫」而不是「猫」），
//      宁可写「不像什么」也不写含糊的。
//   3. 出处/别名一起写进去，别名能在人工输入时自动对齐（matchExact）
//
// 用法：node scripts/import-characters.mjs [--dry]
//
// 依据（2026-11-07 检索）：
//   - 萌娘百科「斗图」分类：熊猫头 / 蘑菇头 / doge / gif / 中老年表情包
//   - 「亚洲表情三巨头」：金馆长、姚明、花泽香菜
//   - 常见吉祥物：乖巧宝宝、长草颜团子、流泪猫猫头（Luhu）、兔斯基、阿狸、绿豆蛙

import * as characterTable from '../src/lib/characters.js'

const dry = process.argv.includes('--dry')

/** kind: character = 有固定形象的角色；meme = 模板/梗（提示词里会标「（梗模板）」） */
const ENTRIES = [
  // ---------- 有固定形象的吉祥物 ----------
  {
    name: '乖巧宝宝',
    kind: 'character',
    look: '白色大头娃娃、圆脑袋、小黑点眼睛、小嘴或没嘴，常做无辜或贱萌表情；不是动物',
    from: '微信表情（作者 小混蛋）',
    aka: ['乖巧宝宝表情'],
  },
  {
    name: '流泪猫猫头',
    kind: 'character',
    look: '真实白猫仰头、眼睛含泪或像在哭（其实是打哈欠）、常配「我裂开了」类文字；不是卡通猫',
    from: '猫 Luhu',
    aka: ['哭泣猫猫', '流泪猫猫', '哭唧唧猫'],
  },
  {
    name: '长草颜团子',
    kind: 'character',
    look: '白色圆团子身体、头顶一根绿草、眯眼笑、没手没脚；比乖巧宝宝更圆更小',
    from: 'LINE 表情包',
    aka: ['颜团子', '长草团子'],
  },
  {
    name: '兔斯基',
    kind: 'character',
    look: '白色兔子、细长面条状四肢、小眼睛、动作夸张扭曲；不是写实兔子',
    from: '王卯卯',
    aka: ['Tuski', '兔斯基表情'],
  },
  {
    name: '阿狸',
    kind: 'character',
    look: '红色小狐狸、白肚皮、尖耳朵、大眼、三条白尾巴；治愈系画风',
    from: 'Hans',
    aka: ['Ali', '阿狸狐狸'],
  },
  {
    name: '绿豆蛙',
    kind: 'character',
    look: '绿色青蛙、圆胖身体、大眼睛、常配丧气文字（不想上班等）',
    from: '台湾卡通',
    aka: ['绿豆蛙Leon', 'Leon'],
  },
  {
    name: '罗小黑',
    kind: 'character',
    look: '黑色小猫、圆圆大眼、简笔线条、尾巴细长；不是照片猫',
    from: '罗小黑战记',
    aka: ['小黑'],
  },
  {
    name: '吾皇',
    kind: 'character',
    look: '胖白猫、半眯眼、面无表情、常和黑猫（巴扎黑）同框；真实感插画猫',
    from: '吾皇巴扎黑',
    aka: ['吾皇猫', '巴扎黑'],
  },

  // ---------- 模板头 / 梗符号 ----------
  {
    name: '蘑菇头',
    kind: 'meme',
    look: '黑色蘑菇状发型的大头人形、五官夸张扭曲、常被P上真人表情；是模板不是具体角色',
    from: '表情包模板（作者 阿狸爸爸）',
    aka: ['蘑菇头表情'],
  },
  {
    name: '简笔小人',
    kind: 'meme',
    look: '纯黑白简笔线条人、无五官细节、靠姿势和文字表意；火柴人属于这一类',
    from: '网络梗',
    aka: ['火柴人', '线条小人', '简笔画小人'],
  },
  {
    name: '滑稽',
    kind: 'meme',
    look: '黄色圆脸、眼睛斜视一侧、嘴角上扬、贴吧默认表情；和暴漫贱笑不同的扁平圆脸',
    from: '百度贴吧',
    aka: ['滑稽脸', '贴吧滑稽'],
  },
  {
    name: '暴漫脸',
    kind: 'meme',
    look: '黑白手绘人脸、粗黑线条、夸张咧齿笑或大哭；暴走漫画/暴漫风格',
    from: '暴走漫画',
    aka: ['暴漫', 'Trollface', '暴走漫画'],
  },
  {
    name: '中老年表情包',
    kind: 'meme',
    look: '高饱和背景、大号彩色字、鲜花爱心边框，常配「为我们的友谊干杯」；是风格不是角色',
    from: '微信',
    aka: ['中老年', '友谊干杯'],
  },

  // ---------- 真人表情（三巨头起家） ----------
  {
    name: '金馆长',
    kind: 'meme',
    look: '亚洲男性大笑脸、眼睛眯成缝、张嘴露牙，常被P到熊猫头等模板上',
    from: '崔成国（韩国演员）',
    aka: ['崔成国', '金馆长笑'],
  },
  {
    name: '姚明',
    kind: 'meme',
    look: '亚洲男性高个、憨笑脸、常简化为黑白线稿或剪影',
    from: '姚明',
    aka: ['姚明脸', '姚明笑'],
  },
  {
    name: '花泽香菜',
    kind: 'meme',
    look: '日本女性声优笑脸、齐刘海长发、常被做成黑白线稿',
    from: '花泽香菜',
    aka: ['香菜笑', '香菜'],
  },
  {
    name: '黑人问号',
    kind: 'meme',
    look: '黑人男性疑惑表情、画面常带问号符号、多为视频截图（不是贴图模板）',
    from: '尼克·杨 Nick Young',
    aka: ['问号脸', '尼克杨', 'Nick Young'],
  },
  {
    name: '张学友',
    kind: 'meme',
    look: '亚洲男性、表情凶狠逼近镜头，常配「吔屎啦你」文字',
    from: '旺角卡门',
    aka: ['吔屎啦你', '乌蝇哥'],
  },
  {
    name: '斯巴达',
    kind: 'meme',
    look: '电影《300》斯巴达战士、半裸肌肉、头盔、怒吼张嘴',
    from: '300 勇士',
    aka: ['斯巴达勇士', '300'],
  },

  // ---------- 国际 meme 符号（QQ 里也常见） ----------
  {
    name: 'doge',
    kind: 'character',
    look: '真实柴犬、侧头斜眼、嘴角上翘，常被贴彩色 Comic Sans 字；不是哈士奇',
    from: '柴犬 Kabosu',
    aka: ['狗头', '柴犬', '神烦狗'],
  },
  {
    name: 'cheems',
    kind: 'character',
    look: '真实柴犬、圆胖体型、表情呆滞、常配拼写错误的英文；和 doge 不是同一只',
    from: '网络梗（Balltze）',
    aka: ['球球柴犬', '小废柴'],
  },
  {
    name: 'Pepe',
    kind: 'character',
    look: '绿色拟人青蛙、大眼睛、站立姿态、表情悲伤或得意；不是绿豆蛙',
    from: 'Pepe the Frog',
    aka: ['悲伤蛙', '佩佩蛙', '青蛙Pepe'],
  },
]

const rows = ENTRIES.map((e) => ({ ...e, source: 'builtin' }))

if (dry) {
  console.log(`将要导入 ${rows.length} 条：`)
  for (const r of rows) console.log(`  ${r.name}  [${r.kind}]  ${r.look.slice(0, 30)}…`)
  process.exit(0)
}

const before = characterTable.list().length
for (const r of rows) {
  characterTable.upsert(r)
}
const after = characterTable.list()

console.log(`角色表：${before} → ${after.length} 条（本次写入 ${rows.length}）`)
console.log('')
for (const c of after) {
  console.log(`  ${c.name}${c.kind === 'meme' ? '（梗模板）' : ''}${c.aka?.length ? `  aka: ${c.aka.join('/')}` : ''}`)
}
console.log('')
console.log(`提示词里会带 ${characterTable.promptList().length} 条（analyze 注入上限 40）`)
