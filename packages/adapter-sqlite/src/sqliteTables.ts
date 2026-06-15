export const sqliteTables = `
PRAGMA foreign_keys=ON;
BEGIN TRANSACTION;

-- Table: accounts
CREATE TABLE IF NOT EXISTS "accounts" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "details" TEXT DEFAULT '{}' CHECK(json_valid("details")) -- Ensuring details is a valid JSON field
);

-- Table: memories
CREATE TABLE IF NOT EXISTS "memories" (
    "id" TEXT PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "content" TEXT NOT NULL,
    "embedding" BLOB NOT NULL, -- TODO: EMBEDDING ARRAY, CONVERT TO BEST FORMAT FOR SQLITE-VSS (JSON?)
    "userId" TEXT,
    "roomId" TEXT,
    "agentId" TEXT,
    "unique" INTEGER DEFAULT 1 NOT NULL,
    "clientIP" TEXT,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id"),
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id")
);

-- Table: goals
CREATE TABLE IF NOT EXISTS "goals" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "name" TEXT,
    "status" TEXT,
    "description" TEXT,
    "roomId" TEXT,
    "objectives" TEXT DEFAULT '[]' NOT NULL CHECK(json_valid("objectives")) -- Ensuring objectives is a valid JSON array
);

-- Table: logs
CREATE TABLE IF NOT EXISTS "logs" (
    "id" TEXT PRIMARY KEY,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "roomId" TEXT NOT NULL
);

-- Table: participants
CREATE TABLE IF NOT EXISTS "participants" (
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "roomId" TEXT,
    "agentId" TEXT, -- Agent-specific participant isolation
    "userState" TEXT,
    "id" TEXT PRIMARY KEY,
    "last_message_read" TEXT,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id")
);

-- Table: relationships
CREATE TABLE IF NOT EXISTS "relationships" (
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "userA" TEXT NOT NULL,
    "userB" TEXT NOT NULL,
    "status" "text",
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    FOREIGN KEY ("userA") REFERENCES "accounts"("id"),
    FOREIGN KEY ("userB") REFERENCES "accounts"("id"),
    FOREIGN KEY ("userId") REFERENCES "accounts"("id")
);

-- Table: rooms
CREATE TABLE IF NOT EXISTS "rooms" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT,
    "agentId" TEXT, -- Agent-specific room isolation
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: cache
CREATE TABLE IF NOT EXISTS "cache" (
    "key" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "value" TEXT DEFAULT '{}' CHECK(json_valid("value")),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP,
    PRIMARY KEY ("key", "agentId")
);

-- Table: exchange_registry (canonical CEX exchange registry)
CREATE TABLE IF NOT EXISTS "exchange_registry" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "defaultAuthType" TEXT,
    "authTypes" TEXT NOT NULL CHECK(json_valid("authTypes"))
);

-- Table: knowledge
CREATE TABLE IF NOT EXISTS "knowledge" (
    "id" TEXT PRIMARY KEY,
    "agentId" TEXT,
    "content" TEXT NOT NULL CHECK(json_valid("content")),
    "embedding" BLOB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "isMain" INTEGER DEFAULT 0,
    "originalId" TEXT,
    "chunkIndex" INTEGER,
    "isShared" INTEGER DEFAULT 0,
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("originalId") REFERENCES "knowledge"("id"),
    CHECK((isShared = 1 AND agentId IS NULL) OR (isShared = 0 AND agentId IS NOT NULL))
);

-- Table: favorite_taskchains
CREATE TABLE IF NOT EXISTS "favorite_taskchains" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "description" TEXT,
    "taskChain" TEXT NOT NULL CHECK(json_valid("taskChain")),
    "createdAt" INTEGER NOT NULL,
    "lastUsedAt" INTEGER,
    "executionCount" INTEGER DEFAULT 0 NOT NULL,
    "isPublic" INTEGER DEFAULT 0 NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id"),
    UNIQUE("userId", "agentId", "chainId")
);

-- Table: shared_taskchains
CREATE TABLE IF NOT EXISTS "shared_taskchains" (
    "id" TEXT PRIMARY KEY,
    "shareCode" TEXT NOT NULL UNIQUE,
    "favoriteId" TEXT,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "description" TEXT,
    "taskChain" TEXT NOT NULL CHECK(json_valid("taskChain")),
    "createdAt" INTEGER NOT NULL,
    FOREIGN KEY ("favoriteId") REFERENCES "favorite_taskchains"("id") ON DELETE SET NULL,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id")
);

-- Table: shared_chats
CREATE TABLE IF NOT EXISTS "shared_chats" (
    "id" TEXT PRIMARY KEY,
    "shareCode" TEXT NOT NULL UNIQUE,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" INTEGER NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id"),
    FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE,
    UNIQUE("agentId", "roomId")
);

-- Table: action_cache (public memory for cached action results)
CREATE TABLE IF NOT EXISTS "action_cache" (
    "id" TEXT PRIMARY KEY,
    "actionName" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queryEmbedding" BLOB NOT NULL,
    "result" TEXT NOT NULL,
    "chunkIndex" INTEGER DEFAULT 0 NOT NULL,
    "totalChunks" INTEGER DEFAULT 1 NOT NULL,
    "embedding" BLOB NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP NOT NULL,
    "hitCount" INTEGER DEFAULT 0 NOT NULL
);

-- Table: referral_codes (maps 5-character referral codes to user accounts)
CREATE TABLE IF NOT EXISTS "referral_codes" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: referrals (links referred users to their referrers)
CREATE TABLE IF NOT EXISTS "referrals" (
    "id" TEXT PRIMARY KEY,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL UNIQUE,
    "referralCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("referrerId") REFERENCES "accounts"("id") ON DELETE CASCADE,
    FOREIGN KEY ("referredUserId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: user_referral_codes (records what referral code each user used during registration)
CREATE TABLE IF NOT EXISTS "user_referral_codes" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL UNIQUE,
    "referralCodeUsed" TEXT NOT NULL,
    "isMatched" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: pending_referrals (stores enrollment-time referral codes before account exists)
CREATE TABLE IF NOT EXISTS "pending_referrals" (
    "id" TEXT PRIMARY KEY,
    "email" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: signup_link_sends (records when signup links are sent)
CREATE TABLE IF NOT EXISTS "signup_link_sends" (
    "id" TEXT PRIMARY KEY,
    "email" TEXT NOT NULL,
    "referralCode" TEXT,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Table: subscription_events (full history of Stripe webhook events)
CREATE TABLE IF NOT EXISTS "subscription_events" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL UNIQUE,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "planName" TEXT,
    "amountCents" INTEGER,
    "currency" TEXT,
    "eventData" TEXT NOT NULL CHECK(json_valid("eventData")),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: user_subscriptions (current subscription state for each user)
CREATE TABLE IF NOT EXISTS "user_subscriptions" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL UNIQUE,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT NOT NULL,
    "planName" TEXT,
    "currentPeriodStart" TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP,
    "cancelAtPeriodEnd" INTEGER DEFAULT 0,
    "lastEventId" TEXT,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: user_subscription_tier_history (tracks resolved tier changes over time)
CREATE TABLE IF NOT EXISTS "user_subscription_tier_history" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL CHECK("tier" IN ('free', 'plus', 'pro', 'enterprise')),
    "source" TEXT NOT NULL DEFAULT 'stripe_api',
    "observedAt" INTEGER NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE
);

-- Table: analytics_usage_rollup (anonymous usage rollups for cleanup)
CREATE TABLE IF NOT EXISTS "analytics_usage_rollup" (
    "day" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "activeUsers" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("day", "segment")
);

-- Table: analytics_usage_rollup_users (dedupe anonymous active users by day)
CREATE TABLE IF NOT EXISTS "analytics_usage_rollup_users" (
    "day" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("day", "segment", "userId")
);

-- Table: token_usage (tracks token usage for quota enforcement)
CREATE TABLE IF NOT EXISTS "token_usage" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "roomId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "modelClass" TEXT,
    "timestamp" INTEGER NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id") ON DELETE CASCADE,
    FOREIGN KEY ("agentId") REFERENCES "accounts"("id")
);

CREATE INDEX IF NOT EXISTS "token_usage_user_timestamp_idx"
    ON "token_usage" ("userId", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS "token_usage_user_window_idx"
    ON "token_usage" ("userId", "timestamp", "inputTokens", "outputTokens");

-- Table: web_page_sessions (tracks web page views and dwell time)
CREATE TABLE IF NOT EXISTS "web_page_sessions" (
    "id" TEXT PRIMARY KEY,
    "createdAt" INTEGER NOT NULL,
    "userId" TEXT,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "durationMs" INTEGER NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "isAuthenticated" INTEGER NOT NULL DEFAULT 0,
    "userAgent" TEXT,
    FOREIGN KEY ("userId") REFERENCES "accounts"("id")
);

CREATE INDEX IF NOT EXISTS "web_page_sessions_createdAt_idx"
    ON "web_page_sessions" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "web_page_sessions_path_idx"
    ON "web_page_sessions" ("path");
CREATE INDEX IF NOT EXISTS "web_page_sessions_path_auth_idx"
    ON "web_page_sessions" ("path", "isAuthenticated", "createdAt" DESC);

-- Index: relationships_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "relationships_id_key" ON "relationships" ("id");

-- Index: memories_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "memories_id_key" ON "memories" ("id");

-- Index: participants_id_key
CREATE UNIQUE INDEX IF NOT EXISTS "participants_id_key" ON "participants" ("id");

-- Index: knowledge
CREATE INDEX IF NOT EXISTS "knowledge_agent_key" ON "knowledge" ("agentId");
CREATE INDEX IF NOT EXISTS "knowledge_agent_main_key" ON "knowledge" ("agentId", "isMain");
CREATE INDEX IF NOT EXISTS "knowledge_original_key" ON "knowledge" ("originalId");
CREATE INDEX IF NOT EXISTS "knowledge_content_key" ON "knowledge"
    ((json_extract(content, '$.text')))
    WHERE json_extract(content, '$.text') IS NOT NULL;
CREATE INDEX IF NOT EXISTS "knowledge_created_key" ON "knowledge" ("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "knowledge_shared_key" ON "knowledge" ("isShared");

-- Index: favorite_taskchains_user_agent_idx
CREATE INDEX IF NOT EXISTS "favorite_taskchains_user_agent_idx"
    ON "favorite_taskchains" ("userId", "agentId");

-- Index: favorite_taskchains_chain_idx
CREATE INDEX IF NOT EXISTS "favorite_taskchains_chain_idx"
    ON "favorite_taskchains" ("agentId", "chainId");

-- Index: shared_taskchains_code_idx
CREATE UNIQUE INDEX IF NOT EXISTS "shared_taskchains_code_idx"
    ON "shared_taskchains" ("shareCode");

-- Index: shared_taskchains_favorite_idx
CREATE INDEX IF NOT EXISTS "shared_taskchains_favorite_idx"
    ON "shared_taskchains" ("favoriteId");

-- Index: shared_taskchains_agent_idx
CREATE INDEX IF NOT EXISTS "shared_taskchains_agent_idx"
    ON "shared_taskchains" ("agentId");

-- Index: shared_chats_code_idx
CREATE UNIQUE INDEX IF NOT EXISTS "shared_chats_code_idx"
    ON "shared_chats" ("shareCode");

-- Index: shared_chats_agent_room_idx
CREATE UNIQUE INDEX IF NOT EXISTS "shared_chats_agent_room_idx"
    ON "shared_chats" ("agentId", "roomId");

-- Index: action_cache_action_idx (for filtering by action name)
CREATE INDEX IF NOT EXISTS "action_cache_action_idx"
    ON "action_cache" ("actionName");

-- Index: action_cache_expires_idx (for cleanup of expired cache)
CREATE INDEX IF NOT EXISTS "action_cache_expires_idx"
    ON "action_cache" ("expiresAt");

-- Index: action_cache_action_expires_idx (combined for efficient queries)
CREATE INDEX IF NOT EXISTS "action_cache_action_expires_idx"
    ON "action_cache" ("actionName", "expiresAt");

-- Index: referral_codes (for fast lookups)
CREATE INDEX IF NOT EXISTS "referral_codes_user_idx"
    ON "referral_codes" ("userId");
CREATE INDEX IF NOT EXISTS "referral_codes_code_idx"
    ON "referral_codes" ("referralCode");

-- Index: referrals (for fast lookups of referrer and referred users)
CREATE INDEX IF NOT EXISTS "referrals_referrer_idx"
    ON "referrals" ("referrerId");
CREATE INDEX IF NOT EXISTS "referrals_referred_idx"
    ON "referrals" ("referredUserId");

-- Index: user_referral_codes (for fast lookups)
CREATE INDEX IF NOT EXISTS "user_referral_codes_user_idx"
    ON "user_referral_codes" ("userId");
CREATE INDEX IF NOT EXISTS "user_referral_codes_code_idx"
    ON "user_referral_codes" ("referralCodeUsed");

-- Index: pending_referrals (for fast lookup by email)
CREATE INDEX IF NOT EXISTS "pending_referrals_email_idx"
    ON "pending_referrals" ("email");

-- Index: signup_link_sends (for fast lookup)
CREATE INDEX IF NOT EXISTS "signup_link_sends_email_idx"
    ON "signup_link_sends" ("email");
CREATE INDEX IF NOT EXISTS "signup_link_sends_created_idx"
    ON "signup_link_sends" ("createdAt" DESC);

-- Index: subscription_events (for event history queries)
CREATE INDEX IF NOT EXISTS "subscription_events_user_idx"
    ON "subscription_events" ("userId");
CREATE INDEX IF NOT EXISTS "subscription_events_stripe_event_idx"
    ON "subscription_events" ("stripeEventId");
CREATE INDEX IF NOT EXISTS "subscription_events_type_idx"
    ON "subscription_events" ("eventType");
CREATE INDEX IF NOT EXISTS "subscription_events_created_idx"
    ON "subscription_events" ("createdAt" DESC);

-- Index: user_subscriptions (for subscription status queries)
CREATE INDEX IF NOT EXISTS "user_subscriptions_user_idx"
    ON "user_subscriptions" ("userId");
CREATE INDEX IF NOT EXISTS "user_subscriptions_status_idx"
    ON "user_subscriptions" ("subscriptionStatus");
CREATE INDEX IF NOT EXISTS "user_subscriptions_stripe_customer_idx"
    ON "user_subscriptions" ("stripeCustomerId");

-- Index: user_subscription_tier_history (for tier timeline queries)
CREATE INDEX IF NOT EXISTS "user_subscription_tier_history_user_observed_idx"
    ON "user_subscription_tier_history" ("userId", "observedAt" DESC);
CREATE INDEX IF NOT EXISTS "user_subscription_tier_history_tier_idx"
    ON "user_subscription_tier_history" ("tier");

-- Table: strategy_instances (StrategyEngineService, paper-only auto-execution)
CREATE TABLE IF NOT EXISTS "strategy_instances" (
    "instance_id" TEXT PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "next_eval_at" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_strategy_instances_user" ON "strategy_instances" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_strategy_instances_status" ON "strategy_instances" ("status");

COMMIT;
PRAGMA foreign_keys=ON;`;
