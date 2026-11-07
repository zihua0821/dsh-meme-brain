# 上下文交接（2026-11-07 起稿，17:55 复核）

> 用途：上下文压缩/换会话后，读这一份就能继续干。
> 权威顺序：`docs/` 里的设计文档 > 本文 > 代码注释。

---

## 0. 复核快照（每次新会话先看这节）

```
node --test "test/**/*.test.js"   → 115 pass / 0 fail
node scripts/verify.mjs           → 275 文件 / 275 记录 / 孤儿 0 / 缺文件 0 / 重复对 0
GET :<port>/meme-brain/api?op=list   → 200，total=275      （能返回 = Host 已加载）
GET :<port>/meme-brain/api?op=facets → 角色分布 27/22/11/7/1，未知角色 207，未分析 0
工具                                 → meme_find / meme_status 出现在 agent 工具表里
git status                        → clean（当前 HEAD 见 git log）
```

指标与下表一致：275 / 272 已分析 / 266 有外观 / 66 有角色 / schema v3 / 角色表 6 条。

---

## 1. 一句话现状

表情包管理系统已经能**收图入库、判重、分析、检索、看界面**（M0–M5 完成）；**还差 M7 让她在 QQ 里选图、M8 让 QQ 的图自动进来、M9 完整界面与导入导出**。

---

## 2. 现在能做什么

### 命令（只在 DSH 会话输入框可用，QQ 里无效）

```
/meme doctor                     体检
/meme list [--limit=10 --offset=0 --state= --character= --todo= --q= --appearance= --sort=]
        --character=大肥鱼        按角色筛；未知角色写 --character=__none__
        --todo=unanalyzed|unnamed|notags|nochar   按待办筛
/meme show <md5前缀>              单张全部字段
/meme find <整句或关键词> [--q= --character= --emotion= --scene= --limit=6]
        人话找图：「生气的大肥鱼」会拆成角色+情绪再排序
/meme dupes                      重复簇
/meme todo                       待办计数
/meme tag <md5前缀> [--name= --tags= --character= --unpin]
        人工标注：填新角色会自动建表项；改角色会上锁；--unpin 解锁
/meme import <目录> [--dry-run]   导入（判重前置）
/meme backfill <源目录> [--force] 从源库 index.json 回填名字/标签
/meme analyze [--limit=N] [--force] [--rename] [--include-pinned] [--md5=] [--appearance=] [--name=] [--batch=4]
/meme char list | add <名字> [--look= --from= --kind=character|meme] | rm <名字>
/meme rebuild                    从库文件重建索引（保留分析结果）
/meme repair [--orphans|--missing]
```

**容易踩的开关语义**：
- `--force`：重跑已分析的图，**不动名字**
- `--rename`：才允许模型改写名字（保护人工标注）
- `--include-pinned`：人工锁定的条目默认被跳过，加这个才一起重跑

### 界面

