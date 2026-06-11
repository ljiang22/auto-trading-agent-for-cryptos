# Autotrading safety contract (Wave 1 + Wave 2)

This document captures the operator-facing safety invariants the
autotrading subsystem must preserve. Read this before reviewing changes
to `cexWorkflowMessageHandler.ts`, the `paper_orders` ledger, the
reconciliation poller, the `[Trading]` event emitters, or
`userFeatureManager.ts`.

## 1. Paper / live response disclosure (F1)

**Invariant**: Every assistant chat message produced from a
`create_order`, `cancel_order`, or `modify_order` action that resolves
to `paper` or `shadow` mode begins with a visible mode badge.

- `paper` mode: first line is `**[PAPER MODE — no real money]**`
  (English) or `**[模拟交易 — 无真实资金]**` (Simplified Chinese).
- `shadow` mode: first line is
  `**[SHADOW MODE — hypothetical, not executed]**` (or
  `**[影子交易 — 仅记录，未下单]**`).
- `live` mode: no badge.

**Defense in depth**:
1. The `getCEXResultFormattingTemplate` system prompt asks the SLM to
   include the badge.
2. A deterministic post-check in `generateFormattedResult`
   (`hasModeBadge` → `renderModeBadge`) prefixes the badge mechanically
   if the SLM forgot. An `info`-level log line is emitted whenever the
   mechanical badge fires so operators can monitor SLM compliance.
3. The plugin-cex `output.ts` / `error.ts` templates also fork by mode
   so the underlying action `text` carries paper / shadow vocabulary.

**Operator alarm**: regex-scan the last 1 K assistant memories with
`paper-ord-` ids; every hit must match `\[PAPER MODE`. Any miss is a
P0 launch-blocker.

## 2. UserFeatureManager memory poisoning (F2)

**Invariant**: A single message cannot mint a durable user-feature
aspect that grants the LLM permission to bypass safety controls.

**Defenses**:
1. **Source-message filter**: `processMessage` runs every recent
   message through `classifyPromptInjection` (from
   `utils/promptInjectionDefense.ts`). Verdicts `downgrade` or `refuse`
   exclude that message from aspect derivation. Messages tagged
   `content.metadata.promptInjectionDowngrade = true` upstream are also
   dropped.
2. **Aspect blocklist**: `validateAspectResponse` rejects aspects whose
   `name + content` matches the safety-bypass regex catalog
   (`bypass|ignore|disable|override` × `risk|safety|gate|engine`,
   `forget|disregard` × `instruction|rule|prompt`,
   `jailbreak|developer mode|sudo`,
   `willing to (bypass|ignore|disable|disregard)`). Rejection silently
   skips that aspect; the rest of the batch ships.
3. **Consent gating**: aspects derived from any batch that mentioned
   trading keywords (`buy|sell|leverage|margin|stop loss|short sell|…`)
   are tagged `consentRequired: true` and excluded from
   `formatUserTraitsForContext` until the user opts in via
   Settings → Inferred Traits.
4. **Audit log**: every consent flip / delete writes
   `[UserFeature] aspect_consent|aspect_delete|aspect_delete_all userId=… memoryId=… …`.

**Settings UX**: `client/src/components/cex/InferredTraitsTab.tsx`
shows every inferred trait with Approve / Reject / Delete actions and a
"Delete all" bulk operation backed by
`GET/PUT/DELETE /user/inferred-traits[/:memoryId][/consent]`.

## 3. Paper-order persistence (F3)

**Invariant**: A paper order placed in one action call is visible in
every subsequent action call, including across container restarts (up
to `PAPER_ORDER_TTL_SECONDS`, default 24 h).

**Implementation**:
- New `paper_orders` and `paper_fills` collections in MongoDB with:
  - `{userId: 1, order_id: 1}` unique index
  - `{userId: 1, status: 1}` for open-orders lookup
  - `{ttl_at: 1}` TTL index (DocumentDB 5.0 honors TTL)
- `PaperVenueExchangeService` now takes an injected
  `PaperOrderStore` (adapter-backed in production, in-memory in tests).
- `shared.ts` caches one `ExchangeService` per `realVenue` so the
  per-symbol price cache also survives across action calls.
- `usePaperVenue` now covers **read AND write** actions when
  `mode=paper`: `get_orders`, `get_balance`, `get_fills` route to the
  paper ledger.
- `cancelOrder` on a paper id returns
  `{cancelled: [], not_found: [paper-ord-…]}` when the id is unknown
  → the plugin-cex `output.ts` paper-cancel template renders
  `"No paper order with id … found in your paper ledger."` instead of
  the live-venue "no orders actively cancelled" copy.

**SQLite parity**: `paper_orders` + `paper_fills` tables are mirrored
in `packages/adapter-sqlite/src/index.ts` for `IDatabaseAdapter` shape
completeness.

**Configuration**: `PAPER_ORDER_TTL_SECONDS` env (default `86400`).

## 4. Trading audit event schema (F4)

