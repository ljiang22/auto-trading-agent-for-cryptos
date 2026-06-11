# SQLite 数据库架构说明

## 相关文件

| 文件 | 职责 |
|------|------|
| `packages/adapter-sqlite/src/index.ts` | `SqliteDatabaseAdapter` 实现类（~3500 行），包含所有 DB 操作方法 |
| `packages/adapter-sqlite/src/sqliteTables.ts` | 所有建表 SQL、索引、外键约束、JSON 校验 |
| `packages/adapter-sqlite/src/sqlite_vec.ts` | sqlite-vec 向量扩展加载逻辑 |
| `packages/core/src/data/database.ts` | `DatabaseAdapter` 抽象基类，含 CircuitBreaker 容错机制 |
| `packages/core/src/core/types.ts` | `IDatabaseAdapter` 接口定义 |
| `packages/core/src/utils/subscriptionTier.ts` | 订阅层级解析工具（`getLatestTierFromHistory`、`isAnonymousAccount` 等） |
| `agent/data/db.sqlite` | 运行时数据库文件 |

---

## 表结构

### 核心会话

#### `accounts` — 用户账户
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | 显示名 |
| `username` | TEXT | 用户名 |
| `email` | TEXT NOT NULL | 邮箱（唯一标识） |
| `avatarUrl` | TEXT | 头像 |
| `details` | JSON | 扩展信息（source、subscriptionTier 等） |
| `createdAt` | TIMESTAMP | 创建时间 |

#### `rooms` — 对话房间
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | 房间名 |
| `agentId` | TEXT → accounts | 所属 Agent |
| `createdAt` | TIMESTAMP | 创建时间 |

#### `participants` — 参与者
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts | 用户 |
| `roomId` | TEXT → rooms | 房间 |
| `agentId` | TEXT → accounts | Agent |
| `userState` | TEXT | FOLLOWED / MUTED |
| `last_message_read` | TEXT | 最后已读消息 ID |

#### `memories` — 消息与记忆
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `type` | TEXT | 消息类型 |
| `content` | JSON | 消息内容 |
| `embedding` | BLOB | 向量嵌入 |
| `userId` | TEXT → accounts | 发送用户 |
| `roomId` | TEXT → rooms | 所属房间 |
| `agentId` | TEXT → accounts | 所属 Agent |
| `clientIP` | TEXT | 客户端 IP（匿名用户标识） |
| `unique` | INTEGER | 去重标志 |
| `createdAt` | TIMESTAMP | 创建时间 |

#### `goals` — 用户目标
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts | 用户 |
| `roomId` | TEXT → rooms | 所属房间 |
| `name` | TEXT | 目标名称 |
| `status` | TEXT | 状态 |
| `description` | TEXT | 描述 |
| `objectives` | JSON | 子目标数组 |

