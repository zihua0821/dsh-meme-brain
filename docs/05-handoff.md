# 上下文交接（2026-11-07 起稿，19:30 复核）

> 用途：上下文压缩/换会话后，读这一份就能继续干。
> 权威顺序：`docs/` 里的设计文档 > 本文 > 代码注释。

---

## 0. 复核快照（每次新会话先看这节）

```
node --test "test/**/*.test.js"      → 151 pass / 0 fail
node scripts/verify.mjs              → 281 文件 / 281 记录 / 孤儿 0 / 缺文件 0 / 重复对 0
GET :<port>/meme-brain/api?op=facets → 角色分布 大肥鱼27 / 龙图22 / 耄耋13 / doro7 / ggbond1
                                       未知角色 211 · 未分析 0 · 无标签 61 · 人工锁定 1
AI 工具                              → meme_find / meme_status 出现在 agent 工具表里
Aurabot                              → 模块「表情脑」在跑；「表情包」（内置）已停
git status                           → clean（当前 HEAD 见 git log）
```

指标与下表一致：281 张 / 281 已分析 / 275 有外观 / 70 有角色 / schema v3 / 角色表 6 条。

---

## 1. 一句话现状

**库、分析、检索、界面、AI 工具、QQ 收发表情全部打通**（M0–M5、M7、M8 完成）。剩下的是**批量标注**（211 张未知角色）、**导入导出/备份**、以及 M9 的界面收尾。

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
/meme rm <md5前缀> [--yes]        删除（文件移到 trash/，不加 --yes 只预览）
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
- 详情抽屉：**每个字段都能改** —— 名字/标签/角色（输入框）、外观/图上文字（输入框，留空或「无」=清空）、场景（7 个可点标签）、指向（下拉）、**五个评分滑块**；「分析这张 / 重新分析」按钮（锁定条目禁用）；锁定的条目有「解除锁定」
- 保存是**差异提交**：只发真的改过的字段；改了任何模型字段（角色/外观/文字/场景/指向/分数）→ 自动上锁 `pinned=1`，挡住 `analyze --force`
- 未分析的图也给可复制的 `/meme analyze --md5=xxxxxxxx`

数据全部来自 `GET/POST /meme-brain/api`（仅 127.0.0.1）。

### HTTP API

```
GET  /meme-brain/api?op=list&limit=&offset=&q=&state=&sort=&character=&todo=
GET  /meme-brain/api?op=item&md5=<前缀>          → 全部分析字段（detailItem）
GET  /meme-brain/api?op=facets                   → 筛选条计数（角色分布/待办/锁定数）
GET  /meme-brain/api?op=find&q=&character=&emotion=&scene=&limit=  → 人话检索（和工具同一套）
GET  /meme-brain/api?op=image&md5=<前缀>        → 二进制
POST /meme-brain/api?op=annotate  {md5,name?,tags?,character?,pin?}
POST /meme-brain/api?op=analyze   {md5}          → 单张分析（3~6 秒，串行，锁定则 skipped）
POST /meme-brain/api?op=add&source=qq  body=图片原始字节  → 判重入库（QQ 补录用）
```

标注规则（`src/lib/annotate.js`）：填角色 → 写角色表（没有就新建，出处 `ui`）+ `pinned=1` + 把握标 `人工`；清空角色 → 解锁交还模型；`pin:false` → 解锁。**只有改角色才上锁**，改名字/标签不动锁定状态。

`op=item` 的字段装配在 `src/lib/http.js` 的 `detailItem()` / `parseScore()`。

### AI 工具（M7-a）

`src/lib/tools.js` 注册两个只读工具，DSH 里任何 agent 都能调：

| 工具 | 作用 |
|---|---|
| `meme_find` | 找图。`query` 可写整句，「生气的大肥鱼」→ 角色=大肥鱼 + 情绪=生气，按五维距离排序 |
| `meme_status` | 总量 / 角色分布 / 待办计数 |

