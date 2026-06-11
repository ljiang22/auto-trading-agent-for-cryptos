# CEX Workflow（交易信息工作流）技术设计

## 背景与现状

当前消息处理基于 “分类 → 分流 → 处理器(workflow)” 的模式：

- 分类：`packages/core/src/handlers/langGraphPrecheck.ts`
  - 模板：`packages/core/src/templates/messageClassificationTemplate.ts`
  - 分类枚举：`packages/core/src/core/types.ts` (`MessageClassificationType`)
- 分流：`packages/core/src/core/runtime.ts` (`routeMessage`)
- 三个现有 workflow：
  - Regular：`packages/core/src/handlers/regularMessageHandler.ts`（`REGULAR_MESSAGE`）
  - Task Chain：`packages/core/src/handlers/taskChainHandler.ts`（`TASK_CHAIN_MESSAGE`）
  - Comprehensive Analysis：`packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts`（`COMPREHENSIVE_ANALYSIS_MESSAGE`）

目前与“交易/交易流水/交易执行/链上交易(Transaction)”相关的问题，会被混入上述三类，导致：

- 交易实体（`txHash` / `address` / `orderId` / `symbol` / `chain` / `timeRange`）抽取不统一
- 数据拉取动作(Action)组合不稳定（有时过度使用 task-chain，有时不足）
- 输出缺少交易领域的固定结构（费用、滑点、成交均价、PnL、风险提示等）
- 与数据保留策略（`getDataRetentionConfig`）结合不清晰

因此需要新增第 4 个专用 workflow：**CEX Workflow**，专门处理交易信息类请求。

## 目标（Goals）

1. **更精准的路由**：把交易信息类消息从通用对话/任务链/综合报告中分离出来。
2. **更强的实体抽取与归一化**：将交易相关输入统一映射到可执行的参数模型。
3. **可控的 Action 计划**：基于意图选择最少且充分的数据动作，避免过度执行。
4. **固定结构输出**：给用户“事实 → 解释 → 风险 → 下一步”的稳定答复结构，可选生成结构化结果供前端展示。
5. **流式可观测**：沿用现有 `StreamingCallback`，提供阶段性进度与可定位的错误信息。

## 非目标（Non-Goals）

- 不做自动下单/撤单/资金操作（不引入交易执行权限）
- 不保证链上/交易所数据的绝对正确性（必须保留不确定性提示）
- 不做高频/实时订单簿级别的持续订阅（仍以“请求-响应”的查询为主）
- 不存储或回显敏感密钥/隐私信息（API key、私钥、助记词等）

## 术语与范围（仅交易所/CEX）

本 workflow 仅覆盖 **交易所（CEX）交易信息**，不包含链上交易（txHash / 地址流水 / 合约事件等）。

这里的“交易信息”主要指：

- 订单（Order）：挂单、撤单、部分成交、订单状态、限价/市价/止损等
- 成交（Trade/Fill）：分笔成交、成交均价、成交数量、手续费
- 仓位（Position）：杠杆、保证金模式、开平仓、持仓均价、未实现/已实现 PnL
- 资金费（Funding）与费用（Fees）：funding、手续费、借贷利息（若适用）

## 路由设计：新增第 4 类分类

### 新的分类枚举

新增：

- `CEX_WORKFLOW_MESSAGE`

需要同步修改位置：

- `packages/core/src/core/types.ts`：扩展 `MessageClassificationType`
- `packages/core/src/templates/messageClassificationTemplate.ts`：扩展分类说明与 JSON schema
- `packages/core/src/handlers/langGraphPrecheck.ts`
  - `parseClassificationResponse` 白名单
  - `getClassificationDisplayName`
- `packages/core/src/core/runtime.ts`：`routeMessage` switch 增加 case，调用新的 handler

### 典型触发条件（用于 LLM 分类提示）

应该优先路由到 `CEX_WORKFLOW_MESSAGE` 的例子：

- “帮我看下这笔成交：tradeId=...，手续费是多少？”
- “orderId=... 为什么没成交/部分成交？”
- “我这周 BTC/USDT 的成交统计、均价、手续费汇总”
- “解释这笔合约仓位的 PnL 变化、资金费影响”
- “给我按币种统计这段时间的成交次数、成交额、净买入/净卖出”

不应路由到 CEX Workflow 的例子：

