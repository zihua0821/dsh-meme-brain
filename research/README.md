# research · 立项前的验证脚本

这些脚本**不是产品代码**，是立项前用来验证关键假设的一次性实验。保留它们是因为：

1. 它们产出的数据是设计决策的依据（见 [架构文档附录](../docs/02-architecture.md#附录--已核实事实)）；
2. 它们可以直接改写成 M1 的单元测试（判定阈值、透明处理、多帧比较）；
3. 将来评审"算法要不要改"时，重跑一遍就能对比。

> **注意**：脚本里的默认路径指向立项时那台机器上的 Aurabot 旧库
> （`plugins-data/aurabot/stickers/`）。那份库已经不在本项目里了，换台机器跑要改脚本顶部的常量。
> 这些结论写在 `docs/02-architecture.md` 的附录和 ADR 里，脚本只是证据来源。

## 准备

```powershell
cd research
npm install jpeg-js pngjs gifuct-js
```

脚本默认读取：
- Aurabot 旧库：`%USERPROFILE%\.dsh\plugins-data\aurabot\stickers\`
- dsh-meme 包：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-meme\memes\dafeiyu-001\memes\`

换路径需改脚本顶部的常量。

## 脚本清单

| 脚本 | 作用 | 结论 |
|---|---|---|
| `scan.mjs` | 全库 dHash，输出重复簇 | 141 张中 1 组重复（摆烂摊手 ↔ 摆烂式，距离 0） |
| `dist.mjs` | 两两距离分布 | 真重复 0，最近非重复 11 → 阈值 8 有 3 位余量 |
| `alpha.mjs` | 透明通道对哈希的影响 | 74 张 GIF 中 6 张带 alpha，不合成白底最多偏 27 位 |
| `formats.mjs` | 按魔数统计格式与帧数 | GIF 73 / JPEG 58 / PNG 9 / 单帧 GIF 1 / WebP 0 |
| `cross-scan.mjs` | 两个库之间判重 | 0 对重叠 → 两库互补 |
| `bench-gif.mjs` | 大 GIF 解码耗时 | 最大 5 张 121–245ms |
| `demo-dhash.mjs` | dHash 原理可视化（打印 9×8 灰度与比特） | 用于向人解释算法 |
| `sticker-dedup-test.mjs` | 单对图片的距离对比 | 同一图重压后距离 = 0 |

## 与产品代码的关系

M1 实现 `parse.js` / `dhash.js` / `dedupe.js` 时，应把这些脚本里的逻辑**重写为带测试的函数**，并把 `scan.mjs` 的重复簇输出作为回归基线：

> 给定当前库快照，`dedupe` 必须仍然只报出那一组「摆烂」重复。

不要直接在 `src/` 里 import 这些脚本——它们是过程中的产物，不是模块。