**检索判断只有一份**：`src/lib/search.js`。工具、`/meme find` 命令、（QQ 模块的）`op=find` 都调它。
拆解顺序：认情绪词 → 认角色（否则「大肥鱼」只当文字，27 张漏到 4 张）→ 剩余当关键词（名字/标签/**图上文字**/外观）→ 情绪距离排序，名字命中加权。

### Aurabot 模块（M7-b / M8，已在跑）

`integrations/aurabot/meme-qq/index.mjs` → 部署到 `modules/meme-qq/index.mjs`。正式名字 **表情脑**。
**独立模块**：id 是 `meme-qq`，不冒充内置。内置 `stickers` 模块**代码原样保留、只在配置里停用**
（`modules.stickers.enabled = false`，想退回把它改 true 并关掉 meme-qq）。

内置停用后由它接住三条路：

| 原来的路 | 现在 |
|---|---|
| `<sticker:标签>` → hub 调内置 `match` | `reply/items` 里换成我们库里的图 |
| 自动配表情（`stickers.autoChance`） | `reply/items` 里按本模块概率补一张 |
| 偷表情（hub 调内置 `collect`） | 自己的 `message` 监听 |

**收表情的判定（只用确凿证据，不猜文件名）**：
1. 字节是真动图（GIF 多帧 / 动 WebP / APNG）→ 收（内置漏掉的就是这类）
2. QQ 自己标成表情段（`sub_type` = 1 收藏 / 7 大表情 / 11 动图表情）→ 收
3. 其余（静态 + 没被标记）→ **一律不收**

> 踩过的坑：曾经用「文件名像 `<32位md5>.jpg` 就当表情」，而 QQ 给所有图片都起这种名字 → 收进了两张游戏截图。

- 工具：`meme_find`、`meme_send`、`qq_send_sticker`、`qq_list_stickers`、`qq_edit_sticker`、`qq_collect_sticker`、`qq_save_sticker`
- **存图与回应是两条独立的路（原则）**：存图是后台动作，绝不改写她的回复；她想说话就说话、想甩表情就甩表情。工具结果做得极淡（只回一个「好」），规则里只要求「别提存图、别提库」。~~早期版本用 `saveSignal` 删文字强塞表情，已废弃~~
- 命令：`/表情 <关键词>`
- **参数在面板「系统」→ 表情脑**（模块独立页），11 项：发表情 / 自动配概率 / 收表情 / 从群里 / 从私聊 / 怎么收（三者）/ 每小时上限 / 看图起名 / 收取上限 / 发送上限 / 夹小黄脸
- ⚠️ **进不了「表达」**：`TAB_MODS = { stickers: ['stickers'] }`，那个页签只在内置模块运行时才存在；而自定义页只能落「平台/系统」。
- **镜像**：`config.stickers` 里 hub 还认的字段（`enabled` 恒 false、`faces`、`collect`、`collectMode`、`fromGroups`、`fromPrivate`）由模块写过去，否则 hub 的提示会和设置不同步
- 不做：`maxLibrary`（自动删图 = 数据损失）
- **踩坑**：`api.setConfig(patch)` 是深合并，**删键必须用函数形式**（整份替换），否则删不掉
- 数据全走 HTTP（`op=list` / `op=find` / `op=add` / `op=analyze` / `op=annotate`）
- 模块读 `DSH_MEME_BRAIN_ROOT` 环境变量（和主项目一致），测试里用它指向临时目录
- **已知残缺**：内置注册的 `/ext/stickers/...` 接口随模块停用而失效 → Aurabot 面板「表情库」卡片显示空；管库请用 DSH 侧栏「表情包」界面（已决定不处理）

**判重只有一份**：`src/lib/pipeline.js` 的 `ingestBuffer()`，目录导入和 `op=add` 共用。
**回退**：`modules.stickers.enabled = true` + `modules['meme-qq'].enabled = false`。
**注意**：早期版本曾用同名 id 顶掉内置模块（已废弃），配置里残留的 `stickers.forkedFrom` 已清掉。

---

## 3. 环境事实

