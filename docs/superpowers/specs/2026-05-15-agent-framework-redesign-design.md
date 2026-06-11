# Agent Framework Redesign — Design Doc (WIP)

**Status:** Draft / brainstorming in progress
**Date started:** 2026-05-15
**Author:** victor530914@gmail.com (with Claude)
**Replaces:** Eliza-based orchestration in senti-agent 2.0

---

## 0. 目标 & 背景

第一性原理重写 senti-agent 的编排层，摆脱 Eliza / LangGraph 的复杂度。
核心思想：**一个主 agent 与用户对话，多个具备不同工具池的子 agent 执行具体任务**。
类比 Claude Code 的 subagent 架构。

---

## 1. 已确认的设计决策

| # | 决策点 | 选定方案 | 备注 |
|---|---|---|---|
| 1 | 项目定位 | **替换当前 senti-agent 框架** | 现有 plugin 改造为子 agent 的工具池 |
| 2 | 子 agent 定义 | **混合：预定义专家 + 动态 general-purpose** | 类似 Claude Code subagent_type |
| 3 | 主 agent 工具能力 | **能直接调用，但只限轻量工具** | 重型任务必须委派 |
| 4 | 子 agent 返回格式 | **结构化 JSON（Zod schema 校验）** | 每个子 agent 声明 output schema |
| 5 | 并行执行 | **支持，主 agent 一轮可 fan-out 多个 task** | 用 `dispatch(tasks[])` |
| 6 | 流式输出 | **只流主 agent 的 token；子 agent 发结构化 progress 事件** | 通过同一 SSE 通道复用 |
| 7 | 执行模型 | **默认同步阻塞；长任务可选异步（带 task_id）** | 适配 3+ 分钟分析、审批场景 |
| 8 | 记忆模型 | **主 agent 拥有 memory；子 agent 完全无状态** | 子 agent 可缓存可测可并发 |
| 9 | 迁移路径 | **Big-bang 重写** | 不与 Eliza 共存 |
| 10 | Orchestrator 内核 | **方案 B：LLM Loop + 类型化 Dispatcher 服务** | 编排机制是确定性代码，主 agent prompt 保持精简 |
| 11 | 子 agent 实现 | **每个子 agent 是独立 LLM 实例 + 工具子集 + system prompt + description** | 主 agent system prompt 注入 description registry，按描述选择 dispatch |
| 12 | TaskPool 存储 | **DocumentDB 持久化** | 容器重启可恢复；用户刷新页面仍能拿结果；带 TTL |
| 13 | general-purpose 工具子集 | **主 agent 在 dispatch 调用里显式列出 tools 数组** | `dispatch({ type: 'general-purpose', tools: [...], task })`，主 agent 负责限范围 |
| 14 | Transcript 存储格式 | **Append-only JSONL（DocumentDB collection，每条消息单独 doc）** | Crash safe；可流式恢复；便于审计 |
| 15 | 子 agent transcript | **持久化，但主 agent 不读；仅调试/审计用** | 物理隔离写 `subagent_transcripts`，TTL 7 天 |
| 16 | Memory 模型 | **混合：同 session 完整 transcript + 跨 session profile + RAG 检索** | 跨 session 不自动回放对话，需主 agent 主动查 RAG / 读 profile |
| 17 | Transcript compaction | **接近阈值自动摘要旧消息（参考 Claude Code）** | 阈值待定（建议 70% × max context）；用便宜模型压缩 |
| 18 | 重启恢复语义 | **主 agent 对话可恢复 + 异步 task 可恢复** | Transcript 由用户下一条消息触发重装；async task 由 worker 扫库重启或超时标 failed；sync task 丢失返回错误让主 agent 重试 |
| 19 | 子 agent 颗粒度轴 | **按"阶段"切，不按"领域"切** | 3 个 specialist（collector / processor / trader）+ general-purpose；摒弃 7-domain 方案 |
| 20 | collector vs processor 边界 | **按输出型态分：processor 产结构化判断/打分/预测；collector 产 facts（可含轻量加工如摘要+源）** | 例：sentiscore 拆两步（collector 拉文本，processor 算分）；news 全程在 collector；prediction 全程在 processor |
| 21 | charts 工具归属 | **processor 的工具** | 图表是"结构化判断"的一种呈现，跟决策 #20 一致；artifact 引用随 TaskResult 返回 |

