# QA retest transcripts — Wave 1+2 (autotrading-wave1-2-jiggly-codd)

UI evidence captured against `staging.sentiedge.ai` on 2026-05-19 using
the test account `jiang2015leon@gmail.com`. Pair with the CloudWatch
log evidence (log group `/ecs/sentiedge-agent`, region `ap-southeast-1`)
referenced in PR #212.

## Index

| File | Plan | Outcome |
|---|---|---|
| `c1-confirmed.png` | F1 paper-mode disclosure | ✅ Response starts with `**[PAPER MODE — no real money]**` |
| `c1-after-send.png` | F1 modal opens with extracted params | ✅ Limit BUY 0.0001 BTC @ 60000 USDT pre-filled, Post Only checked, Cross/Isolated tabs visible |
| `c1-modal-state.png` | F7+F9 surface in approval modal | ✅ Spot/Cross/Isolated tabs + Limit/Market/Stop Limit subtabs visible |
| `eth-sell-result.png` | F1+F3 — clean ETH sell happy path | ✅ `Paper Order ID: paper-...1210`, Status `OPEN`, badge intact |
| `h2-show-paper-success.png` | H2 — paper-orders visibility post-place | ✅ Table returns the placed `paper-...1210` with `[PAPER MODE — no real money]` badge |
| `h2-after-confirm.png` | Failed first attempt (idempotency dedup) | ⚠ Pre-existing `pending_orders_ledger` phantom row caused the BTC dedup; ETH retry passed |
| `c1-after-resize.png` `c1-retest-state.png` `c1-retest-state-2.png` `c1-retest-state-3.png` `c1-clean-retest.png` `h1h2-show-paper-orders.png` `h2-attempt2.png` | Intermediate verification steps | Annotated in PR description |

## CloudWatch evidence

Log lines captured during the retest (truncated; full lines in
CloudWatch):

```
[Trading] {"stage":"risk_check",
  "request_id":"8b330ac7-...","stake":"paper","notional_usd":6,
  "decision":"allow","rules_fired":[],"latency_ms":5}
[plugin-cex] get_orders routed to PAPER venue (mode=paper, real venue=binance, kind=read)
[Routing] {"stage":"cex_bypass","hit":true,"reason":"continuation",
  "cexRequestId":"c61d472b-..."}
[UserFeatureManager] F2 consent filter hid 3 pending aspect(s) for user 42f8204a-...
```

## Acceptance crosswalk

- **C1 retest** (paper order begins with `[PAPER MODE]`): ✅ `c1-confirmed.png`, `eth-sell-result.png`
- **C2 retest** (no risk-bypass aspect): ✅ partially via CW log
  showing `F2 consent filter hid 3 pending aspect(s)`; legacy v52 trait
  set scrubbed via `DELETE /user/inferred-traits` post-retest
- **H1+H2 retest** (paper persistence + visibility): ✅ `eth-sell-result.png`
  + `h2-show-paper-success.png`
- **H3 retest** (12-field audit envelope): ✅ CW snippet above
- **H4 retest** (recon log spam drops): partial; no real
  unresolvable-cred user during the test window
- **F6 retest** (CEX bypass): ✅ CW `[Routing] cex_bypass hit=true`
- **F7 retest** (stop-limit/IOC pre-fill): partial — modal opens with
  the tabs; the deferred LLM extractor will catch more shapes. See PR
  description "Caveats / Pre-existing issues uncovered"
- **F9 retest** (margin orders): UI shows Cross/Isolated tabs; not
  exercised end-to-end with an actual confirmed margin order this session
- **F10 retest** (Trade compose): scaffold replaced with rich modal in
  this PR — re-test after deploy