#### `relationships` — 用户关系
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userA` | TEXT → accounts | 用户 A |
| `userB` | TEXT → accounts | 用户 B |
| `status` | TEXT | 关系状态 |
| `userId` | TEXT → accounts | 创建者 |

#### `logs` — 系统日志
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT | 用户 |
| `roomId` | TEXT | 房间 |
| `type` | TEXT | 日志类型 |
| `body` | JSON | 日志内容 |
| `createdAt` | TIMESTAMP | 创建时间 |

---

### 缓存与知识库

#### `cache` — 应用缓存
| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | TEXT PK(1/2) | 缓存键 |
| `agentId` | TEXT PK(2/2) | 所属 Agent |
| `value` | JSON | 缓存值 |
| `expiresAt` | TIMESTAMP | 过期时间 |

#### `knowledge` — 知识库
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `agentId` | TEXT → accounts | 私有知识的 Agent（共享时为 NULL） |
| `content` | JSON | 知识内容 |
| `embedding` | BLOB | 向量嵌入 |
| `isMain` | INTEGER | 是否为主块 |
| `originalId` | TEXT → knowledge | 原始知识 ID（分块时） |
| `chunkIndex` | INTEGER | 分块索引 |
| `isShared` | INTEGER | 是否共享（0=私有，1=共享） |

约束：`isShared=1` 时 `agentId` 必须为 NULL，`isShared=0` 时 `agentId` 必须非 NULL。

索引：`knowledge_agent_key`、`knowledge_agent_main_key`、`knowledge_original_key`、`knowledge_shared_key`

#### `action_cache` — 行动结果缓存
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `actionName` | TEXT | 行动名称 |
| `query` | TEXT | 查询文本 |
| `queryEmbedding` | BLOB | 查询向量 |
| `result` | TEXT | 行动结果 |
| `chunkIndex` | INTEGER | 分块索引 |
| `totalChunks` | INTEGER | 总块数 |
| `embedding` | BLOB | 结果向量 |
| `hitCount` | INTEGER | 命中次数 |
| `expiresAt` | TIMESTAMP | 过期时间 |

索引：`action_cache_action_idx`、`action_cache_expires_idx`

---

### 任务链

#### `favorite_taskchains` — 收藏任务链
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts | 所属用户 |
| `agentId` | TEXT → accounts | 所属 Agent |
| `chainId` | TEXT | 任务链 ID |
| `name` | TEXT | 用户自定义名称 |
| `originalName` | TEXT | 原始名称 |
| `description` | TEXT | 描述 |
| `taskChain` | JSON | 完整任务链数据 |
| `executionCount` | INTEGER | 执行次数 |
| `isPublic` | INTEGER | 是否公开（0/1） |
| `lastUsedAt` | TIMESTAMP | 最后使用时间 |

唯一约束：`(userId, agentId, chainId)`

#### `shared_taskchains` — 共享任务链
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `shareCode` | TEXT UNIQUE | 分享码 |
| `favoriteId` | TEXT → favorite_taskchains (SET NULL) | 来源收藏 |
| `userId` | TEXT → accounts | 创建用户 |
| `agentId` | TEXT → accounts | 所属 Agent |
| `chainId` | TEXT | 任务链 ID |
| `name` | TEXT | 名称 |
| `taskChain` | JSON | 完整任务链数据 |

索引：`shared_taskchains_code_idx`、`shared_taskchains_favorite_idx`

---

### 推荐码

#### `referral_codes` — 用户推荐码
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts CASCADE | 用户 |
| `referralCode` | TEXT UNIQUE | 推荐码 |

#### `referrals` — 推荐关系
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `referrerId` | TEXT → accounts CASCADE | 推荐人 |
| `referredUserId` | TEXT UNIQUE → accounts CASCADE | 被推荐人（唯一） |
| `referralCode` | TEXT | 使用的推荐码 |

#### `user_referral_codes` — 用户注册时使用的推荐码
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT UNIQUE → accounts CASCADE | 用户（唯一） |
| `referralCodeUsed` | TEXT | 使用的推荐码 |
| `isMatched` | INTEGER | 是否已匹配 |

#### `pending_referrals` — 注册前的待处理推荐
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `email` | TEXT | 邮箱 |
| `referralCode` | TEXT | 推荐码 |

#### `signup_link_sends` — 注册链接发送记录
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `email` | TEXT | 目标邮箱 |
| `referralCode` | TEXT | 推荐码 |

---

### 订阅与账单

#### `subscription_events` — Stripe 事件历史
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts CASCADE | 用户 |
| `eventType` | TEXT | 事件类型（checkout.session.completed 等） |
| `stripeEventId` | TEXT UNIQUE | Stripe 事件 ID（幂等键） |
| `stripeCustomerId` | TEXT | Stripe 客户 ID |
| `stripeSubscriptionId` | TEXT | Stripe 订阅 ID |
| `subscriptionStatus` | TEXT | 订阅状态 |
| `planName` | TEXT | 套餐名称 |
| `amountCents` | INTEGER | 金额（分） |
| `currency` | TEXT | 货币 |
| `eventData` | JSON | 完整事件数据 |

索引：`subscription_events_user_idx`、`subscription_events_stripe_event_idx`

#### `user_subscriptions` — 用户当前订阅状态
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT UNIQUE → accounts CASCADE | 用户（唯一，每用户一条） |
| `stripeCustomerId` | TEXT | Stripe 客户 ID |
| `stripeSubscriptionId` | TEXT | Stripe 订阅 ID |
| `subscriptionStatus` | TEXT | 当前状态（active/trialing/canceled 等） |
| `planName` | TEXT | 套餐名称 |
| `currentPeriodStart` | INTEGER | 当前周期开始时间戳 |
| `currentPeriodEnd` | INTEGER | 当前周期结束时间戳 |
| `cancelAtPeriodEnd` | INTEGER | 是否到期取消 |
| `lastEventId` | TEXT | 最后处理的 Stripe 事件 ID |
| `updatedAt` | TIMESTAMP | 更新时间 |

索引：`user_subscriptions_user_idx`、`user_subscriptions_status_idx`、`user_subscriptions_stripe_customer_idx`

#### `user_subscription_tier_history` — 订阅层级变更历史
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts CASCADE | 用户 |
| `tier` | TEXT CHECK | `free` / `plus` / `pro` / `enterprise` |
| `source` | TEXT | 来源（stripe_api / stripe_webhook） |
| `observedAt` | INTEGER | 观测时间戳（毫秒） |
| `createdAt` | TIMESTAMP | 记录创建时间 |

此表为订阅层级的**权威来源**，所有 quota/model 限制逻辑均从此表读取最新记录。

索引：`user_subscription_tier_history_user_observed_idx (userId, observedAt DESC)`、`user_subscription_tier_history_tier_idx`

---

### 分析与使用统计

#### `token_usage` — Token 使用量
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts CASCADE | 用户 |
| `agentId` | TEXT → accounts | Agent |
| `roomId` | TEXT | 房间 |
| `inputTokens` | INTEGER | 输入 token 数 |
| `outputTokens` | INTEGER | 输出 token 数 |
| `totalTokens` | INTEGER | 总 token 数 |
| `modelProvider` | TEXT | 模型提供商 |
| `modelName` | TEXT | 模型名称 |
| `modelClass` | TEXT | 模型类型（SMALL/LARGE/EMBEDDING） |
| `timestamp` | INTEGER | 使用时间戳（毫秒） |

索引：`token_usage_user_timestamp_idx`、`token_usage_user_window_idx`

#### `analytics_usage_rollup` — 每日使用聚合
| 字段 | 类型 | 说明 |
|------|------|------|
| `day` | TEXT PK(1/2) | 日期（YYYY-MM-DD） |
| `segment` | TEXT PK(2/2) | 用户分层（free/plus/pro/anonymous） |
| `activeUsers` | INTEGER | 活跃用户数 |
| `messageCount` | INTEGER | 消息数 |
| `updatedAt` | TIMESTAMP | 更新时间 |

#### `analytics_usage_rollup_users` — 聚合去重用户
| 字段 | 类型 | 说明 |
|------|------|------|
| `day` | TEXT PK(1/3) | 日期 |
| `segment` | TEXT PK(2/3) | 分层 |
| `userId` | TEXT PK(3/3) | 用户 ID |
| `updatedAt` | TIMESTAMP | 更新时间 |

#### `web_page_sessions` — 网页访问记录
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | UUID |
| `userId` | TEXT → accounts | 用户（可为匿名） |
| `path` | TEXT | 访问路径 |
| `referrer` | TEXT | 来源页面 |
| `durationMs` | INTEGER | 停留时长（毫秒） |
| `clickCount` | INTEGER | 点击次数 |
| `isAuthenticated` | INTEGER | 是否已登录 |
| `userAgent` | TEXT | 浏览器标识 |

索引：`web_page_sessions_createdAt_idx`、`web_page_sessions_path_idx`

---

## 类层次结构

```
IDatabaseAdapter (interface)
  packages/core/src/core/types.ts
        │
        ▼