---

## 2. 候选方案回顾（Orchestrator 内核）

| 方案 | 描述 | 选定 |
|---|---|---|
| A | 纯 LLM Loop（Swarm 风格），dispatcher 当作普通 tool | ❌ 工具层会臃肿 |
| **B** | **LLM Loop + 独立 Dispatcher 服务（确定性代码）** | ✅ |
| C | 图编排（LangGraph 简化版） | ❌ 违背摆脱 LangGraph 的初衷 |

---

## 3. 架构概览（§1，已呈现）

```
User / Client (HTTP + SSE)
        │
Orchestrator Agent (主 agent, LLM 循环)
  - 唯一与用户对话；持有 memory；流 token
  - 工具：轻量工具 + dispatch() + await_task()
  - System prompt 注入：所有 subagent 描述清单
        │ tool call
Dispatcher (确定性代码层)
  - SubagentRegistry: name → {description, tools, system, model, schema}
  - run(tasks[]): 并行 fan-out, 同步阻塞
  - submit(tasks[]) → task_id[]: 异步, 入 TaskPool
  - await(task_id, timeout)
  - 进度事件 → SSE 通道（progress, 不是 token）
  - 结构化返回 schema 校验
        │
   ┌────┼─────┬─────────────────┐
   ▼    ▼     ▼                 ▼
 Sub-A  Sub-B  ...   general-purpose (动态)
 (LLM)  (LLM)        tools: 主 agent 选子集
   │    │      │           │
   └────┴──────┴───────────┘
         │
   Tool Pool (现有 plugin → 纯函数工具)
```

### 核心组件表

| 组件 | 职责 | 类型 |
|---|---|---|
| **Orchestrator** | 主 LLM 循环；唯一对用户输出 token；持有 memory；调用 dispatch | LLM 驱动 |
| **Dispatcher** | 注册表 + 并行 + 异步 task pool + 进度事件 + schema 校验 | 确定性代码 |
| **SubagentRegistry** | 启动时加载所有子 agent 定义 | 静态 + 动态注册 |
| **Subagent Worker** | 一次一用的 LLM 循环；返回 JSON 后销毁；不见用户 | LLM 驱动 |
| **Tool Pool** | 现有 plugin 函数改造为无状态 callable | 纯函数 |
| **TaskPool** | 异步任务存储（DocumentDB），TTL，状态机 | 持久化 |
| **MemoryStore** | 主 agent 会话 memory + RAG（沿用 DocumentDB） | 持久化 |
| **SSE Transport** | token 流 + progress 事件复用 | I/O 层 |

### 关键边界

- 子 agent **不见会话历史**：fresh context，输入只有 task + 参数
- 主 agent **不见子 agent 中间过程**：只收最终 JSON
- Tool Pool 物理共享，但每个子 agent 声明可见子集

---

## 4. State 架构（§3，进行中）

### 4.1 State 切片原则（参考 Claude Code）

State 按**生命周期 × 作用域**切成独立的 store，不做"巨型 SessionState 对象"。

| Store | 生命周期 | 作用域 | 物理存储 |
|---|---|---|---|
| **Session Store** | 长（可恢复） | 单 session | DocumentDB `sessions` collection（元数据） |
| **Transcript Store** | 长（跟 session 同寿） | 单 session | DocumentDB `transcripts` collection（**append-only JSONL，每条消息一个 doc**） |
| **Task Store** | 短（TTL 7d） | 单次 dispatch | DocumentDB `tasks` collection（任务状态 + 输入输出） |
| **Subagent Transcript Store** | 短（TTL 7d） | 单次 dispatch | DocumentDB `subagent_transcripts` collection；**主 agent 不读，仅调试/审计** |
| **Memory Store** | 永久 | 跨 session（按用户/项目） | DocumentDB（profile / RAG 向量） |
| **Settings Store** | 永久 | 多层合并 | 文件/DB（user / workspace / session） |
| **Approval Store** | 短（TTL 15min） | 单次审批 | DocumentDB（CEX 等待审批） |
| **Artifact Store** | 永久 | 跨 session | S3 + DocumentDB 引用（图表/报告） |
| **Runtime State** | 进程级 | 进程 | 内存（Orchestrator 实例、Dispatcher in-flight map、SSE 连接表） |