| 项 | 值 |
|---|---|
| 项目目录 | `F:\dsh-meme-brain`（当前工作目录） |
| 插件安装方式 | profile 里是 **link**：`dsh-meme-brain → F:\dsh-meme-brain` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop` |
| 数据目录 | `%USERPROFILE%\.dsh\meme-brain\`（library/ + index.db + characters.json + backups/） |
| **Aurabot 模块** | `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\meme-qq\index.mjs`（名字「表情脑」）。仓库源码在 `integrations/aurabot/meme-qq/`，改完跑 `node scripts/deploy-aurabot.mjs`（Aurabot 3 秒热加载） |
| GUI 端口 | 每次重启会变（当前见运行时 context / `ctx.webServer.getOrigin()`） |
| dsh CLI | `F:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| **PowerShell** | 工具默认的 `pwsh` 其实是 **Windows PowerShell 5.1**（`powershell.exe`）。本机另装了 **PowerShell 7.6.9**，是 Store 的应用执行别名：`& "$env:LOCALAPPDATA\Microsoft\WindowsApps\pwsh.exe"`（`where pwsh` 看不见它，必须用全路径）。**要读写中文文件、发中文 JSON，用 PS7 或 node** |
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
| M7 | AI 工具 + QQ 接入 | ✅ **M7-a**（`meme_find`/`meme_status` + `/meme find`）、**M7-b**（QQ 模块「表情脑」接管发表情/收表情/找图）都已完成并实测 |
| M8 | QQ 采集 + 判重前置 | ✅ 已并入 M7-b：`op=add` 走 `ingestBuffer`；动图补录兼并在新模块；旧 `gif-stickers` 已停用 |
| M9 | 完整界面 + 导入导出 | 🔶 **M9-a 详情页 / M9-b 筛选条+实时标注+锁定 / M9-c 单张分析按钮** 完成；缺批量操作、导入导出 |

---

## 5. 数据现状（2026-11-07 19:30）

| 项 | 值 |
|---|---|
| 新库 | **281 张**，169.1MB，`library/<md5[0:2]>/<md5[2:4]>/<md5>.<ext>` |
| 已分析 | **281（全部）** |
| 有外观描述 | 275（另有 6 张是加 appearance 列之前分析的，重跑一次 `--force` 就齐） |
| 有角色 | **70**（大肥鱼 27 / 龙图 22 / 耄耋 13 / doro 7 / ggbond 1） |
| 未知角色 | **211** · 无标签 61 · 人工锁定 1 |
| QQ 来源 | 6 张（`source=qq`，都是自动收的） |
| schema | v3（items 有 target / appearance 列） |
| 角色表 | 6 条：大肥鱼、doro、耄耋、龙图（meme）、ggbond、哆啦A梦 |
| **Aurabot 旧库** | 290 条索引 / 293 个文件，**已停止写入**（内置模块停用）。注意：18:44 那阵内置被临时打开过，它多收了 1 张 —— 所以是 290 不是 289 |
| 回收站 | `trash/` 里有 2 张误收的游戏截图（`/meme rm` 删的，可恢复） |

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
| `integrations/aurabot/meme-qq/` | Aurabot 模块源码（部署用 `node scripts/deploy-aurabot.mjs`） |

代码：`src/index.js`（Host 入口）、`src/commands.js`（命令分发）、`src/client.js`（界面）、
`src/lib/{parse,dhash,dedupe,store,db,pipeline,query,analyze,characters,http,doctor}.js`、
`scripts/{scan-library,verify,cluster-appearance}.mjs`、`test/{unit,regression,integration}`。

---

## 7. 踩过的坑（别重犯）