DatabaseAdapter<DB> (abstract class)
  packages/core/src/data/database.ts
  - db: DB
  - circuitBreaker: CircuitBreaker
  - 声明所有抽象方法
        │
        ▼
SqliteDatabaseAdapter (concrete class)
  packages/adapter-sqlite/src/index.ts
  - db: BetterSqlite3Database
  - constructor: load sqlite-vec 扩展
  - init(): 执行 sqliteTables SQL + 列迁移
  - 实现全部 ~80 个接口方法
```

---

## 初始化与迁移流程

```
agent/src/index.ts → startAgent()
        │
        ▼
findDatabaseAdapter(runtime)
  → 从 plugins 取第一个 adapter，或动态 import @elizaos-plugins/adapter-sqlite
        │
        ▼
SqliteDatabaseAdapter.init()
  1. db.exec(sqliteTables)          — CREATE TABLE IF NOT EXISTS（全部24张表）
  2. 检查并 ALTER TABLE 补列         — isPublic、clientIP 等新增字段
  3. 如有旧结构，重建表              — web_page_sessions 去除 anonymousId
  4. migrateAuthAccountsToCanonicalIds()
     — 规范化 email，合并重复账户
     — 同步更新所有关联外键（memories、participants、token_usage 等）
        │
        ▼