DSH 侧栏「表情包」图标 → 主区：筛选条 + 网格 + 详情抽屉。
- 筛选条：全部 / 未分析 / 未命名 / 无标签 / 未知角色 / 各角色（都带张数，来自 `op=facets`）
- 网格：每格图 + 名字 + 角色名
- 详情抽屉：名字/标签/**角色**可改（角色留空=未知）；**分析这张 / 重新分析**按钮（锁定条目禁用）；**分析结果**（角色/把握/外观/场景/指向/图上文字）+ **评分**（五维条形）+ **文件与来源**（md5/指纹/状态/重复/来源/入库/分析模型与时间）；锁定的条目有「解除锁定」
- 未分析的图给出可复制的 `/meme analyze --md5=xxxxxxxx`

数据全部来自 `GET/POST /meme-brain/api`（仅 127.0.0.1）。

### HTTP API

```
GET  /meme-brain/api?op=list&limit=&offset=&q=&state=&sort=&character=&todo=
GET  /meme-brain/api?op=item&md5=<前缀>          → 全部分析字段（detailItem）
GET  /meme-brain/api?op=facets                   → 筛选条计数（角色分布/待办/锁定数）
GET  /meme-brain/api?op=image&md5=<前缀>        → 二进制
POST /meme-brain/api?op=annotate  {md5,name?,tags?,character?,pin?}
POST /meme-brain/api?op=analyze   {md5}          → 单张分析（3~6 秒，串行，锁定则 skipped）
```

标注规则（`src/lib/annotate.js`）：填角色 → 写角色表（没有就新建，出处 `ui`）+ `pinned=1` + 把握标 `人工`；清空角色 → 解锁交还模型；`pin:false` → 解锁。**只有改角色才上锁**，改名字/标签不动锁定状态。

`op=item` 的字段装配在 `src/lib/http.js` 的 `detailItem()` / `parseScore()`。

### AI 工具（M7-a）

`src/lib/tools.js` 注册两个只读工具，DSH 里任何 agent 都能调：

| 工具 | 作用 |
|---|---|
| `meme_find` | 找图。`query` 可写整句，「生气的大肥鱼」→ 角色=大肥鱼 + 情绪=生气，按五维距离排序 |
| `meme_status` | 总量 / 角色分布 / 待办计数 |

**检索判断只有一份**：`src/lib/search.js`。工具、`/meme find` 命令、（将来的）QQ 模块都调它。
拆解顺序：认情绪词 → 认角色（否则「大肥鱼」只当文字，27 张漏到 4 张）→ 剩余当关键词（名字/标签/**图上文字**/外观）→ 情绪距离排序，名字命中加权。

---

## 3. 环境事实

| 项 | 值 |
|---|---|
| 项目目录 | `F:\dsh-meme-brain`（当前工作目录） |
| 插件安装方式 | profile 里是 **link**：`dsh-meme-brain → F:\dsh-meme-brain` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop` |
| 数据目录 | `%USERPROFILE%\.dsh\meme-brain\`（library/ + index.db + characters.json + backups/） |
| GUI 端口 | 每次重启会变（当前见运行时 context / `ctx.webServer.getOrigin()`） |
| dsh CLI | `F:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| 依赖 | 只有 `sharp`（原生，libvips 8.18.7） |

### 改完代码怎么生效

```powershell
# 用 plugin_manager 关一次再开一次（entryId = include:meme-brain）
# 只改 Host 代码：这样就行
# 只改 client.js：还要刷新页面（Ctrl+R）
# 改 package.json 的 dsh.client：可能要重启 DSH
```

> 已实测：关/开即可重新加载 Host 代码，不需要重启 DSH。

---

## 4. 里程碑