| 坑 | 事实 |
|---|---|
| **BOM 吃数据** | `Set-Content -Encoding utf8` 写 BOM，`JSON.parse` 抛错被静默吞掉 → 角色表被清空过一次。已修：剥 BOM + `lastLoadError` |
| **别用 5.1 的 PowerShell 改中文文件** | 工具里的 `pwsh` 是 **PowerShell 5.1**：`Get-Content -Raw` 按 GBK 读 UTF-8 文件 → `Set-Content` 写回后整篇中文变乱码（`docs/04-acceptance.md` 中过一次，靠 `git checkout --` 救回）。**三条安全路径**：① 用编辑工具（read/write/edit）；② 用 node 读写；③ 用 **PS7** `& "$env:LOCALAPPDATA\Microsoft\WindowsApps\pwsh.exe" -File 脚本.ps1`（实测 7.6.9，读 UTF-8 正常） |
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
| **`api.setConfig` 是深合并** | Aurabot 模块里要**删键**必须传函数形式 `api.setConfig(cfg => 新cfg)`（整份替换）；传对象删不掉，`forkedFrom` 因此残留过一次 |
| **别拿文件名当证据** | QQ 给所有图片都起 `<32位md5>.jpg` 这种名字。按文件名判「是不是表情」→ 收进了两张游戏截图。判定要基于字节（是不是动图）或 QQ 的 `sub_type` |
| **5.1 发中文会变问号** | `Invoke-WebRequest -Body $中文`（PS 5.1）按 Latin-1 编码，服务端收到一串 `?`，写进库就是坏数据（实测把一条的外观写成了问号）。**PS7 已实测正常**（`-ContentType 'application/json; charset=utf-8'`，中文往返无碍）；不想切 PS7 就用 node 的 `fetch` 或 `/meme tag` 命令 |
| **面板页签是写死的** | `TAB_MODS = { stickers: ['stickers'] }`：只有内置 stickers 模块在跑，「表达 → 表情包」页才存在；自定义模块页只能落「平台/系统」两组 |
| **存图和回复要分开** | 早期版本让「存图」触发 `saveSignal`，删掉她这轮文字强塞表情。用户指出这是错的：存表情和回应是**两条并行互不干扰的路**，硬设「回」或「不回」都不对 |

---

## 8. 已知问题

1. **旧库还留着**：Aurabot 侧 290 条索引 / 293 个文件（`plugins-data/aurabot/stickers/`），内置模块停用后不再增长。**18:44 那阵内置被临时打开过，它多收了 1 张**。要不要删，等你定
2. `大肥鱼飞起`、`惬意doro` 没被认出来（描述偏向女仆装/玫瑰饰）
3. `ggbond` 只有 1 张，样本太少
4. **211 张未知角色**、61 张无标签——角色表只有 6 条；它们已分析过，重跑要 `--force`
5. **6 张已分析但没外观**（加 appearance 列之前分析的），重跑一次 `--force` 就齐
6. 没有批量标注（`bulk`）：现在只能一张一张点
7. 界面只能**单张**触发分析；筛选条不含「疑似重复」（要算 dHash 聚类，代价高）；界面还没有删除按钮（命令有 `/meme rm`）
8. ~~没有 `pinned`~~ → 已实现（改角色上锁，`analyze` 跳过，`--include-pinned` 放行）
9. **Aurabot 面板「表情库」卡片失效**：内置模块注册的 `/ext/stickers/...` 接口随停用而 404。**已决定不处理**（管库统一用 DSH 侧栏「表情包」界面）
10. 动画商城表情（`emoji_id`）当普通图发，会掉动画；不再往机器人号 QQ 收藏写 `add_custom_face`

---

## 9. 下一步

**当前状态**：M0–M5、M7、M8 完成；M6 75%（缺 `bulk`、L3 归纳）；M9 部分（详情/筛选/标注/单张分析完成，缺导入导出）。151 项测试全绿。

**候选（按我判断的价值）**：

1. **批量标注 `bulk`**：211 张未知角色，一张一张点不现实。界面框选 + `/meme bulk --todo=nochar --character=X`
2. **M9 导入导出**：281 张只有这一份，现在只备份索引不打包图片
3. **角色归纳（L3）**：外观聚类提议「这几张可能是同一个人」，人工确认后批量打标（依赖 `bulk`）
4. 小尾巴：6 张无外观、2 张认错、`ggbond` 样本少、界面「疑似重复」筛、界面删除按钮
5. QQ 侧观察：挑图准不准、会不会太频繁、看图起名的质量

**等你拍板**：旧库 290 条是留还是删（占 169MB）。

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
5. 继续 M6（`bulk`）或 M9（导入导出），或先处理第 8 节的已知问题
