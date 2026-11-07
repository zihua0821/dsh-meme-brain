# 架构设计

> 版本：v2（2026-11-07）· 与 [ADR-0001 存储自管](00-decisions.md) 对齐，替换 v1 的"纯索引层"定位
> 状态：设计定稿，待开工
> 相关：[需求](01-requirements.md) · [决策](00-decisions.md) · [工程契约](03-engineering-contract.md)

---

## 1. 定位

本插件就是**表情包管理系统的主体**：它既拥有库（存图片字节），也拥有判断（哈希/角色/分数），并同时向 AI、人、外部提供入口。

```
dsh-meme-brain
├─ 拥有：库、索引、判断
├─ 提供：命令、工具、cordis 服务、HTTP、Web 界面
└─ 不负责：QQ 收发（那是 Aurabot 的中继模块）
```

---

## 2. 不变量

| # | 不变量 | 违反后果 |
|---|---|---|
| 1 | **图片字节只存在于 `library/`**，索引里只存引用 | 备份/迁移/统计失真 |
| 2 | **索引可重建**：删除 `index.db` 后能从库重算 | 索引损坏变成事故 |
| 3 | **业务逻辑只在 Host**；`src/client.js` 不得 import `src/lib/*` | 前端 bug 能写坏数据 |
| 4 | **判重在入库前**，不是入库后 | 库会长出重复 |
| 5 | **任何能力都有非界面路径** | 界面坏了系统就不可用 |
| 6 | **不排除"没有合适结果"**：检索无匹配返回空，不随机兜底 | 选错图 |
| 7 | **不注入系统提示词**（ADR-0006） | 污染无关会话 |

---

## 3. 模块划分

```
src/
├── index.js          Host 入口：apply(ctx, config)，注册命令/工具/服务/路由
├── client.js         Web 入口：只调 HTTP，无业务逻辑
├── lib/
│   ├── parse.js      魔数识别、解码、尺寸/帧/透明/文字
│   ├── dhash.js      9×8 灰度 + 三帧 dHash + 汉明距离
│   ├── store.js      library/ 读写、md5 命名、软删除
│   ├── index.js      SQLite：schema、迁移、查询
│   ├── dedupe.js     候选检索与判定
│   ├── analyze.js    角色识别 + 多维评分 + OCR 编排
│   ├── characters.js 角色表读写与闭集提示词
│   ├── pipeline.js   编排：接入→解析→判重→入库→分析
│   ├── doctor.js     体检
│   ├── commands.js   命令实现（薄）
│   ├── tools.js      工具实现（薄，与命令同源）
│   └── http.js       本地路由
└── migrations/
    └── 001_init.js
```

**依赖方向**（只允许向下）：

```
index.js / client.js
        ↓
commands.js / tools.js / http.js     ← 薄壳，不含业务判断
        ↓
pipeline.js
        ↓
parse / dhash / dedupe / analyze / characters
        ↓
store.js / index.js
```

`client.js` 不在这条链上——它只能通过 HTTP 访问 Host。

---

## 4. 数据布局

```
~/.dsh/meme-brain/
├── library/                     ← 唯一事实源（图片字节）
│   └── ab/cd/abcd…ef.gif        ← 按 md5 前四位分桶，避免单目录爆炸
├── index.db                     ← 派生索引（可重建）
├── characters.json              ← 人工数据（不可重建，必须备份）
├── backups/
│   └── index-20261107-1300.db
└── config.json                  ← 运行时设置（可选）
```

**软删除**：`library/trash/<md5>.<ext>`，记录标记 `retired`。

---

## 5. 索引结构

```sql
-- 版本
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- schema_version, created_at, …

-- 主表
CREATE TABLE items (
  md5        TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,      -- 相对 library/ 的路径
  ext        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER, height INTEGER,
  frames     INTEGER DEFAULT 1,
  has_alpha  INTEGER DEFAULT 0,
  dhash      TEXT NOT NULL,             -- "h1,h2,h3" 十六进制
  name       TEXT,                      -- 短名（ADR-0011），允许重复，可空
  tags       TEXT,                      -- 逗号分隔的标签（ADR-0012），保留人工资产
  state      TEXT NOT NULL,             -- incoming|parsed|stored|analyzed|duplicate|failed|retired
  -- 分析结果
  text       TEXT,
  character  TEXT,
  char_conf  TEXT,                      -- high|mid|low
  score      TEXT,                      -- JSON: {valence,arousal,aggression,intimacy,absurdity,target}
  scene      TEXT,                      -- 逗号分隔场景：吃饭,摸鱼（ADR-0008）
  analyzed_at REAL, model TEXT,
  -- 来源与去重
  source     TEXT,                      -- qq:group:80147793 | qq:private:1393110779 | manual | import
  dup_of     TEXT,                      -- 判重命中的 md5（state=duplicate 时有效）
  dup_distance INTEGER,
  -- 人工覆盖
  pinned     INTEGER DEFAULT 0,         -- 人工确认后 AI 不得再改
  created_at REAL, updated_at REAL
);

CREATE INDEX idx_char   ON items(character);
CREATE INDEX idx_state  ON items(state);
CREATE INDEX idx_dup    ON items(dup_of);

-- 操作历史（审计 + 撤销）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  md5 TEXT, at REAL NOT NULL,
  action TEXT NOT NULL,                 -- store|analyze|annotate|merge|retire|restore
  detail TEXT,                          -- JSON
  actor TEXT                            -- system|human|model
);
```

