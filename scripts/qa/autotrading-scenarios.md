# Autotrading manual QA scenarios

These 13 scenarios live as a checklist for staging smoke-tests after every
autotrading-related PR. They map 1-to-1 to §Verification in
`/home/leon26/.claude/plans/please-continue-the-plan-structured-storm.md`.

**Prerequisites**

- Staging deployed and reachable at `https://staging.sentiedge.ai`
- Test account `jiang2015leon@gmail.com` configured with **both** Binance and
  Coinbase API keys (read-only is sufficient for scenarios 1–3, 6–7, 10–13;
  write keys required for 4–5, 8–9)
- `DATABASE_ADAPTER=mongodb` (or documentdb) and connection string set
- `EXCHANGE_TOKEN_ENCRYPTION_KEY` populated on the deploy

Sign in, open the Crypto Trader agent, and start a fresh conversation per
scenario unless the scenario explicitly references the previous turn.

---

### 1. Balance query, EN
**Input:** `What's my BTC balance on Binance?`
**Expected:**
- No approval modal opens.
- Response in English with a structured balance table.
- `[Trading]` log shows `stake=read_only`, `venue=binance`, `locale=en`.
- The new memory has `content.language === "en"` and
  `metadata.last_used_exchange === "binance"`.

### 2. Balance query, ZH
**Input:** `我的BTC余额是多少?`
**Expected:**
- No approval modal opens.
- Response in zh-CN.
- Memory tagged `language: "zh-CN"`.

### 3. Mixed-language query
**Input:** `我的BTC balance在Binance是多少`
**Expected:**
- CJK-dominant — response in zh-CN.
- Follow-up `show me my ETH balance in 中文` → still zh-CN (still
  CJK-dominant after the resolver counts characters).

### 4. Place order, EN — idempotency
**Input:** `Buy 0.001 BTC at market on Binance`
**Expected:**
- Risk engine `allow`. Approval modal renders the polished
  `OrderConfigSummaryCard` with the canonical pair `BTC-USDT`.
- Submit the order. Note the `client_order_id` in the response.
- Send the same message again. The handler must NOT submit a second order:
  the existing `pending_orders_ledger` row's `client_order_id` is returned.

### 5. Place order, ZH
**Input:** `买 0.001 BTC 在 Binance 市价单`
**Expected:**
- Same `client_order_id` as scenario 4 — locale is **excluded** from the
  idempotency hash. Approval modal copy is localized.

### 6. Risk-blocked order
**Input:** `Buy 1000 BTC at market`
**Expected:**
- Risk engine surfaces a localized **"Order exceeds your max-notional
  limit"** message.
- No approval modal opens.
- `risk_decisions` collection has an append-only audit row with
  `rules_fired: ["maxOrderSize"]`.

### 7. Kill-switch toggle
**Setup:** Set `user_trading_preferences.kill_switch_active = true` for the
test user (via mongo shell or a future settings UI).
**Input:** `Buy 0.001 BTC at market on Binance`
**Expected:**
- ADK exposes only read-only tools; write paths are gated.
- Response: localized "Trading is currently disabled — kill switch active."

### 8. WS disconnect → REST fallback
**Setup:** Place a limit order far from market (e.g. `Buy 0.0005 BTC at
$60,000 on Binance limit`) so it sits in `submitted`.
**Action:** Force-kill the user-data WS for that user (chaos script:
`scripts/chaos/wsKillSoak.mjs`).
**Expected:**
- REST fallback poller fires within the adaptive window (5 s on first tick).
- Ledger row transitions to `acked` (or `filled`) within 60 s.
- `[Trading]` log shows `source: "rest_fallback"`.

### 9. Paper mode
**Setup:** `set_trading_mode paper` (single approval).
**Input:** `Buy 0.001 BTC at market on Binance` (in paper mode)
**Expected:**
- Order routes through `PaperVenueExchangeService`.
- `pending_orders_ledger` row has `venue=paper`, `simulated=true`.
- No Binance REST call fires (verify in CloudWatch).

### 10. Exchange — explicit override
**Setup:** Account has Binance + Coinbase; default is Coinbase.
**Input:** `What's my BTC balance on Binance?`
**Expected:**
- Query lands on Binance.
- Response cites Binance.
- Memory tagged `last_used_exchange: "binance"`.
- Follow-up `and ETH?` (no exchange mention) → still Binance (sticky).

### 11. Exchange — explicit switch (continues from scenario 10)
**Input:** `show ETH balance on Coinbase`
**Expected:**
- Query lands on Coinbase.
- Sticky context updates to Coinbase.

### 12. Exchange — ambiguous write
**Setup:** Account has Binance + Coinbase, no default set, fresh thread.
**Input:** `Buy 0.001 BTC at market`
**Expected:**
- Clarification: "You have Binance and Coinbase configured. Which one
  should I use?"
- Reply `Binance` → order proceeds on Binance with no second clarification.

### 13. Exchange — ambiguous read defaults silently
**Setup:** Same as scenario 12.
**Input:** `what's my BTC balance?`
**Expected:**
- Uses `defaultExchangeAuth` silently (or `preferred_exchange` if set).
- No clarification (low-friction read-only path).

---

## Scoring template

Copy the table below into the PR description after running all 13. Mark
each pass/fail/skip with rationale.

| #  | Scenario                                  | Pass/Fail | Notes |
|----|-------------------------------------------|-----------|-------|
| 1  | Balance query, EN                         |           |       |
| 2  | Balance query, ZH                         |           |       |
| 3  | Mixed-language query                      |           |       |
| 4  | Place order, EN — idempotency             |           |       |
| 5  | Place order, ZH                           |           |       |
| 6  | Risk-blocked order                        |           |       |
| 7  | Kill-switch toggle                        |           |       |
| 8  | WS disconnect → REST fallback             |           |       |
| 9  | Paper mode                                |           |       |
| 10 | Exchange — explicit override              |           |       |
| 11 | Exchange — explicit switch                |           |       |
| 12 | Exchange — ambiguous write                |           |       |
| 13 | Exchange — ambiguous read defaults silent |           |       |
