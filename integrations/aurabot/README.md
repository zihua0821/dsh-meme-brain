# Aurabot 模块「表情脑」（meme-qq）

> 把 dsh-meme-brain 的表情库接到 QQ：**发表情、自动配图、收表情、对话里改角色**。
> 这是本仓库的第二个入口——第一个是 DSH 里的 `/meme` 命令和侧栏界面。

模块**不读索引、不重写判重**：库、判重、分析、评分都在 DSH 插件里，这里全部走
`http://<DSH>/meme-brain/api`。只有「把图片字节发给 QQ」这一步直接从库目录读文件。

---

## 前置

| 需要 | 说明 |
|---|---|
| DSH + `dsh-meme-brain` | 插件装好、在跑，`/meme doctor` 能出结果 |
| Aurabot 插件 | 本机的 QQ 插件，提供 `modules/` 目录、工具注册和 `hub` |
| 库已经进过图 | 一张都没有也能装，只是没东西可发 |

## 安装

```powershell
# 在仓库根目录
node scripts/deploy-aurabot.mjs

# 只部署这一个模块
node scripts/deploy-aurabot.mjs meme-qq
```

写到哪里：

```
%USERPROFILE%\.dsh\plugins-data\aurabot\modules\meme-qq\index.mjs
```

Aurabot **3 秒内热加载**（不用重启 DSH）。日志里能看到「文件改了，重新加载」；
之后发一条消息看 `表情脑` 的日志。

然后确认配置里是**它接管、内置停用**：

```yaml
modules.stickers.enabled: false          # 内置表情模块：代码保留，只停用
modules['gif-stickers'].enabled: false   # 旧动图模块也别抢
ext['meme-qq'].enabled: true             # 本模块
```

> 为什么不是顶掉内置模块：DSH/Aurabot 升级时内置模块还要照常升级；
> 想退回内置只改一个开关。早期版本用同名 id 顶过内置，已废弃（ADR 里记过）。

## 它接住的三条路

内置 `stickers` 停用后，她原本的三条表情行为由本模块接管：

| 原来（内置模块） | 现在（本模块） |
|---|---|
| 回复里的 `<sticker:标签>` → hub 调内置 `match` | `reply/items` 里换成库里的图 |
| `stickers.autoChance` 自动配一张 | `reply/items` 里按本模块概率补一张 |
| hub 调内置 `collect` 偷表情 | 自己的 `message` 监听 |

**挑图优先级**（`pickForReply`）：回复点名的角色 → 意图标签 → 随机。
所以「来只耄耋」必须用 `meme_send` 把角色名传进去；只回一句话等自动配图会发错——
这条也写进了给模型的规则里。

## 收表情：怎么判断「这张算不算」

按顺序，命中就收（ADR-0020）：

1. **字节是真动图**（GIF 多帧 / 动 WebP / APNG）→ 收。内置模块漏掉的主要是这类。
2. **QQ 自己标成表情段**（`sub_type` = 1 收藏 / 7 大表情 / 11 动图表情）→ 收。
3. 其余**普通静态图** → 问模型（`POST op=judge`，只回 `{sticker, why}`）：
   - 是表情包 → 收；不是 → 记日志，不进库
   - 结果按 md5 缓存在 `judge-cache.json`，同一张重发不再花钱
   - 模型不可用 → 退回尺寸兜底（近方形 0.6~1.7、边长 ≤ 600、≤ 512KB）
4. 想全关：`judgeMode = off`（只收动图和 QQ 标记的表情段）。

> 为什么不看文件名：QQ 给所有图片都起 `<32位md5>.jpg` 这种名字。
> 早期按文件名判，收进过两张游戏截图；后来按尺寸猜，边界必错。最后走模型判定。

## 工具

给模型用的 8 个工具（都在 Aurabot 的工具表里）：

| 工具 | 作用 | 权限 |
|---|---|---|
| `meme_find` | 按整句找图（角色 + 情绪 + 图上文字），只回结果不发 | 任何人 |
| `meme_send` | 找图并**直接把图发出去** | 任何人 |
| `qq_send_sticker` | 发指定 md5 / 名字的图 | 任何人 |
| `qq_list_stickers` | 列库（角色分布、最近入库） | 任何人 |
| `qq_edit_sticker` | 改名字 / 标签 | 任何人 |
| `qq_set_character` | **对话里改角色表**（「这张是 doro」） | 只主人（可配） |
| `qq_collect_sticker` | 手动收一张进库 | 任何人 |
| `qq_save_sticker` | 把某条消息里的图存下来（补录） | 任何人 |