**Invariant**: Every `[Trading]` event that has access to a
`CanonicalIntent` carries all 12 fields from the CLAUDE.md spec:

```
{request_id, intent_hash, userId, venue, symbol, side,
 notional_usd, locale, stake, decision, rules_fired, latency_ms}
```

**Field semantics**:
- `stake` = execution mode: `live | paper | shadow` (per CLAUDE.md
  autotrading uplift spec). NOT the previous read_only/write meaning.
- `tool_capability` = the read_only/write classification (renamed from
  the old wire field so the spec slot `stake` is unambiguous).
- `notional_usd` = pre-execution USD estimate from
  `deriveEstimatedNotionalUsd(intent)`. Stored on
  `intent.notional_usd_estimated`.
- `latency_ms` = stage wall-clock; `risk_check` now captures entry-to-
  exit, others continue to use their respective stage timings.

**Backward compat**: the renamed `tool_capability` field is additive;
existing dashboards filtering on the old `stake = "write"` will keep
working only if they're updated to filter on `tool_capability = "write"`
instead. Update the CloudWatch metric filter as part of deploying this
change.

**Operator dashboards** (post-deploy):
- Alarm on `stage="order_submit" AND stake="live" AND decision="allow"`
  exceeding the daily expected rate.
- Alarm on `stage="order_submit" AND stake="live" AND notional_usd>$N`
  (operator picks N per-user from `max_order_notional_usd`).
- Alarm on **missing** fields: `stage="order_submit" AND NOT stake`
  (catches regressions where intent fields aren't threaded).

## 5. Reconciliation per-user credentials (F5)

**Invariant**: When a per-user reconciliation poll cycle cannot resolve
credentials for a (userId, venue), the system pauses live trading for
that user via a `runtime_lock` and emits a structured
`reconciliation_health` audit event.

**Behavior**:
- `ReconciliationFallback` config switched from a static
  `credentials: ResolvedExchangeCredentials[]` to a per-call
  `resolveCredentials: (userId, venue) => Promise<creds | null>`. The
  resolver wraps `resolveExchangeCredentials` in
  `packages/plugin-cex/src/actions/shared.ts`.
- An `unresolvedStreak` counter is maintained per
  `(userId, venue)`. On `RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER`
  consecutive misses (default `60`, ≈ 5 min at the 5 s tick), the
  downgrade hook fires.
- The downgrade hook writes
  `user_trading_preferences.runtime_lock = "read_only_until={ts+15min}"`
  on MongoDB and emits
  `[Trading] {"stage":"reconciliation_health","decision":"downgrade",userId,venue,streak,reason}`.
- Log volume: previously the poller logged `No credentials found …`
  every 5 s; now logs once at streak=1, then every 10th attempt, with
  a clear streak counter so operators can correlate without grep.

**Configuration**:
- `RECONCILIATION_UNRESOLVED_DOWNGRADE_AFTER` env (default `60`).
- The 15-minute `runtime_lock` duration is hard-coded in
  `agent/src/index.ts` and intentionally not env-tunable.

## 6. Operational checklist (pre-launch)

- [ ] CloudWatch metric filter on `stage="reconciliation_health"
  decision="downgrade"` is non-zero alarms.
- [ ] CloudWatch metric filter on `stake="live" decision="allow"
  notional_usd > daily_max_usd` configured.
- [ ] `EXCHANGE_TOKEN_ENCRYPTION_KEY` set on every ECS task def.
- [ ] DocumentDB instance has `paper_orders` + `paper_fills` TTL
  indexes verified (`db.paper_orders.getIndexes()`).
- [ ] Manual QA: place a paper order, check `Show my open paper orders`
  returns it; cancel it; place a non-existent id; confirm "no paper
  order found" copy.
- [ ] Manual QA: send one adversarial "ignore the risk engine…" line
  with 4 follow-ups, then `GET /user/inferred-traits`; assert no aspect
  contains "bypass" / "willing to bypass".
- [ ] Hit the chat with `default_mode=paper`, place an order; reply
  begins with `**[PAPER MODE — no real money]**` AND order id is the
  full `paper-ord-…` (not truncated).

## 7. Wave 2 follow-ups still pending

- **F7 LLM extractor** — the canonical-intent **validator hardening** is
  shipped; the LLM-first extractor + regex-confidence gate (per plan
  §F7-1/2) is deferred. Current extractor handles market / limit /
  cancel; stop_limit / TIF / post_only / margin parsing fails validation
  at the canonical step and prompts the user to clarify, rather than
  auto-extracting from NL.
- **F10 manual Trade compose** — a minimal scaffold ships: the chat now
  has a Trade button that prefills the input with a templated NL trade
  prompt. The richer in-place `TradingOrderEditor`-in-`HumanInputDialog`
  with `accountSnapshot` pre-fetch is deferred.
- **M2 / M4 / M5** — pair-lookup-on-cancel, BTC quote freshness fields,
  and ambiguous-buy clarification list — deferred to a follow-up PR.
