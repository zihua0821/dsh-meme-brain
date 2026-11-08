# 上下文交接（2026-11-07 起稿，2026-11-08 复核）

> 用途：上下文压缩/换会话后，读这一份就能继续干。
> 权威顺序：`docs/` 里的设计文档 > 本文 > 代码注释。
>
> **这是一份开发过程记录，不是使用手册**：里面的路径、端口、张数都是当时本机的快照。
> 想把它用起来看 [`README.md`](../README.md)；想知道每个里程碑验收了什么看
> [`04-acceptance.md`](04-acceptance.md)。保留这份是因为「为什么这么写」比「怎么写」更容易丢。

---

## 0. 复核快照（每次新会话先看这节）

```
node --test "test/**/*.test.js"      → 212 pass / 0 fail
node scripts/verify.mjs              → 文件数 = 记录数 / 孤儿 0 / 缺文件 0 / 重复对 0
GET :<port>/meme-brain/api?op=facets → 角色分布 + 各待办计数（数字每天都在长，别背数字）
GET :<port>/meme-brain/api?op=chars  → 角色表全量（当前 38 条）
AI 工具                              → meme_find / meme_status 出现在 agent 工具表里
Aurabot                              → 「表情脑」(meme-qq) 在跑、内置 stickers 已停；
                                        「峰谷节奏」(peak-rhythm) 在跑（独立仓库）
git status                           → 两个仓库都 clean
```

**别背总数**：QQ 会自动收图，张数每天都在长。
2026-11-08 19:50 的快照：**324 张 / 173MB / 324 已分析 / 323 有外观 / 243 有角色
（94 张人工锁定）/ 81 未知角色 / 324 有标签 / 49 张 source=qq / 角色表 38 条 / schema v3**。
要看当前值：`/meme doctor` 或界面右上角。

**端口会变**：DSH 每次重启，GUI 端口可能不同（本次 4795）。别把端口写死，
用 `ctx.webServer.getOrigin()`，或者运行时上下文里那个 URL。

---

## 0.5 上一次会话干了什么（压缩后最可能丢的部分）

按时间顺序，都已完成、都有测试：

