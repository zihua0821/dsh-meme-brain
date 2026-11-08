# dsh-meme-brain · 本机表情包管理系统

给 **DeepSeek Harness（DSH）** 用的表情包库：
**收图 → 判重 → 模型标注 → 检索 → 界面管理 → 接进 QQ**。

> 一句话：**人能用、AI 能用、QQ 里也能用**；库只有一份，全部在本机。

[![CI](https://github.com/YOUR-GITHUB-USER/dsh-meme-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-GITHUB-USER/dsh-meme-brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)](package.json)

---

## 为什么做这个

表情包散在几个地方：QQ 收藏、手机相册、下载目录、别人发来的动图。想找一张
「生气的、带攻击性的、适合回怼的」图，只能靠翻。而 AI 聊天时想让它配一张表情，
它手里没有库，只能瞎猜。

这个项目把这件事拆成一条完整的流水线，每一步都可独立验证：

```
建索引 ──▶ 解析(sharp) ──▶ 三帧 dHash ──▶ 字节 md5
                                            │
                     ┌──────────────────────┘
                     ▼
              判重（阈值 avg≤4 且 max≤8）──▶ 重复就丢，不写盘
                     │ 通过
                     ▼
        入库 <库>/<md5[0:2]>/<md5[2:4]>/<md5>.<ext>
                     │
                     ▼
   模型分析（角色/外观/图上文字/五维评分/场景/指向/标签/短名）
                     │
        ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼              ▼
     /meme 命令   侧栏界面     AI 工具        QQ 模块
                                (meme_find)   (表情脑)
```

**设计上的几条硬约束**（都在 [`docs/00-decisions.md`](docs/00-decisions.md) 里记了理由）：

- **判重只有一份实现**：目录导入和 QQ 收图共用 `ingestBuffer()`，没有第二条路径。
- **模型只从「角色表」里选**：表外的名字一律记为未知——宁可空着，也不硬套。
- **人工改过的东西自动上锁**（`pinned=1`），`--force` 重跑也改不动。
- **不做自动删图**：自动删 = 数据损失。
- **存表情和回消息是两条互不干扰的路**：收图是后台动作，绝不改写回复。

## 能做什么

| 能力 | 说明 |
|---|---|
| **收图** | 目录导入、`POST op=add`、QQ 群里/私聊自动收（动图、QQ 表情段、模型判定过的普通图） |
| **判重** | 三帧 dHash（256 位）+ 字节 md5；真重复距离 0，非重复最近 11，阈值留 3 位余量 |
| **标注** | 模型看图输出：角色 / 把握度 / 招牌文字 / 外观 / 五维评分 / 场景 / 指向 / 意图标签 / 短名 |
| **角色表** | 38 条（含吉伊卡哇三人组、兜底类别），**闭集**；每条 `look` 都写成排他特征 |
| **检索** | 人话找图：「生气的大肥鱼」「来张无语的」；工具 / 命令 / HTTP 共用一份判断 |
| **界面** | 网格 + 筛选条 + 详情抽屉（**每个字段都能改**）+ 角色表编辑 + 刷新 + 导入导出 |
| **QQ** | Aurabot 模块「表情脑」：发表情 / 自动配图 / 收表情 / 对话里改角色 |
| **备份** | 导出成 zip（图 + 全部标注 + 角色表）；导入**只补不覆盖**，md5 不符拒收 |
| **体检** | `/meme doctor`：文件与索引**独立核对**，孤儿 / 缺文件 / 重复簇 |

## 快速开始

**前置**

- DeepSeek Harness（DSH）0.2.x
- Node.js **≥ 22.13**（用到 `node:sqlite`；DSH 自带运行时满足即可）
- `sharp` 会自动装预编译二进制，Windows / macOS / Linux 都不用装 libvips

**1. 装插件**

```powershell
git clone https://github.com/YOUR-GITHUB-USER/dsh-meme-brain.git
cd dsh-meme-brain
npm ci

# profile 里 link 到本仓库：改代码即时生效，不用重装
dsh plugin --profile desktop add link:<克隆目录>\dsh-meme-brain
```

装好后 DSH 侧栏多一个「表情包」图标，会话里多一个 `/meme` 命令。

**2. 导一批图进来**

```
/meme import <你的表情包目录> --dry-run     # 先看会收多少、判重多少，不写盘
/meme import <你的表情包目录>
```

**3. 让模型标注**（要花钱，可以先小批量）

```
/meme analyze --limit=20
```

**4. 界面里看和改**

侧栏「表情包」→ 网格 → 点一张看详情。想筛「未知角色」「无标签」用顶部筛选条。

## 接进 QQ：Aurabot 模块「表情脑」

模块源码就在本仓库：[`integrations/aurabot/`](integrations/aurabot/README.md)。

```powershell
node scripts/deploy-aurabot.mjs      # 部署到 Aurabot 的 modules 目录，3 秒热加载
```

- 它是**独立模块**（id `meme-qq`），不顶替内置模块；内置 `stickers` 只是**在配置里停用**，
  想退回把 `modules.stickers.enabled` 改回 true 即可。
- 库、判重、分析都不在这里：模块全部走 `/meme-brain/api`，判重仍然只有一份。
- 参数在 Aurabot 面板「系统 → 表情脑」，14 项（发表情 / 自动配概率 / 收表情 /
  普通图怎么判 / 谁能对话改库 / 每小时上限 …）。
- 详细说明、权限、怎么退：[`integrations/aurabot/README.md`](integrations/aurabot/README.md)

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

**容易搞混的三个开关**：

| 开关 | 作用 |
|---|---|
| `--force` | 重跑已分析的图，**不动名字** |
| `--rename` | 才允许模型改写名字（保护人工标注） |
| `--include-pinned` | 人工锁定的条目默认跳过，加它才一起重跑 |

## HTTP API

只监听 `127.0.0.1`，路由前缀 `/meme-brain/api`。界面和 QQ 模块都只调这一套。

```
GET  ?op=list&limit=&offset=&q=&state=&sort=&character=&todo=
GET  ?op=item&md5=<前缀>          全部分析字段
GET  ?op=facets                   筛选条计数（角色分布/待办/锁定）
GET  ?op=find&q=&character=&emotion=&scene=&limit=   人话检索
GET  ?op=chars                    角色表 + 在库计数
GET  ?op=image&md5=<前缀>         二进制
GET  ?op=exports                  已有导出包
POST ?op=annotate  {md5,name?,tags?,character?,pin?}
POST ?op=analyze   {md5}          单张分析（3~6 秒，串行，锁定则 skipped）
POST ?op=add&source=qq            body=图片原始字节 → 判重入库
POST ?op=judge                    body=图片原始字节 → 模型判「是不是表情包」
POST ?op=export                   打包全库到 exports/*.zip
POST ?op=import    {path}         从 zip 还原（只补不覆盖）
POST ?op=char-save {name,originalName?,look?,from?,aka?,kind?}
POST ?op=char-rm   {name,force?}  有图在用时 409 E_IN_USE
```

## 数据在哪

```
%USERPROFILE%\.dsh\meme-brain\
├── library/          图（<md5[0:2]>/<md5[2:4]>/<md5>.<ext>）
├── index.db          SQLite（schema v3）
├── characters.json   角色表（首次启动从 characters.seed.json 种入 38 条）
├── judge-cache.json  「是不是表情包」的模型判定缓存（按 md5）
├── exports/          导出的完整备份 zip
├── backups/          索引快照
└── trash/            `/meme rm` 删掉的文件（可恢复）
```

全部在本机。`DSH_MEME_BRAIN_ROOT` 可以改根目录（测试用它指到临时目录）。

## 角色表与标签

- **角色表是闭集**：模型只能从表里的名字里选，对不上就记「未知」。名单越长越容易把
  「像的」认成「就是」，所以每条 `look` 都写成**排他性特征**（「真实白猫」而不是「猫」，
  「纯黑白简笔线条人、无五官」而不是「画的」）。
- **首次启动会种入 38 条**（`characters.seed.json`）；已经有角色表就不动，坏掉也不覆盖。
- **人工标注会锁定**：`char_conf=人工` + `pinned=1`，模型不会再改；想交还模型就 `/meme tag --unpin`。
- **标签是闭集 18 词**（卖萌 / 无语 / 委屈 / 疑惑 / 开心 / 嘲讽 / 震惊 / 生气 / 得意 /
  攻击 / 摸鱼 / 吃瓜 / 困 / 干饭 / 无奈 / 害怕 / 装傻 / 嫌弃），只在标签为空时补。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/00-decisions.md`](docs/00-decisions.md) | **ADR-0001 ~ 0021**：每个拍过板的决定和理由 |
| [`docs/01-requirements.md`](docs/01-requirements.md) | 需求：流水线、状态机、功能、验收标准 |
| [`docs/02-architecture.md`](docs/02-architecture.md) | 架构：模块、依赖方向、数据模型、算法、接口 |
| [`docs/03-engineering-contract.md`](docs/03-engineering-contract.md) | **工程契约**：五条保证、改动五步验证 |
| [`docs/04-acceptance.md`](docs/04-acceptance.md) | **验收手册**：每个里程碑「做什么 / 怎么验 / 变化 / 怎么退」 |
| [`docs/05-handoff.md`](docs/05-handoff.md) | **开发记录**：当时是什么状态、踩过哪些坑、下一步 |
| [`integrations/aurabot/README.md`](integrations/aurabot/README.md) | Aurabot 模块：安装、参数、权限、怎么退 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 改代码的规矩（先读工程契约） |
| [`CHANGELOG.md`](CHANGELOG.md) | 按里程碑的变更记录 |

> 文档里的数量是**写那一刻**的快照。当前数字以 `/meme doctor` 或界面右上角为准。

## 代码结构

```
src/index.js        Host 入口（只做注册与分发）
src/commands.js     /meme 命令分发
client.js           界面（只调 HTTP，无业务逻辑）
src/lib/            业务：parse / dhash / dedupe / store / db / pipeline / query /
                    analyze / characters / charEdit / annotate / search / judge /
                    archive / backup / http / doctor / tools
integrations/aurabot/meme-qq/   Aurabot 模块「表情脑」
scripts/            deploy-aurabot / import-characters / bulk-analyze / reanalyze /
                    verify / scan-library / cluster-appearance
test/               node:test（unit / integration / regression）
```

## 测试

```powershell
npm test                            # 全量（当前 212 项）
npm run verify                      # 文件与索引独立核对（不信数据库自述）
node --test test/unit/search.test.js # 单个文件
```

CI 在 `ubuntu-latest` / `windows-latest` × Node 22 / 24 上跑 `npm ci && npm test`。

## 已知边界

- **不做自动删图**（`maxLibrary` 已否决）：自动删 = 数据损失。
- **判重阈值固定**：`avg≤4 且 max≤8`。改它要重跑全库对比（`scripts/scan-library.mjs`）。
- **认不出的角色保持「未知」**：比如吉伊卡哇里那个「介于吉伊和乌萨奇之间」的角色，
  人和模型都不认识，就空着，不硬套。
- **付费操作有三个**：分析（每张一次模型调用）、看图起名、普通图判定（有缓存，可关）。
- **Aurabot 面板的「表情库」卡片是死的**（内置模块停用后接口 404），管库统一用 DSH 侧栏。
- **测试夹具是表情包样本**：`test/fixtures/` 里 5 张图来自网络表情包文化，仅用于测试，
  不在 MIT 许可覆盖范围内（见 [`test/fixtures/README.md`](test/fixtures/README.md)）。

## 隐私

- 库、索引、标注全部在本机 `%USERPROFILE%\.dsh\meme-brain\`，没有云端。
- HTTP 只绑定 `127.0.0.1`，不对外开放。
- 出网只有一种情况：调 DSH 的模型能力做分析 / 判定 / 起名（走你自己的 DSH 配置）。
- 没有遥测、没有统计上报。

## 贡献

先读 [`docs/03-engineering-contract.md`](docs/03-engineering-contract.md)：这个项目对
「为什么这么改」的要求比对「改得快」高。改动流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## License

[MIT](LICENSE)。`test/fixtures/` 下的测试图片是表情包文化样本，版权归各自作者，
仅用于测试，不在 MIT 覆盖范围内。
