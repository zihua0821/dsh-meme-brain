# 表情包管理系统（dsh-meme-brain）

给 **DeepSeek Harness** 用的本机表情包库：收图 → 判重 → 模型标注 → 检索 → 界面管理 → 接进 QQ。

> 一句话：**人能用、AI 能用、QQ 里也能用**，库只有一份，全部在本机。

---

## 现在能做什么

| 能力 | 说明 |
|---|---|
| **收图** | 目录导入、`POST op=add`、QQ 群里/私聊自动收（动图、表情段、模型判定过的普通图） |
| **判重** | 三帧 dHash（256 位），字节级 md5 + 近似判重，**只有一份实现**（`ingestBuffer()`） |
| **标注** | 模型看图输出：角色 / 把握度 / 招牌文字 / 外观 / 五维评分 / 场景 / 指向 / 意图标签 / 短名 |
| **角色表** | 38 条（含吉伊卡哇三人组、兜底类别），**闭集**：模型只能从表里选，`look` 写成排他特征 |
| **检索** | 人话：「生气的大肥鱼」「来张无语的」；工具 / 命令 / HTTP 共用一份判断 |
| **界面** | 网格 + 筛选条 + 详情抽屉（**每个字段都能改**）+ 角色表编辑 + 刷新 + 导入导出 |
| **QQ** | Aurabot 模块「表情脑」：发表情/收表情/找图/对话里改角色，**存图与回应互不干扰** |
| **备份** | 导出成 zip（图 + 全部标注 + 角色表），导入**只补不覆盖** |
| **体检** | `/meme doctor`：文件与索引独立核对，孤儿/缺文件/重复簇 |

## 快速开始

```powershell
# 1) 装插件（profile 里 link 到本仓库，改代码即时生效）
dsh plugin --profile desktop add link:F:\dsh-meme-brain

# 2) 导一批图进来
/meme import D:\我的表情包 --dry-run     # 先看会收多少、判重多少
/meme import D:\我的表情包

# 3) 让模型标注（要花钱，可以先小批量）
/meme analyze --limit=20

# 4) 界面看/改
#    DSH 侧栏「表情包」→ 网格 → 点一张看详情
```

**接进 QQ**（另需 Aurabot）：

```powershell
node scripts/deploy-aurabot.mjs          # 部署「表情脑」模块，Aurabot 3 秒热加载
# Aurabot 面板 → 系统 → 表情脑 → 参数都在那儿（14 项）
```

## 常用命令

```
/meme doctor                              体检（文件与索引独立核对）
/meme list [--character=大肥鱼 --todo=nochar --q= --limit=]
/meme show <md5前缀>                       单张全部字段
/meme find 生气的大肥鱼                     人话找图
/meme tag <md5前缀> --character=doro --tags=卖萌 --appearance=... --unpin
/meme char list | add <名字> [--look= --from= --aka=] | rm <名字> [--force]
/meme analyze [--limit=N] [--force] [--md5=前缀] [--tags-only]
/meme rm <md5前缀> [--yes]                 软删除（文件进 trash/，可恢复）
/meme rebuild | repair | dupes | todo
```

## 数据在哪

```
%USERPROFILE%\.dsh\meme-brain\
├── library/          图（<md5[0:2]>/<md5[2:4]>/<md5>.<ext>）
├── index.db          SQLite（schema v3）
├── characters.json   角色表
├── judge-cache.json  「是不是表情包」的模型判定缓存（按 md5）
├── exports/          导出的完整备份 zip
├── backups/          索引快照
└── trash/            `/meme rm` 删掉的文件（可恢复）
```

全部在本机；HTTP 只监听 `127.0.0.1`。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/00-decisions.md](docs/00-decisions.md) | **ADR-0001 ~ 0021**：每个拍过板的决定和理由 |
| [docs/01-requirements.md](docs/01-requirements.md) | 需求：流水线、状态机、功能、验收标准 |
| [docs/02-architecture.md](docs/02-architecture.md) | 架构：模块、依赖方向、数据模型、算法、接口 |
| [docs/03-engineering-contract.md](docs/03-engineering-contract.md) | **工程契约**：五条保证、改动五步验证 |
| [docs/04-acceptance.md](docs/04-acceptance.md) | **验收手册**：每个里程碑「做什么/怎么验/变化/怎么退」 |
| [docs/05-handoff.md](docs/05-handoff.md) | **交接文档**：现在是什么状态、踩过哪些坑、下一步 |
| [CHANGELOG.md](CHANGELOG.md) | 按里程碑的变更记录 |

> 文档里的数量是**写那一刻**的快照。当前数字以 `/meme doctor` 或界面右上角为准。

## 代码结构

```
src/index.js     Host 入口（注册命令/工具/服务/路由）
client.js        界面（只调 HTTP，无业务逻辑）
src/lib/         业务：parse/dhash/dedupe/analyze/characters/search/annotate/
                 charEdit/judge/pipeline/archive/backup/store/db/doctor/http
scripts/         deploy-aurabot / import-characters / bulk-analyze / reanalyze / verify
integrations/aurabot/meme-qq/   Aurabot 模块「表情脑」源码
```

## 测试

```powershell
node --test "test/**/*.test.js"     # 全量
node scripts/verify.mjs             # 文件与索引独立核对（不信数据库自述）
```

## 已知边界

- **不做自动删图**（`maxLibrary` 已否决）：自动删 = 数据损失。
- **判重阈值固定**（avg≤4 且 max≤8）：真重复距离 0，非重复最近 11。
- **「介于吉伊和乌萨奇之间」那个角色不认识**：按未知处理，不硬套。
- **付费操作有三个**：分析（每张一次模型）、看图起名（可关）、普通图判定（可关/可缓存）。
- Aurabot 面板的「表情库」卡片是死的（内置模块停用后接口 404），管库统一用 DSH 侧栏。

## License

MIT
