# dsh-meme-brain

> DeepSeek Harness 的表情包管理系统 — 从一张图进入系统，到被 AI 和人用上，全程有流程、有状态、有界面。

**状态**：设计定稿阶段，代码未开始
**平台**：DeepSeek Harness 插件（Host + Web Client）
**作者**：zy（UE 开发者，不维护前端代码）
**最后更新**：2026-11-07

---

## 这是什么

不是"一个表情库"，是**一套管理系统**：

```
接入 → 解析 → 去重 → 入库 → 分析 → 索引 → 消费
```

- **人对它做管理**：浏览、筛选、看分析结果、批量纠正、合并重复、导入导出
- **AI 对它做检索**：按情绪、角色、对象找到合适的图，找不到就不发
- **外部程序可以读**：本地 HTTP / 导出文件 /（后续）MCP

三端共享同一份数据和同一套判断。

---

## 已定决策

| # | 决策 | 记录 |
|---|---|---|
| ADR-0001 ~ 0006 | 自管存储 / dsh-meme 边界 / 索引可重建 / 判重前置 / 命令先行 / 不注入提示词 | [00-decisions.md](docs/00-decisions.md) |
| ADR-0011 ~ 0019 | 短名 / 留标签 / 默认库路径 / 16MB 上限 / sharp 全格式 / 卸载 dsh-meme / 暂不导入 / 删旧草稿 / 禁止第二套表情能力 | [同上](docs/00-decisions.md) |
| 待定 | ADR-0007 分析模型、ADR-0008 场景维度（阻塞 M4）；ADR-0009 界面、ADR-0010 MCP（阻塞 M8） | [同上](docs/00-decisions.md) |

---

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-requirements.md](docs/01-requirements.md) | 需求：流水线、状态机、功能需求、验收、里程碑 |
| [docs/02-architecture.md](docs/02-architecture.md) | 架构：包结构、接口契约、数据模型、算法 |
| [docs/03-engineering-contract.md](docs/03-engineering-contract.md) | **工程契约**：五条保证、设计规则、变更验证流程 |
| [docs/04-acceptance.md](docs/04-acceptance.md) | **验收手册**：每个里程碑"做什么/怎么验/变化/怎么退" |
| [docs/05-handoff.md](docs/05-handoff.md) | **上下文交接**：压缩上下文/换会话后从这里接着干 |
| [docs/00-decisions.md](docs/00-decisions.md) | 决策记录（ADR），含背景、决定、后果 |
| [research/](research/) | 立项前的实证脚本：dHash、格式统计、透明通道、跨库判重 |

---

## 目录结构

```
dsh-meme-brain/
├── README.md
├── docs/           设计文档（本项目的权威来源）
├── research/       立项前的验证脚本（只读参考）
├── src/            插件源码（待建）
├── test/           测试与夹具（待建）
└── package.json    DSH bundle 清单（待建）
```

---

## 工程原则（一句话版）

> **作者不读前端代码，因此正确性由结构保证：业务逻辑只在 Host，界面只渲染 JSON；任何操作都有非界面路径；数据用 `doctor` 自证。**

完整内容见 [工程契约](docs/03-engineering-contract.md)。

---

## 里程碑

| # | 内容 | 状态 |
|---|---|---|
| M0 | 插件骨架（可安装、命令壳、`doctor`） | 代码完成，已安装，待命令实测 |
| M1 | 解析 + 哈希 + 判重（离线） | ✅ 20 项测试全绿；真实库扫出 17 组重复 |
| M2 | 存储 + 索引 + 状态机 + 重建 | ✅ 代码完成（24 项测试通过），待你按手册验收 |
| M3 | 管理命令集 | ✅ 代码完成（33 项测试通过），待你验收 |
| M4 | 最简界面（网格 / 详情 / 单张编辑） | ✅ 代码完成，API 已验证，待你刷新页面验收 |
| M5 | 分析（七维评分 + 文字） | 未开始 |
| M6 | 角色表 + 标注 + 检索 | 未开始 |
| M7 | AI 工具 + cordis 服务 | 未开始 |
| M8 | 采集接入（QQ） | 未开始 |
| M9 | 完整界面 + 导入导出 + HTTP | 未开始 |

---

## 如何验证（每个里程碑结束时都应有）

```powershell
# 待实现：一份体检报告，不需要读代码就能判断系统是否健康
dsh meme-brain doctor
```

预期输出形态见 [工程契约 §4](docs/03-engineering-contract.md)。