- “生成完整市场研究报告/投资报告”（应走 `COMPREHENSIVE_ANALYSIS_MESSAGE`）
- “对多个币做系统性研究、要多步任务规划”（应走 `TASK_CHAIN_MESSAGE`）
- 普通对话、单一价格查询（应走 `REGULAR_MESSAGE`）

### 路由优先级建议

为了减少“交易消息被综合报告吞掉”的情况，建议优先级（逻辑上）为：

1. 显式 override（metadata / feature flag）
2. `COMPREHENSIVE_ANALYSIS_MESSAGE`（当用户明确要“报告/全面研究”）
3. `CEX_WORKFLOW_MESSAGE`（当用户核心是交易/流水/tx 分析）
4. `TASK_CHAIN_MESSAGE`（复杂多步但非交易核心）
5. `REGULAR_MESSAGE`

说明：最终仍由 LangGraph Precheck 的 LLM 分类决定；这里是模板提示与回退策略建议。

## Workflow 设计：CEXWorkflowMessageHandler（类似 Regular）

### 新增 handler 文件（建议）

- `packages/core/src/handlers/cexWorkflowMessageHandler.ts`
  - 导出 `handleCEXWorkflowMessage(...)`（风格与 `handleRegularMessage(...)` 对齐）
  - 内部可用 LangGraph 仅做“状态编排 + loop”，但业务逻辑保持与 Regular 同构

### 状态机（LangGraph State）

Trading workflow 不做 “多阶段管线（意图抽取→计划→归一化）” 的重编排，而是采用与 Regular 相同的 **LLM loop + action** 模式：LLM 产出要么是最终回答，要么是 action 调用；执行 action 后把结果回灌上下文进入下一轮，直到输出最终回答或达到最大轮次。

与 Regular 的关键差异：当 LLM 提议执行 action 时，不直接执行，而是先进入 **参数确认（Human-in-the-loop）** 流程：展示 action 与 parameters，要求用户确认（两次确认）后才执行。

建议核心字段与 `packages/core/src/handlers/regularMessageHandler.ts` 保持一致（便于复用模板、解析器与执行框架）：

- 输入：
  - `message: Memory`
  - `runtime: IAgentRuntime`
  - `callback?: HandlerCallback`
  - `streamingCallback?: StreamingCallback`
  - `intermediateResponseCallback?: (response: Memory) => void`
- 上下文：
  - `recentMessages: string`
  - `currentDate: string`
  - `availableActions: string`
  - `userTraits: string`
  - `dataRetentionInfo: string`
- 处理状态：
  - `iteration: number`
  - `maxIterations: number`
  - `actionResults: any[]`
- 响应：
  - `llmResponse: string`
  - `parsedResponse: { isAction: boolean; actionCall?: any; text?: string }`
  - `finalResponse: Memory`
  - `forceFinalResponse: boolean`
- 控制流：
  - `shouldContinue: boolean`
  - `isComplete: boolean`
  - `hasError: boolean`
  - `errorMessage?: string`
  - `phase: string`
  - `startTime: number`

### 阶段划分（Nodes）

建议节点顺序与 Regular 同构（便于复制/抽象共用的 loop 逻辑）：

1. `initialize`
   - 加载 `userTraits` / `dataRetentionInfo`
   - 预告开始（streaming step）
2. `generate_llm_response`
   - 用 Trading 专用模板生成本轮 LLM 输出（“最终回答”或“action 调用”）
3. `parse_llm_response`
   - 解析为 `{ isAction, actionCall, text }`
4. `request_parameter_review`（**必须：弹窗确认**）
   - 当信息充分且 `isAction=true` 时，将 `actionCall`（action 名 + parameters）发送给前端弹窗
   - 前端允许用户检查/必要时编辑 parameters，并要求 **两次确认**（review confirm + final confirm）
   - 只有最终确认通过，才进入 `execute_action`
5. `execute_action`（**位置预留 / TBD**）
   - 接收“已确认”的 parameters，执行 action，并把结果追加到 `actionResults`
6. `generate_formatted_result`
   - 将 action 执行结果回灌给 LLM，生成“可展示”的格式化结果（文本 + 可选结构化 JSON）
7. `show_result_modal`
   - 将格式化结果通过 streaming 或 message memory 返回前端，前端以弹窗展示给用户
8. `finalize_response`
   - 当 `isAction=false` 或达到 `maxIterations` 时，生成最终 `Memory`