runtime.databaseAdapter = db        — 注入到 AgentRuntime
        │
        ▼
runtime.initialize()                — 启动所有 services 和 plugins
```

---

## 订阅层级判断逻辑

```
Stripe Webhook / API 调用
        │
        ▼
summarizeSubscriptionStatus()        stripeService.ts
  → resolvedTier: free|plus|pro|enterprise
        │
        ▼
recordSubscriptionTierChange()       adapter-sqlite/src/index.ts
  → 写入 user_subscription_tier_history（仅 tier 变化时写入，事务内原子操作）
  → 同步更新 accounts.details.subscriptionTier 镜像字段
        │
        ▼
getLatestTierFromHistory()           core/src/utils/subscriptionTier.ts
  → 查 user_subscription_tier_history ORDER BY observedAt DESC LIMIT 1
  → 被以下逻辑使用：
     - getUserQuotaTier()    (quotaService.ts)  — Token 配额限制
     - resolveModelClass()   (generation.ts)    — 模型选择（SMALL/LARGE）
     - getDataRetentionConfig() (dataRetention.ts) — 数据保留期限
     - /authentication/me   (api.ts)            — 前端 resolvedTier 字段
```

---

## 关键设计特性

| 特性 | 说明 |
|------|------|
| **外键级联** | 删除 `accounts` 记录时，关联数据自动级联删除（CASCADE） |
| **JSON 校验** | 所有 JSON 字段均有 `CHECK(json_valid())` 约束 |
| **向量搜索** | `embedding` 字段为 BLOB，通过 sqlite-vec 扩展支持向量相似度检索 |
| **多 Agent 隔离** | `rooms`、`participants`、`knowledge` 等表通过 `agentId` 隔离不同 Agent |
| **匿名用户** | `accounts.details.source = "ip"` 或 email 以 `@anonymous.local` 结尾标识匿名用户 |
| **CircuitBreaker** | `DatabaseAdapter` 基类内置熔断器，防止 DB 故障级联 |
| **幂等写入** | `subscription_events.stripeEventId` 唯一约束保证 webhook 幂等 |
| **原子 tier 变更** | `recordSubscriptionTierChange` 将读-判断-写三步放在同一事务内，消除竞争条件 |