1. **M9-d 全字段可编辑**：详情里外观/文字/场景/指向/**五个评分滑块**都能改；保存是**差异提交**
   （只发真改过的字段，否则一保存就全锁）；改模型字段自动 `pinned=1`。
2. **M9-e 角色表查看 + 刷新**：弹层分「库里用到的/还没用到的」；「刷新」重拉列表/计数/角色表/详情且不动筛选。
3. **M9-f 角色表可编辑**：改/改名/新增/删除；**改名连带动库里引用它的图**并锁定；在用中的角色删除要确认两次。
4. **M9-g 对话里改库**：QQ 里「这张是 doro」→ `qq_set_character`；定位 md5 > 名字 > 刚发的那张；
   **权限硬校验**（只有 `ownerQQ` 能改，参数 `charEditMode`）。
5. **M9-h 导入导出**：自写 zip（无依赖，STORE，170MB 约 0.2 秒）；导出含图 + manifest + 角色表；
   导入**只补不覆盖**，md5 不符拒收。`exports/` 已有一份备份。
6. **标签体系**：闭集 18 词，分析产出，只在空标签时补；**全库 324/324 都有标签**。
   锁定的条目用 `tagsOnly` 模式补（不动角色/名字/分数）。
7. **角色表 6 → 38**：新增吉伊卡哇三人组（吉伊/小八/乌萨奇，互相写排除条件）、柯基、奶龙、
   汤姆猫、老鼠、鼠鼠，以及兜底类别「默认的动物」「呆猫」。多轮收紧 `look` 去掉了「磁吸」误判。
8. **峰谷节奏拆成独立仓库** `peak-rhythm`（含法定节假日、和 dsh-meter 对表），
   本仓库只留 ADR-0021 一条记录。
9. **文档收尾**：README 重写、新增 CHANGELOG、02/04/05 同步到当前状态。

**踩到的两个坑（都修了）**：
- 我把 `useState` 写在「载入中」的提前 return 之后 → 整个面板白屏。已修，并加了一条**源码级测试**
  扫描「hook 出现在提前 return 之后」。
- `op=export` 我写进了 POST 分支却用 GET 调 → 未知 op。现在：`op=exports` 是 GET，
  `op=export` / `op=import` 是 POST。

**已知小瑕疵（不影响数据）**：判重日志里「撞上哪一张」偶尔显示「未命名」——
模块本地快照有 60 秒缓存，刚入库的那张还没进快照。等一会儿再发就正常。

---

## 0.6 开源发布准备（2026-11-08 晚，已完成）

两个仓库都整理成可以公开的样子了（`dsh-meme-brain` 提交 `603af90`，`dsh-peak-rhythm` 提交 `8b6061b`）。
**功能没改**，改的是「别人能不能装上、看懂、相信」：

- 许可证（MIT）、CI（ubuntu + windows × Node 22/24）、提交 `package-lock.json`、补 `repository` 等元数据
- **角色表种子**：`characters.json` → `characters.seed.json`，`apply()` 里首次启动种入 38 条
  （已有不动、坏的不覆盖）；新增 2 个测试文件共 7 项
- `integrations/aurabot/README.md`：模块的安装、14 项参数、8 个工具、权限、怎么退回内置
- README 重写成开源门面；新增 `CONTRIBUTING.md`；文档去个人路径；验收手册过期标记修正

**验证过的事实**（不是「测试通过」四个字）：

```
212 项测试    Windows Node 24 ✅　WSL Ubuntu Node 22.22 ✅（两条都实跑）
npm ci        在干净的 Linux 目录能装出来（CI 的安装步骤不是猜的）
npm pack      39 个文件：src / scripts / integrations / 种子；不含 test/
Aurabot 模块  按新 README 部署成功，20:06:07 日志「表情脑已就绪」
```

**发布结果（2026-11-08 20:12）**：

| 仓库 | 地址 | 首发提交 | CI |
|---|---|---|---|
| dsh-meme-brain | <https://github.com/zihua0821/dsh-meme-brain> | `9e4f2ec` | ✅ 4/4（ubuntu + windows × Node 22/24） |
| dsh-peak-rhythm | <https://github.com/zihua0821/dsh-peak-rhythm> | `14fc516` | ✅ 4/4 |

- 两个仓库默认分支都是 `master`，`origin` 指向 GitHub，本地与远端一致。
- 提交身份：peak 的 4 个提交已统一成
  `zihua0821 <84671913+zihua0821@users.noreply.github.com>`（强推过，改了 hash）；
  meme-brain 的历史还是 `zy <zy@local>` / `dsh-agent <agent@local>`——不含个人信息，但没关联到账号。
  想统一，就照 peak 那次的做法再改一遍（`filter-branch --env-filter` + `push --force`）。
- 仓库描述和 topics 还没填（GitHub 上手动填更快）：meme-brain 可以写
  「DSH 表情包管理系统：收图/判重/模型标注/检索/界面/QQ」，topics 用 `dsh` `sticker` `meme` `sqlite` `sharp`。

> 没有截图。想加就先放进 `docs/`，再在 README 顶部插一行图片。

---

## 1. 一句话现状

**从收图到 QQ 全链路都通了，可以日常用了**：解析/判重/分析/检索/界面/备份（M0–M5、M9 全部），
AI 工具与 QQ 模块（M7/M8），角色表与标签（M6 基本完成）。
剩下的只有**锦上添花**：相似传播（改一张→应用到相似几张）、界面删除按钮、界面「疑似重复」筛选。

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
- 工具栏：**刷新**（重拉列表/计数/角色表/当前详情，不动筛选）、**角色表**（弹层看全部角色和梗、各多少张、外观特征、分「用到的/没用到的」；**可直接改**：名字/类型/外观/出处/别名、新增、删除）

数据全部来自 `GET/POST /meme-brain/api`（仅 127.0.0.1）。

### HTTP API

```
GET  /meme-brain/api?op=list&limit=&offset=&q=&state=&sort=&character=&todo=
GET  /meme-brain/api?op=item&md5=<前缀>          → 全部分析字段（detailItem）
GET  /meme-brain/api?op=facets                   → 筛选条计数（角色分布/待办/锁定数）
GET  /meme-brain/api?op=find&q=&character=&emotion=&scene=&limit=  → 人话检索（和工具同一套）
GET  /meme-brain/api?op=chars                    → 角色表 + 每张在库里的计数
GET  /meme-brain/api?op=image&md5=<前缀>        → 二进制
POST /meme-brain/api?op=annotate  {md5,name?,tags?,character?,pin?}
POST /meme-brain/api?op=analyze   {md5}          → 单张分析（3~6 秒，串行，锁定则 skipped）
POST /meme-brain/api?op=add&source=qq  body=图片原始字节  → 判重入库（QQ 补录用）
POST /meme-brain/api?op=judge  body=图片原始字节  → 模型判「是不是表情包」（不写库，带缓存）
POST /meme-brain/api?op=export                  → 打包整个库到 exports/*.zip
GET  /meme-brain/api?op=exports                 → 已有导出包列表
POST /meme-brain/api?op=import  {path}          → 从 zip 还原（只补不覆盖）
POST /meme-brain/api?op=char-save {name,originalName?,look?,from?,aka?,kind?}
POST /meme-brain/api?op=char-rm   {name,force?}   → 有图在用时 409 E_IN_USE
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

### 角色表（38 条）

- 最初 6 条：大肥鱼、doro、耄耋、龙图（梗）、ggbond、哆啦A梦
- 22 条由 `node scripts/import-characters.mjs` 导入（幂等，加人就改数组再跑）：
  吉祥物（乖巧宝宝/流泪猫猫头/长草颜团子/兔斯基/阿狸/绿豆蛙/罗小黑/吾皇）、
  模板与梗（蘑菇头/简笔小人/滑稽/暴漫脸/中老年表情包/金馆长/姚明/花泽香菜/黑人问号/张学友/斯巴达）、
  国际符号（doge/cheems/Pepe）
- 之后又加：**吉伊卡哇三人组**（吉伊 / 小八 / 乌萨奇，互相写排除条件：「长耳是乌萨奇、
  蓝白花纹尖猫耳是小八、白色小圆耳 ω 嘴是吉伊」）、**柯基**、**奶龙**、**汤姆猫**、**老鼠**、**鼠鼠**，
  以及两个兜底类别 **默认的动物**（不属于任何有名角色的动物）和 **呆猫**（呆滞表情的猫）
- **每条 `look` 都写成排他性特征**（「真实白猫」而不是「猫」；「纯黑白简笔线条人、无五官」而不是「画的」），
  宁写「不是什么」也不写含糊的。名单越长越容易把「像的」认成「就是」，靠这个压住
- 多轮去噪的实证：柯基曾被认成 `doge`、黄蛇/河马曾被认成 `奶龙`、粉色圆脸曾被认成 `龙图`——
  都是收紧 look 后修掉的
- **人工标注**：93 张标了角色并锁定（`char_conf=人工`，模型不会再改）
- **标签**：闭集 18 词（卖萌/无语/委屈/疑惑/开心/嘲讽/震惊/生气/得意/攻击/摸鱼/吃瓜/困/干饭/无奈/害怕/装傻/嫌弃），
  只在标签为空时补；人工写过的不覆盖

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

**收表情的判定（ADR-0020：内容问题交给模型）**：
1. 字节是真动图（GIF 多帧 / 动 WebP / APNG）→ 收（内置漏掉的就是这类）
2. QQ 自己标成表情段（`sub_type` = 1 收藏 / 7 大表情 / 11 动图表情）→ 收
3. 其余普通静态图 → **问模型**（`POST op=judge`，只回 `{sticker,why}`），是就收、不是记日志
   - 结果按 md5 缓存在 `judge-cache.json`，同图重发不再花钱
   - 模型不可用 → 退回尺寸兜底（近方形 0.6~1.7、边长≤600、≤512KB）
   - 参数 `judgeMode`：`model`（默认）/ `size` / `off`

> 踩过的坑：先用「文件名像 md5」→ 收进两张游戏截图；再用「只收动图+表情段」→ 群里普通图片段的表情包全漏；再用「按尺寸猜」→ 代理指标，边界必错。最后走模型判定（ADR-0020）。

- 工具：`meme_find`、`meme_send`、`qq_send_sticker`、`qq_list_stickers`、`qq_edit_sticker`、**`qq_set_character`**、`qq_collect_sticker`、`qq_save_sticker`
- **对话改库**（`qq_set_character`）：主人说「这张是 doro」就改角色。定位顺序 md5 前缀 > 名字 > 这个聊天最近那张图（10 分钟内）。**权限硬校验**：比对最近一条消息的发送者与 `ownerQQ`，参数 `charEditMode` = `owner`（默认）/`anyone`/`off`
- **存图与回应是两条独立的路（原则）**：存图是后台动作，绝不改写她的回复；她想说话就说话、想甩表情就甩表情。工具结果做得极淡（只回一个「好」），规则里只要求「别提存图、别提库」。~~早期版本用 `saveSignal` 删文字强塞表情，已废弃~~
- 命令：`/表情 <关键词>`
- **参数在面板「系统」→ 表情脑**（模块独立页），14 项：发表情 / 自动配概率 / 收表情 / 从群里 / 从私聊 / 怎么收（三者）/ 每小时上限 / 看图起名 / 收取上限 / 发送上限 / **普通图片怎么判** / **谁能对话改库** / （旧）按尺寸收 / 夹小黄脸
- ⚠️ **进不了「表达」**：`TAB_MODS = { stickers: ['stickers'] }`，那个页签只在内置模块运行时才存在；而自定义页只能落「平台/系统」。
- **镜像**：`config.stickers` 里 hub 还认的字段（`enabled` 恒 false、`faces`、`collect`、`collectMode`、`fromGroups`、`fromPrivate`）由模块写过去，否则 hub 的提示会和设置不同步
- 不做：`maxLibrary`（自动删图 = 数据损失）
- **踩坑**：`api.setConfig(patch)` 是深合并，**删键必须用函数形式**（整份替换），否则删不掉
- 数据全走 HTTP（`op=list` / `op=find` / `op=add` / `op=analyze` / `op=annotate`）
- 模块读 `DSH_MEME_BRAIN_ROOT` 环境变量（和主项目一致），测试里用它指向临时目录
- **已知残缺**：内置注册的 `/ext/stickers/...` 接口随模块停用而失效 → Aurabot 面板「表情库」卡片显示空；管库请用 DSH 侧栏「表情包」界面（已决定不处理）

### 峰谷节奏（已独立出去，不在本仓库）

聊天频率策略（DeepSeek 峰谷：高峰少说、空闲活跃，含中国法定节假日）**建了独立仓库**：

```
peak-rhythm   （独立仓库）Aurabot 模块，id = peak-rhythm
  index.mjs               模块本体（group/decide 门控）
  calendar.mjs            法定节假日表（2025/2026，国办通知口径）
  scripts/deploy.mjs      部署到 Aurabot modules 目录
  scripts/state.mjs       命令行看「现在算峰还是谷」
  test/                   21 项（含「和 dsh-meter 日历逐条对齐」的漂移检查）
```

- 它**不依赖本插件**，只是同宿主下的另一个 Aurabot 模块；改它不用动这边。
- 已从本仓库移除（原 `integrations/aurabot/peak-rhythm/`），避免一处代码两个来源。
- 决策记录仍在 `docs/00-decisions.md` 的 **ADR-0021**。

**判重只有一份**：`src/lib/pipeline.js` 的 `ingestBuffer()`，目录导入和 `op=add` 共用。**回退**：`modules.stickers.enabled = true` + `modules['meme-qq'].enabled = false`。
**注意**：早期版本曾用同名 id 顶掉内置模块（已废弃），配置里残留的 `stickers.forkedFrom` 已清掉。

---

## 3. 环境事实

| 项 | 值 |
|---|---|
| 项目目录 | 本仓库（当前工作目录） |
| 插件安装方式 | profile 里是 **link**：`dsh-meme-brain → <克隆目录>\dsh-meme-brain` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop` |
| 数据目录 | `%USERPROFILE%\.dsh\meme-brain\`（library/ + index.db + characters.json + judge-cache.json + exports/ + backups/ + trash/） |
| **Aurabot 模块** | `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\meme-qq\index.mjs`（名字「表情脑」）。仓库源码在 `integrations/aurabot/meme-qq/`，改完跑 `node scripts/deploy-aurabot.mjs`（Aurabot 3 秒热加载） |
| GUI 端口 | 每次重启会变（2026-11-08 是 4795）。用运行时 context 或 `ctx.webServer.getOrigin()`，别写死 |
| dsh CLI | `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd` |
| **PowerShell** | **工具里的 `pwsh` 已是 PowerShell 7.6.9**（由 profile 补丁把 `pwsh-sandbox.pwshPath` 指到 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`）。改之前默认是 5.1，读/写中文都会坏。**别再按 5.1 的行为写脚本**：`Get-Content`/`Set-Content` 默认 UTF-8，`Invoke-WebRequest` 发中文正常 |
| 依赖 | 只有 `sharp`（原生，libvips 8.18.7） |

### 改完代码怎么生效

```powershell
# 用 plugin_manager 关一次再开一次（entryId = include:meme-brain）
# 只改 Host 代码：这样就行
# 只改 client.js：还要刷新页面（Ctrl+R）
# 改 package.json 的 dsh.client：可能要重启 DSH
```

> 已实测：关/开即可重新加载 Host 代码，不需要重启 DSH。

### 全 DSH 的环境补丁（profile 层）

`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里加了一条，让**所有会话的 `pwsh` 工具**都用 PowerShell 7：

```yaml
- id: pwsh-sandbox
  name: "@deepseek-ai/dsh-pwsh-sandbox"
  config:
    pwshPath: C:\Users\<用户名>\AppData\Local\Microsoft\WindowsApps\pwsh.exe
```

- **为什么**：默认是 Windows PowerShell 5.1，读 UTF-8 中文会乱码、发中文 JSON 会变 `?`
- **生效方式**：保存即生效（Loader 热应用），不用重启 DSH —— 已实测
- **退回**：删掉这段，或把 `pwshPath` 改回 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
- **重装 DSH 后要补回来**（profile 目录若被清掉）

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
| M6 | 角色表 + 检索 | ✅ 基本完成：38 条表 / 命令 / 规范化 / `--character` 检索 / 人工标注 + 锁定 / 标签；**缺** L3 归纳（相似传播） |
| M7 | AI 工具 + QQ 接入 | ✅ **M7-a**（`meme_find`/`meme_status` + `/meme find`）、**M7-b**（QQ 模块「表情脑」接管发表情/收表情/找图）都已完成并实测 |
| M8 | QQ 采集 + 判重前置 | ✅ 已并入 M7-b：`op=add` 走 `ingestBuffer`；动图补录兼并在新模块；旧 `gif-stickers` 已停用 |
| M9 | 完整界面 + 导入导出 | ✅ **M9-a ~ M9-h 全部完成**：详情页 / 筛选+实时标注 / 单张分析 / 全字段可编辑 / 角色表查看+编辑 / 对话改库 / 导入导出 |

---

## 5. 数据现状（2026-11-08 19:50 快照）

| 项 | 值 |
|---|---|
| 新库 | **324 张**，173MB，`library/<md5[0:2]>/<md5[2:4]>/<md5>.<ext>` |
| 已分析 | 324（全部，QQ 新收的会自动起名+打标） |
| 有角色 | **243（75%）**，其中 **94 张是人工标注**（`char_conf=人工`，已锁定） |
| 未知角色 | 81（用户已决定：剩下的不再标） |
| 无标签 | **0**（324 张全有标签，闭集 18 词） |
| 角色表 | **38 条**（含吉伊卡哇三人组、兜底类别「默认的动物」「呆猫」） |
| 角色分布（前几名） | 默认的动物 75 / 大肥鱼 33 / 龙图 29 / 简笔小人 24 / doro 12 / 吉伊 10 / 耄耋 9 |
| QQ 来源 | **49 张** `source=qq`（自动收的，每天在涨） |
| **Aurabot 旧库** | 已删除（2026-11-07 21:0x，294 文件 / 169MB） |
| 回收站 | `trash/` 里有 2 张误收的游戏截图（`/meme rm` 删的，可恢复） |

---

## 6. 文档

| 文件 | 内容 |
|---|---|
| `README.md` | **门面**：能力、快速开始、命令、文档索引、已知边界 |
| `docs/00-decisions.md` | **ADR-0001 ~ 0021**（全部已定） |
| `docs/01-requirements.md` | 需求：流水线、状态机、功能需求、验收 |
| `docs/02-architecture.md` | 架构：模块、契约、数据模型、算法 |
| `docs/03-engineering-contract.md` | **工程契约**：五条保证、设计规则、改动五步验证 |
| `docs/04-acceptance.md` | **验收手册**：每个里程碑「做什么/怎么验/变化/怎么退」（数字是当时快照） |
| `CHANGELOG.md` | 按里程碑的变更记录（M0–M9 + 独立仓库说明） |
| `integrations/aurabot/meme-qq/` | Aurabot 模块源码（部署用 `node scripts/deploy-aurabot.mjs`） |

代码：`src/index.js`（Host 入口）、`src/commands.js`（命令分发）、`client.js`（界面，只调 HTTP）、
`src/lib/{parse,dhash,dedupe,store,db,pipeline,query,analyze,characters,charEdit,annotate,search,judge,archive,backup,http,doctor,tools}.js`、
`scripts/{deploy-aurabot,import-characters,bulk-analyze,reanalyze,verify,scan-library,cluster-appearance}.mjs`、
`test/{unit,integration,regression}`。

**另一个仓库**：`peak-rhythm`（峰谷节奏，Aurabot 模块，含节假日表和对 `dsh-meter` 的对表测试）。

---

## 7. 踩过的坑（别重犯）

| 坑 | 事实 |
|---|---|
| **BOM 吃数据** | `Set-Content -Encoding utf8` 写 BOM，`JSON.parse` 抛错被静默吞掉 → 角色表被清空过一次。已修：剥 BOM + `lastLoadError` |
| **~~别用 5.1 的 PowerShell 改中文文件~~** | 已从根上解决：profile 补丁让 `pwsh` 工具直接跑 PowerShell 7.6.9。历史：5.1 的 `Get-Content -Raw` 按 GBK 读 UTF-8 → 写回整篇乱码（`docs/04-acceptance.md` 中过一次，靠 `git checkout --` 救回）。**若哪天重装 DSH 后补丁丢了**，重新加 `pwsh-sandbox.pwshPath` 即可（见 §3） |
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
| **~~5.1 发中文会变问号~~** | 同样已从根上解决（pwsh 工具改跑 PS7）。历史：`Invoke-WebRequest -Body $中文`（PS 5.1）按 Latin-1 编码 → 服务端收到一串 `?`，实测把一条的外观写成问号（用 node 修回）。现在 PS7 下中文往返正常，已实测 |
| **面板页签是写死的** | `TAB_MODS = { stickers: ['stickers'] }`：只有内置 stickers 模块在跑，「表达 → 表情包」页才存在；自定义模块页只能落「平台/系统」两组 |
| **存图和回复要分开** | 早期版本让「存图」触发 `saveSignal`，删掉她这轮文字强塞表情。用户指出这是错的：存表情和回应是**两条并行互不干扰的路**，硬设「回」或「不回」都不对 |
| **hook 不能写在提前 return 之后** | 我在 `Detail` 里把 `useState` 放在「载入中」的 return 后面 → 首屏少调两个 hook，数据到了再调 → React 报错、**整个面板白屏**。已加源码级测试扫描这种写法 |
| **GET/POST 别放错分支** | `op=export` 写进了 POST 分支，客户端用 GET 调 → 「未知 op」。现在：`op=exports` 是 GET，`op=export` / `op=import` 是 POST |
| **判重日志可能显示「未命名」** | 模块本地快照有 60 秒缓存，刚入库那张还没进快照，日志里「撞上哪一张」会显示未命名。等一会儿再发就正常，**不是数据错** |
| **排序不能只按分数** | 同分时 SQLite 不保证 `ORDER BY` 并列的顺序，Windows 和 Linux 可能不一样（2026-11-08 CI 在 ubuntu 上红了一次）。排序要有兜底：分数 → 入库时间 → md5。另外 `insertItem` 以前把 `created_at` 写死成 `now()`，调用方传的 `createdAt` 被静默吞掉 |

---

## 8. 已知问题

1. **吉伊卡哇里有个「介于吉伊和乌萨奇之间」的角色**：白色/粉色、有长耳，既不像吉伊（小圆耳 + ω 嘴）也不像乌萨奇（鹅黄长耳）。**人和模型都不认识**，用户已决定：这类保持「未知」，**不要为了填满而硬套成吉伊或乌萨奇**。库里几张被手工标过的（`a6877fbe`、`230e3d52`、`a3d18227`）就留着，不再动
2. 剩下约 81 张未知角色用户已决定**不再标注**（多是真实照片猫狗、普通卡通小兽、真人表情，本来就不属于任何有名角色）
3. `大肥鱼飞起`、`惬意doro` 曾认错，收紧 look 后已修正
4. ~~73 张无标签~~ → 已补齐（闭集 18 词，`tagsOnly` 模式补锁定条目）；新收的图自动带标签
5. **6 张已分析但没外观**（加 appearance 列之前分析的），重跑一次 `--force` 就齐
6. 界面还没有删除按钮（命令有 `/meme rm`）、筛选条不含「疑似重复」

---

## 9. 下一步

**当前状态**：M0–M5、M7、M8、**M9（全部）** 完成；M6 基本完成（38 条角色表、94 张人工标注、标签全覆盖）。**205 项测试全绿**，两个仓库都干净。

**候选（按我判断的价值）**：

1. **相似传播**：改一张 → 预览「找到 N 张相似」→ 确认后批量改（M6 的 L3 归纳），给以后新增的图用
2. **删除入口上界面**：命令有 `/meme rm`，界面还没有按钮
3. **定时自动导出**：现在手动点；要加保留策略（`exports/` 每份 170MB，会越攒越多）
4. 小尾巴：界面「疑似重复」筛选、6 张无外观（`/meme analyze --force` 可补）

**已完结（不用再提）**：旧库已删（169MB）；角色表 6→38 并多轮去噪；标签全库补齐；导入导出可用（170MB / 0.2 秒）；峰谷节奏拆成独立仓库。

---

## 10. 工作方式约定（维护者的要求）

1. **每个里程碑按四段交付**：做什么 / 怎么验 / 你世界里的变化 / 怎么退；验收必须是用户能自己敲的命令 + 具体预期输出
2. **先讨论后开工**：架构、定位、取舍类问题先出方案再动手
3. **改代码后自查**：`node --test "test/**/*.test.js"` 全绿 + `node --check` + 需要时跑 `scripts/verify.mjs`
4. 维护者不读前端/JS 代码——**结论要能用命令复现，不能只说"测试通过"**
5. **数据改动要说明后果**：删/改/迁移前讲清影响面和怎么退
6. **不要为填满而硬套**：模型认不出就写「未知」，比认错强

---

## 11. 新会话怎么开始

1. `cd <克隆目录>\dsh-meme-brain`
2. 读本文（尤其 §0 快照和 §0.5「上次做了什么」），要细节再翻 `docs/04-acceptance.md`
3. 跑 `/meme doctor` + `node --test "test/**/*.test.js"` 确认没坏
4. 看 §9 挑一件做，或按用户当次要求来
5. 动 QQ 模块：改 `integrations/aurabot/meme-qq/` 后跑 `node scripts/deploy-aurabot.mjs`；
   峰谷模块在 `peak-rhythm` 仓库，改完跑它自己的 `node scripts/deploy.mjs`