9. `persist_memories`（可选）
   - 将最终答复与 action 结果摘要写入 memory

## Action 规划（MVP 与扩展）

本 workflow 采用 “LLM 决定是否需要 action” 的模式，因此 action 规划不在 handler 内硬编码（不像 Comprehensive 固定 12 个 action），而是：

- **保留 `execute_action` 节点作为 action 入口**（当前先空实现 / 仅记录 TODO）
- 后续根据数据源接入情况逐步补齐交易相关 actions（链上 tx 查询、地址流水、订单成交、仓位等）

建议在文档层面先约定两件事（实现时再落地）：

1. LLM action 调用的 JSON 格式与 Regular 保持一致（便于复用解析器）
2. action 的“名字与参数 schema”后续以插件方式定义（本文先不绑定具体 action 列表）

## 参数确认（弹窗 + 两次确认）

目标：避免“误查错账户/误查错时间范围/误触发敏感查询成本”，在 action 执行前把 parameters 透明地交给用户确认。

### 推荐交互（前端）

1. **Review 弹窗（第一次确认）**
   - 展示：`actionName`、`parameters`（可编辑/可校验）
   - 文案：说明将查询的数据范围与可能的成本/延迟
   - 按钮：`Cancel` / `Confirm`
2. **Final Confirm 弹窗（第二次确认）**
   - 展示：只读摘要（exchange、symbol、timeRange、orderId/tradeId 等关键字段）
   - 文案：明确“确认执行后将开始拉取交易所数据”
   - 按钮：`Back` / `Confirm & Run`

### 推荐事件/载荷（后端 → 前端）

通过 `streamingCallback` 发送（字段名可按现有前端约定调整）：

```json
{
  "type": "cex_workflow_parameter_review_required",
  "action": { "name": "TBD_ACTION_NAME", "parameters": { "key": "value" } },
  "ui": { "title": "Review parameters", "confirmationsRequired": 2 }
}
```

前端恢复执行时回传（前端 → 后端）建议格式：

```json
{
  "type": "trading_parameter_review_decision",
  "decision": "approved" | "rejected",
  "confirmationLevel": 1 | 2,
  "parameters": { "key": "value" },
  "feedback": "optional"
}
```

实现层面可复用现有 task-chain 的 “pending approvals + interrupt/resume” 思路（参见 `packages/core/src/tasks/taskChainPlanner.ts` 的 human approval 机制与 `packages/core/src/handlers/taskChainHandler.ts` 的 pending approval 存储）。

## 信息充分性判断（由 LLM 负责）

本 workflow 不做任何基于关键词/正则的意图与缺参判断。是否“信息足够执行 action”由 LLM 在 `generate_llm_response` 阶段自行决定：

- 若信息不足：直接走 Option B，输出 narrative 追问（不输出 action/parameters，也不弹窗）。
- 若信息充分：输出 Option A（action + parameters），进入参数双确认弹窗。

## 数据模型（归一化结果，仅 CEX）

Trading workflow 的最小可用形态只要求输出可读文本；如需前端稳定渲染或后续统计，建议在 action 结果基础上做“交易所统一归一化”。推荐（可选）结构如下（金额/数量使用字符串以避免精度问题）：

```ts
type TradingNormalizedResult = {
  target: {
    type: "order" | "trade" | "fills" | "position" | "funding" | "account_summary" | "unknown";
    exchange?: string;
    accountRef?: string; // 脱敏后的账户引用（不要存 apiKey/userId 明文）
    symbol?: string;     // 例如 BTC/USDT, ETH-PERP
    orderId?: string;
    tradeId?: string;
    positionId?: string;
    timeRange?: { from?: number; to?: number };
  };

  facts: {
    // 时间与状态
    createdAt?: number;
    updatedAt?: number;
    filledAt?: number;
    status?: "new" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired" | "unknown";

    // 交易/订单
    side?: "buy" | "sell";
    orderType?: "market" | "limit" | "stop" | "stop_limit" | "other";
    timeInForce?: string;
    price?: string;          // 挂单价（limit）
    avgPrice?: string;       // 成交均价
    qty?: string;            // 订单数量（base）
    filledQty?: string;      // 已成交数量（base）
    notional?: string;       // 成交额（quote），若能提供

    // 手续费
    fees?: Array<{ asset: string; amount: string; usd?: number }>;

    // 分笔成交（可选）
    fills?: Array<{
      tradeId?: string;
      price?: string;
      qty?: string;
      fee?: { asset: string; amount: string };
      timestamp?: number;
    }>;

    // 合约/衍生品（可选）
    leverage?: number;
    marginMode?: "cross" | "isolated";
    positionSide?: "long" | "short";
    entryPrice?: string;
    markPrice?: string;
    liquidationPrice?: string;
    realizedPnl?: { asset: string; amount: string; usd?: number };
    unrealizedPnl?: { asset: string; amount: string; usd?: number };
    funding?: Array<{ timestamp?: number; asset: string; amount: string; usd?: number }>;
  };

  derived?: {
    // 统计/汇总（当 target.type=account_summary/fills 时常用）
    volumeBySymbol?: Record<string, string>;  // quote volume
    feeTotalByAsset?: Record<string, string>;
    netBuySellBySymbol?: Record<string, { buyNotional?: string; sellNotional?: string }>;
    pnlTotal?: { asset: string; amount: string; usd?: number };
  };

  provenance: {
    actionResultIds: string[];
    notes?: string[];
    confidence?: number;
  };
};
```