**迁移**：`meta.schema_version` ÷ `migrations/NNN_*.js` 顺序执行，迁移前自动备份。

---

## 6. 对外接口

### 6.1 命令（人类首选，M3）

> **命令只在 DSH 会话中被解析**（由 Web 输入框提交）；在 QQ 里输入 `/meme` 不会触发它——QQ 消息走 Aurabot 自己的链路，末端是一个语言模型。
> QQ 侧的人机入口由 **M8 的中继模块**提供服务调用，或由模型通过 M7 的工具访问。
> 因此命令的定位是"维护者的控制台"，不是"用户界面"。

| 命令 | 作用 |
|---|---|
| `/meme list [--character=][--state=][--source=][--q=]` | 列出/筛选 |
| `/meme show <md5>` | 单张全部信息 |
| `/meme annotate <md5> --character= --valence= …` | 修改判断 |
| `/meme bulk --set-character= --ids=…` | 批量修改 |
| `/meme dupes [--threshold=]` | 重复簇 |
| `/meme merge <keep> <drop>` | 合并 |
| `/meme todo [--queue=]` | 待办队列 |
| `/meme char add/rm/list` | 角色表 |
| `/meme import <dir|zip> --tag=` / `/meme export [--all]` | 导入导出 |
| `/meme rebuild [--index]` | 重建索引 |
| `/meme doctor` | 体检 |
| `/meme explain <md5>` | 这张图经历了什么 |

### 6.2 cordis 服务 `memeBrain`（供 Aurabot 等）

```ts
interface MemeBrain {
  version: 1
  check({ bytes }): { dup: boolean; distance: number; md5: string; nearest?: {md5, path, caption} }
  ingest({ md5, bytes, source }): { recorded: boolean; path: string }
  find({ mood?, character?, target?, minScore?, limit? }): Hit[]
  byMd5(md5): Item | null
  byName(name): Item | null             // 重名时返回匹配最好的一张（ADR-0011）
  annotate(patch): { ok: boolean }
  status(): { total, analyzed, pending, dupGroups, characters }
}
```

### 6.3 工具（模型用，M6）

`meme_find` / `meme_annotate` / `meme_dedupe` / `meme_status`
——与命令同源，只做参数转换与结果摘要，不含逻辑。

### 6.4 HTTP（界面与外部用）

```
POST /meme-brain/api
  { op: 'list' | 'show' | 'annotate' | 'bulk' | 'dupes' | 'merge'
        | 'todo' | 'char' | 'import' | 'export' | 'rebuild' | 'doctor' | 'explain'
    ...args }
→ { ok: true, data } | { ok: false, error: { code, message } }
```

仅 loopback；响应结构固定，便于界面渲染。

---

## 7. 算法

### 7.1 解码

统一使用 `sharp`（libvips），单一代码路径（ADR-0015）。

| 格式 | 支持 | 说明 |
|---|---|---|
| JPEG / PNG / APNG | ✅ | APNG 用 `{page:n}` 取帧 |
| GIF | ✅ | `{animated:true}` 读 `pages`；`{page:n}` 取单帧 |
| WebP（静态/动态） | ✅ | 同上 |
| TIFF / HEIF / SVG | ✅ | libvips 直接支持 |
| 其它 | ❌ | `E_PARSE_UNSUPPORTED` |

统一处理链：

```js
sharp(buf, { page: n })            // 取第 n 帧
  .flatten({ background: '#fff' }) // 透明合成白底
  .resize(9, 8, { fit: 'fill' })   // 盒式降采样
  .greyscale()
  .raw()                           // → 72 字节，直接算 dHash
```

实测：904KB / 62 帧 GIF，每帧 **2ms**（原 gifuct 方案最大 245ms）。

### 7.2 三帧 dHash

```
采样帧：[0, ⌊n/2⌋, n-1]（不足则复用）
每帧：合成白底 → 灰度 → 盒式降采样 9×8 → 每行 8 次「左>右」→ 64bit
存：hex 三元组
```

**为什么必须合成白底**：实测 74 张 GIF 中 6 张带 alpha，不合成时最多偏 27 位。

### 7.3 判重

```
距离 = 三帧各自汉明距离
判定重复：avg ≤ thresholdAvg(4) 且 max ≤ thresholdMax(8)
```