### 4.2 关键设计选择

- **Transcript = append-only JSONL**：每条消息/tool_call/tool_result 单独入库；crash 不丢；可流式重放恢复。
- **主 agent 与子 agent transcript 物理隔离**：写不同 collection，不同 TTL。主 agent 上下文里只有子 agent 返回的 `TaskResult`（短 summary + 可选 data + artifacts 引用）。
- **没有"shared agent state"**：跨 session 知识走 Memory Store（类似 Claude Code CLAUDE.md + memory 文件），不试图持久化 agent 实例。
- **Settings 合并 deny-first**：参考 Claude Code 的 managed > local > project > user，deny 永远赢。

### 4.3 已敲定的细项

- **Memory（决策 #16）**：
  - **同 session**：transcript 全量在 context（受 compaction 约束）
  - **跨 session**：不自动回放对话；提供 `query_memory(filter)` 工具让主 agent 主动检索
    - profile：用户偏好（关注币种、语言、交易风格）→ 自动注入 system prompt
    - RAG：历史 transcript / 报告 / 文档向量化，按需查
- **Compaction（决策 #17）**：
  - transcript token 超过阈值（建议 70% × model max context）时，触发后台摘要
  - 用便宜模型（如 Haiku）把最早 N 条消息压成一段 system note
  - 子 agent 返回的 TaskResult 在被摘要时，**优先丢 `data` 字段，保留 `summary` + `artifacts` 引用**
- **重启恢复（决策 #18）**：
  - 主 agent transcript：JSONL 在库，下一条用户消息触发重装
  - async task：启动时 `worker.recover()` 扫 `status=running` 且 `updated_at` 超时的 → 标 failed / 或重启
  - sync task：连接断了主 agent 会拿到错误，自行决定重试
  - SSE：客户端用 `last_event_id` header 重连，dispatcher 重放未确认事件

### 4.4 仍未决定

- [ ] Approval Store：嵌入 task doc 还是独立 collection？（CEX 审批）
- [ ] 多副本 / 多容器下的 Dispatcher 协调（短期单容器够用，未来要不要 Redis 协调？）
- [ ] Settings 合并层数：4 层（managed/user/workspace/session）还是简化为 2 层？

---

## 5. 待讨论 / 未决定（顶层）

- [x] ~~§1 收尾~~ → 决策 #12 #13
- [x] ~~§2 数据流（消息协议层）~~ → 已展示，暂搁置，先定大框架
- [x] ~~§3 State 架构（顶层切片）~~ → 决策 #14 #15，4.3 还有细项
- [ ] **§4 子 agent 清单**：基于现有 plugin 划分哪些专家
- [ ] **§5 错误处理**：子 agent 失败重试策略；超时；schema 校验失败；部分 fan-out 失败
- [ ] **§6 审批流（CEX）**：异步 task pause + human-in-the-loop 怎么塞进新模型
- [ ] **§7 持久化与恢复**：异步任务在容器重启后的恢复语义
- [ ] **§8 流式协议**：SSE 事件 schema（token / progress / dispatch / result / error）
- [ ] **§9 测试策略**：dispatcher 单测；子 agent 离线评估；端到端
- [ ] **§10 技术栈**：保持 TypeScript + pnpm 单仓？模型 SDK 选型？
- [ ] **§11 迁移与下线**：现有 13-step comprehensive analysis 怎么映射；scheduler；CEX；daily report

---

## 6. 决策日志（按时间）

- 2026-05-15: 启动 brainstorming，确认 11 项设计决策（见 §1）
- 2026-05-15: 选定方案 B，主 agent 通过 dispatch tool 调用 Dispatcher 服务
- 2026-05-15: 用户要求把进度写入文档防止遗忘 → 创建本文档
- 2026-05-18: 调研 Claude Code state 设计，定 §3 顶层切片（决策 #14 #15）；待续 4.3 细项
- 2026-05-18: 定 4.3 三项（决策 #16 #17 #18）；剩 4.4 三项待定
- 2026-05-18: 推翻 7-domain 子 agent 草案；改"按阶段切"——3 specialist + 1 general（决策 #19 #20）

---

*本文档为 WIP，会持续更新到 brainstorming 完成后定稿。*