## 输出与存储（Memory / Streaming）

### StreamingCallback 事件建议

沿用现有 pattern（`in_progress`/`completed`/`error`）：

- `cex_workflow_start`
- `cex_workflow_generate_llm_response`
- `cex_workflow_parameter_review_required`（弹窗：第一次确认）
- `cex_workflow_parameter_final_confirm_required`（弹窗：第二次确认）
- `cex_workflow_execute_action`（确认通过后执行）
- `cex_workflow_generate_formatted_result`
- `cex_workflow_show_result_modal`
- `cex_workflow_finalize_response`
- `cex_workflow_complete`

### Memory 类型建议

建议至少产出 1 个对用户可见的最终 `Memory`，并可选保存：

- `type: "cex_workflow"`：结构化结果摘要（便于前端渲染）
- `type: "cex_workflow_raw"`：关键 action 的原始输出索引（便于追溯）

## 配置与 Feature Flag

建议增加 runtime 级别开关（与 `comprehensiveAnalysisEnabled/autoSummaryEnabled` 风格一致）：

- `cexWorkflowEnabled?: boolean`（构造参数）
- `setCEXWorkflowEnabled(boolean)`
- `isCEXWorkflowEnabled(): boolean`

路由层面：

- 当禁用时，`CEX_WORKFLOW_MESSAGE` 仍可被分类出来，但回退到 `TASK_CHAIN_MESSAGE` 或 `REGULAR_MESSAGE`（二选一，建议回退 task-chain 以保证覆盖复杂度）。

## 错误处理与降级

- 任一 action 失败：记录 `actionFailures`，继续执行（只要关键数据足够）
- 意图抽取失败：进入“补问”模式或降级到 `TASK_CHAIN_MESSAGE`
- workflow 异常：在 `routeMessage` 捕获并回退到 `handleMessageWithTaskChain`（与现有逻辑保持一致）

## 测试计划（建议）

1. 分类单测（最小）：
   - 给定包含 `txHash/address/orderId` 的输入，期望 `CEX_WORKFLOW_MESSAGE`
2. 路由单测（最小）：
   - `routeMessage` 对新类型命中新 handler
3. 行为测试（集成）：
   - 伪造 action 输出，验证归一化结构与最终答复结构

## 迁移与落地步骤（Implementation Checklist）

1. 扩展类型与模板（`MessageClassificationType` + `messageClassificationTemplate`）
2. 扩展 `LangGraphPrecheckService`（解析白名单 + display name）
3. 新增 `CEXWorkflowGraph` handler（LangGraph）
4. `runtime.routeMessage` 增加 case 与 `runtime.handleCEXWorkflow(...)`
5. 增加 feature flag（默认关闭/灰度开启）
6. 增加最小测试与示例用法

## 开放问题（需在实现前确认）

1. “交易信息”的优先边界：当用户同时要“市场报告 + 交易流水”，是否一律走 Comprehensive？
2. 需要覆盖的交易所范围：现货 + 合约都做，还是先做现货？
3. 是否需要输出结构化 JSON（用于前端表格/图表）？还是只输出文本？
4. 对匿名用户策略：是否允许 `CEX_WORKFLOW_MESSAGE`（目前匿名用户强制 regular）？