| # | 内容 | 状态 |
|---|---|---|
| M0 | 插件骨架、`/meme doctor` | ✅ 已验收 |
| M1 | 解析（sharp）+ 三帧 dHash + 判重 | ✅ 53 项测试 |
| M2 | 存储 + 索引（schema v3）+ 状态机 + rebuild/repair | ✅ 已验收 |
| M3 | 管理命令集（list/show/dupes/todo/backfill） | ✅ 已验收 |
| M4 | 最简界面（网格/详情/编辑）+ HTTP | ✅ 已验收 |
| M5 | 七维分析 + 外观 + 角色注入 | ✅ 已跑全量 |
| M6 | 角色表 + 检索 | 🔶 75%：表/命令/规范化/`--character` 检索/**人工标注 + pinned 锁定**；**缺** L3 归纳、批量标注 `bulk` |
| M7 | AI 工具 `meme_find` + cordis 服务 `memeBrain` | 🔶 **M7-a 已完成**：`meme_find`/`meme_status` + `/meme find`，共用 `search.js`；**M7-b（接进 QQ）未开始** |
| M8 | QQ 采集接入（中继模块）+ 判重前置 | ⬜ 未开始 |
| M9 | 完整界面 + 导入导出 + 完整 HTTP | 🔶 **M9-a 详情页 + M9-b 筛选条/实时标注/锁定 + M9-c 单张分析按钮已完成**；缺批量操作、导入导出 |

---

## 5. 数据现状（2026-11-07 17:40）

| 项 | 值 |
|---|---|
| 新库 | **275 张**，167.7MB，`library/<md5[0:2]>/<md5[2:4]>/<md5>.<ext>` |
| 已分析 | 271 |
| 有外观描述 | 265 |
| 有角色 | **65**（大肥鱼 26 / 龙图 21 / 耄耋 11 / doro 6 / ggbond 1） |
| schema | v3（items 有 target / appearance 列） |
| 角色表 | 6 条：大肥鱼、doro、耄耋、龙图（meme）、ggbond、哆啦A梦 |
| **Aurabot 旧库** | 磁盘 292 个文件 = **289 个不同 md5**（3 个 md5 各存了 collected-/manual- 两份）。289 − 275 = **14**，是导入时被判重丢掉的近重复 → **两库没有分叉，新库是旧库的干净超集**（2026-11-07 复核） |

---

## 6. 文档

| 文件 | 内容 |
|---|---|
| `README.md` | 项目总览、决策摘要、里程碑 |
| `docs/00-decisions.md` | ADR-0001 ~ 0019（全部已定） |
| `docs/01-requirements.md` | 需求：流水线、状态机、功能需求、验收 |
| `docs/02-architecture.md` | 架构：模块、契约、数据模型、算法 |
| `docs/03-engineering-contract.md` | **工程契约**：五条保证、设计规则、改动五步验证 |
| `docs/04-acceptance.md` | **验收手册**：每个里程碑「做什么/怎么验/变化/怎么退」 |

代码：`src/index.js`（Host 入口）、`src/commands.js`（命令分发）、`src/client.js`（界面）、
`src/lib/{parse,dhash,dedupe,store,db,pipeline,query,analyze,characters,http,doctor}.js`、
`scripts/{scan-library,verify,cluster-appearance}.mjs`、`test/{unit,regression,integration}`。

---

## 7. 踩过的坑（别重犯）

| 坑 | 事实 |
|---|---|
| **BOM 吃数据** | `Set-Content -Encoding utf8` 写 BOM，`JSON.parse` 抛错被静默吞掉 → 角色表被清空过一次。已修：剥 BOM + `lastLoadError` |
| **别用 PowerShell 改中文文件** | 这台机器上 `pwsh` 实际是 PowerShell 5.1：`Get-Content -Raw` 按 GBK 读 UTF-8 文件 → `Set-Content` 写回后整篇中文变乱码（`docs/04-acceptance.md` 中过一次，靠 `git checkout --` 救回）。**改文档/代码一律用编辑工具，不用 shell 重写文件** |
| `maxTokens: 2000` 太小 | 4 张图 × 13 字段会被截断（8 次失败）。已改 4000 |
| 角色名带标注 | 提示词里写「龙图（梗模板）」，模型原样抄回 → 存成 `龙图（梗模板）`。已修：`normalizeName()` 剥括号、认别名、查表 |
| `--force` 会覆盖名字 | 已拆开：`--force` 只重跑分数，`--rename` 才改名 |
| 命令不是 shell | `/meme` 在 DSH 会话里解析；`$env:` 不展开（已支持 `%USERPROFILE%`、`~`、`$env:` 三种写法） |
| QQ 里没有命令解析器 | 在 QQ 发 `/meme` 只会被当成聊天内容喂给模型 |
| 文字描述分不出"同一只猫" | 「橘色虎斑猫、圆脸」对同一只猫的不同抓拍和不同橘猫完全一样。**判断角色要靠图像，不要靠 appearance 文本** |
| 别信扩展名 | 落盘扩展名来自 sharp 探测的真实格式 |
| 透明必须合成白底 | 不合成时 dHash 最多偏 27 位 |
| 判重阈值 | 真重复距离 0，非重复最近 11；阈值 avg≤4 且 max≤8 |
| WebP | sharp 支持，旧方案（gifuct/pngjs）不支持 |

---

## 8. 已知问题

1. **旧库仍在收，但没分叉**：Aurabot 侧 289 个不同 md5，新库 275（差 14 = 导入时判重丢弃的近重复）。新图仍会落到旧库 → M8 解决
2. 4 张未分析（maxTokens 截断的遗留），补跑：`/meme analyze --limit=10`
3. `大肥鱼飞起`、`惬意doro` 没被认出来（描述偏向女仆装/玫瑰饰）
4. `ggbond` 只有 1 张，样本太少
5. 210 张仍是「未知角色」——角色表只有 6 条，且它们已经分析过，要 `--force` 重跑才会更新角色
6. ~~没有 `pinned` 保护机制~~ → **M9-b 已实现**：手工改角色 → `pinned=1` + 把握标 `人工`；`analyze` 默认跳过，`--include-pinned` 才放行；界面可解锁
7. 没有批量标注命令（`bulk`）：现在只能一张一张点
8. ~~项目尚未 git init~~ → **已初始化并提交**（`4072774`）；当前 HEAD 见 `git log`
9. 界面只能**单张**触发分析（M9-c），没有批量分析入口；筛选条不含「疑似重复」（要算 dHash 聚类，代价高，暂未做）

---

## 9. 下一步

**待你拍板**：是否重跑 210 张的角色识别（约 ¥0.2，`/meme analyze --force --limit=250`）。
现在有了锁定机制，重跑不会再动你手工标过的角色。

**界面下一步候选**（按价值排序）：
1. **批量标注 `bulk`**：框选多张 → 打同一批标签/同一角色（210 张一张一张点太慢）
2. 详情里「保存并下一张」：连续标注时省一次点击
3. 待办视图里直接内联编辑（不点开抽屉）

**M7-b 计划（待你点头，会改她的行为）**：
QQ 里她能自己挑图 —— 写一个 Aurabot 模块（`~/.dsh/plugins-data/aurabot/modules/meme-qq/index.mjs`）：
- `api.tool()` 挂 `meme_find`（查新库）+ `meme_send`（找到后用 `api.sendImage(chatId, 绝对路径)` 发出去）
- `api.rule()` 告诉她有这个本事；`api.command({name:'表情'})` 给主人用
- 数据走 HTTP（`api.dsh.get('webServer').getOrigin()` + `/meme-brain/api`），不走内存服务 —— 守住 ADR-0005
- 验收：QQ 里说「来张生气的大肥鱼」→ 她真的发一张；说「来张耄耋睡觉的」→ 她说没有

**M8 计划**：Aurabot 加中继模块（判重前置 + upload），关掉 `stickers.collect`。

---

## 10. 工作方式约定（用户明确要求）

1. **每个里程碑按四段交付**：做什么 / 怎么验 / 你世界里的变化 / 怎么退；验收必须是用户能自己敲的命令 + 具体预期输出
2. **先讨论后开工**：架构、定位、取舍类问题先出方案再动手
3. **改代码后自查**：`node --test "test/**/*.test.js"` 全绿 + `node --check` + 需要时跑 `scripts/verify.mjs`
4. 用户是 UE 开发者，不读前端/JS 代码——**结论要能用命令复现，不能只说"测试通过"**

---

## 11. 新会话怎么开始

1. `cd F:\dsh-meme-brain`
2. 读 `docs/04-acceptance.md`（知道每个里程碑怎么验）和本文
3. 跑 `/meme doctor` 看系统是否健康
4. 跑 `node --test "test/**/*.test.js"` 确认代码没坏
5. 继续 M7，或先处理第 8 节的已知问题