`qq_set_character` 的定位顺序：**md5 前缀 > 名字 > 这个聊天最近那张图（10 分钟内）**。
权限是**硬校验**：比对最近一条消息的发送者和 `ownerQQ`，不是靠提示词。

## 参数（14 项）

Aurabot 面板 → **系统 → 表情脑**：

| 参数 | 默认 | 说明 |
|---|---|---|
| 发表情 | 开 | 总开关；关掉不发表情，但收表情不受影响 |
| 自动配表情的概率 | 0.35 | 0 = 完全不用自动配 |
| 收表情 | 开 | 总开关 |
| 从群里收 / 从私聊收 | 开 / 开 | 分开控制 |
| 怎么收 | 全都收 | 全都收 / 只听主人的 / 她挑（先记着，她凭编号收） |
| 每小时最多收 | 20 | 0 = 不限 |
| 看图起名 | 开 | 收下后调一次视觉模型起名打分；**唯一花钱的步骤** |
| 收取单张上限 | 8 MB | 内置卡 1.5MB，大动图永远收不进来 |
| 发送单张上限 | 5 MB | 超过不发（网关会拒） |
| 普通图片怎么判 | 问模型 | 问模型 / 按尺寸猜 / 不收普通图片 |
| （旧）按尺寸收普通图片 | 关 | 只在「按尺寸猜」时生效 |
| 谁能对话改库 | 只有主人 | 只有主人 / 谁都可以 / 关掉 |
| 夹 QQ 小黄脸 | 开 | 插件原有功能，归到这里统一管 |

> 参数的唯一来源是本模块的设置。hub 还认的 `config.stickers` 字段由模块**镜像**过去
> （`enabled` 恒为 false），所以别手改那份——会被下一次镜像覆盖回来。

## 两条不能违反的原则

1. **存图和回应是两条独立的路**：存图是后台动作，绝不改写她这一轮的回复。
   工具结果做得极淡（只回一个「好」），规则里明确「别提存图、别提库」。
   （早期版本用 `saveSignal` 删掉文字强塞表情，已废弃。）
2. **判重只有一份**：收图走 `POST op=add`，内部是 `src/lib/pipeline.js` 的 `ingestBuffer()`；
   模块里绝不重写阈值或 md5 判断。

## 怎么退

```yaml
modules['meme-qq'].enabled: false     # 关掉本模块
modules.stickers.enabled: true        # 内置模块重新接管
```

- 内置模块的**代码一直都在**，只是被配置停用，所以这条路随时能走。
- 注意：内置模块用的是**另一份旧库**（`plugins-data/aurabot/stickers/`）。
  本项目不迁移、不删除它；两边不共享数据。
- 本模块只在 `%USERPROFILE%\.dsh\plugins-data\aurabot\modules\meme-qq\` 留一个 `index.mjs`，
  删掉目录即彻底消失。

## 已知限制

1. **进不了「表达」页签**：面板里 `TAB_MODS = { stickers: ['stickers'] }` 写死了——
   只有内置 `stickers` 模块在跑，那个页签才存在。所以参数页落在「系统」组。
2. **Aurabot 面板的「表情库」卡片是死的**（内置 `/ext/stickers/...` 接口随模块停用而 404）。
   管库请用 DSH 侧栏「表情包」界面。
3. **镜像字段别手改**（见上）。
4. 发送时会从库目录读字节：`DSH_MEME_BRAIN_ROOT` 要和 Host 用同一个值（默认都是
   `%USERPROFILE%\.dsh\meme-brain`），否则「找得到但发不出去」。

## 测试

不需要起 Aurabot，测试里用假的 `api`：

```powershell
node --test test/unit/aurabot-module.test.js
```

覆盖：参数默认值与清理、`<sticker:>` 转换、自动配图概率、收图判定四步、
`qq_set_character` 的权限硬校验、`api.setConfig` 深合并的坑。