实测：真重复对距离 0；库内最近非重复对 11（安全边际 3 位）。

候选检索：≤1 万张直接暴力（毫秒级）；超过则按 dhash 前 16 位分桶。

### 7.4 分析（评分 + 角色）

一次调用产出：

```
帧: 1
角色: 凯露 | 未知
角色把握: 高 | 中 | 低
文字: <图上文字>
情绪: 0.8   强度: 0.7   攻击: 0.1
亲密: 0.3   抽象: 0.6   指向: 无
场景: 吃饭,摸鱼
一句话: 猫猫抱着饭碗一脸满足
```

- 角色用**闭集选择**（注入角色表前 40 条），不在表里必须写「未知」；
- `temperature: 0`；
- 批量 4 张/次，按 `帧: N` 分块；解析失败整批重试一次，再失败记 `E_ANALYZE_PARSE`；
- 人工 `pinned=1` 的条目，自动分析跳过。

---

## 8. 体检与错误码

### 8.1 `meme doctor`

只读，输出：

```
schema_version   3（最新）
library 文件数   177
索引记录数       177
孤儿文件         0
索引缺文件       0
哈希抽检         20/20 一致
重复簇           1
待分析/低置信/失败  12 / 8 / 0
最近备份         2026-11-07 13:00
```

### 8.2 错误码

| 码 | 含义 | 处置 |
|---|---|---|
| `E_PARSE_UNSUPPORTED` | 格式不支持 | 记录，等待补解码器 |
| `E_PARSE_CORRUPT` | 文件损坏 | 进失败队列 |
| `E_DEDUPE_BLOCKED` | 判重拦截（非错误） | 计数 |
| `E_STORE_WRITE` | 写库失败 | 重试 / 报错 |
| `E_ANALYZE_MODEL` | 模型调用失败 | 重试 |
| `E_ANALYZE_PARSE` | 模型输出无法解析 | 重试一次后进队列 |
| `E_DB_MIGRATE` | 迁移失败 | 自动回滚到备份 |
| `E_LIB_MISSING` | 库目录不存在 | 降级为空库并提示 |

---

## 9. 与外部系统的边界

| 系统 | 关系 | 方式 |
|---|---|---|
| **Aurabot** | 采集与发送的管道 | 它调 `memeBrain.check/ingest`；发送时 `find` 取路径后自己发 |
| **dsh-meme** | 已卸载，不依赖（ADR-0016） | 若将来需要其图库，临时装回后按 pack 格式导入（ADR-0017） |
| **DSH LLM** | 分析用模型 | `ctx.llm`，模型可配置 |

---

## 10. 里程碑（与需求 §9 对应）

| 阶段 | 架构交付 |
|---|---|
| M0 | `index.js` 骨架 + 命令注册 + `doctor` 空实现 |
| M1 | `parse.js`（sharp）`dhash.js` `dedupe.js` + 夹具测试 | ✅ 已完成：20 项测试通过，真实库 288 张扫描 5.5s |
| M2 | `store.js` `db.js`（schema v1 + 迁移）+ 状态机 + `rebuild`/`repair` | ✅ 已完成：24 项测试通过；真实库 dry-run 292 张 / 17 判重 / 0 失败 |
| M3 | `commands.js`（list/show/annotate/dupes/todo/export） |
| M4 | `http.js` + `client.js`（最简界面：网格/详情/单张编辑） |
| M5 | `analyze.js`（七维 + 文字）+ 失败队列 |
| M6 | `characters.js` + 检索与标注闭环 |
| M7 | `tools.js` + `ctx.provide('memeBrain')` |
| M8 | 与 Aurabot 中继模块对接（采集前置判重） |
| M9 | 批量操作、待办视图、动图预览、导入导出 |

---

## 附录 · 已核实事实

| 事实 | 证据 |
|---|---|
| 真重复 dHash = 0，非重复最近 11 | `research/dist.mjs` |
| 透明底最多影响 27 位 | `research/alpha.mjs` |
| 格式：GIF 73 / JPEG 58 / PNG 9 / 单帧 GIF 1 / WebP 0 | `research/formats.mjs` |
| 最大 GIF 解码 245ms（gifuct 方案） | `research/bench-gif.mjs` |
| 跨库重复 0 对（Aurabot 141 张 vs dsh-meme 24 张） | `research/cross-scan.mjs` |
| Aurabot 模块可 `api.dsh.get()` 取到别的插件服务 | 探针日志（已验证） |
| Aurabot `hub.js:616` 依赖 `stickers` 服务对象 | 源码 |
| **sharp 8.18.7 可输入 jpeg/png/webp/tiff/gif/svg/heif/raw** | 本机实测（ADR-0015） |
| **sharp 取帧+缩放 2ms/帧（904KB / 62 帧 GIF）** | 本机实测 |
