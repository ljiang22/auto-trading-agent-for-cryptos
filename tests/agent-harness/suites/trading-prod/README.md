# Trading prod suite (LIVE)

**Warning:** `trading-prod.full.json` runs **live** Binance orders at **~6 USDT** notional on **BTC-USDT**. Real funds are spent on market and filled limit orders.

## Edit cases (human-readable)

1. Edit [`trading-prod-catalog.mjs`](trading-prod-catalog.mjs) — titles, prompts, sections.
2. Run `pnpm test:trading-prod:generate` — refreshes `trading-prod.full.json`, templates, and [`CASE_INDEX.md`](CASE_INDEX.md).

Do not hand-edit `trading-prod.full.json`.

## Generate

```bash
pnpm test:trading-prod:generate
```

## Run

```bash
export AGENT_TEST_EMAIL=...
export AGENT_TEST_PASSWORD=...
export AWS_PROFILE=sentiedge-target   # CloudWatch harvest

pnpm test:trading-prod -- --filter-tags read_only   # partial run; teardown still runs
pnpm test:trading-prod                              # full matrix
```

## Three rooms + alternating venue prompts

| `roomGroup` | Purpose |
|-------------|---------|
| `read_only` | Balance, orders, fills, ticker, etc. |
| `spot` | Spot order-config matrix, cancel, rejections, risk denies |
| `margin` | Cross/isolated margin orders + rejections |

Each catalog entry emits **one** case (~52 catalog rows before venue mirroring). User messages use **canonical intent NL** aligned with the ADK parameter extractor and approval dialog vocabulary (e.g. `buy 0.00006 BTC at 48600 limit GTC`, `stop 71800 limit 72100` — not internal variant keys like `limit_limit_gtc`). Compose `order_configuration` is the dialog submit shape; `pnpm test:trading-prod:generate` fails if any case does not round-trip through `buildCanonicalIntent`.

Venue alternates suite-wide by catalog index: even = **explicit** (names Binance), odd = **implicit** (no venue in text). Filter with `--filter-tags explicit_venue` or `implicit_venue` (~half each). Compose `params.exchange` stays `binance`.

Filter `set_trading_mode` or `amend` cases when not desired: `--filter-tags` excludes `set_mode` / `amend` tags.

Write-stake smoke run (spot + margin creates, cancel, risk, rejection — polls and approves `human_input_required` interrupts):

```bash
pnpm test:trading-prod -- --filter-tags write_stake --confirm-live
```

Optional case field `planApproval: "batch"` sends `approve all remaining steps` for multi-write plan modals.

### Live market-price hydration

Before running write cases with limit/stop prices, the harness fetches **BTC-USDT** mid from Binance public ticker and uses that mid directly for limit, trailing activation, and amend prices. Multi-leg variants (stop-limit, OCO, bracket) use only a **0.1%** leg spread where exchange ordering requires distinct stop/take-profit levels. `trading-prod.full.json` still contains static placeholder prices for offline generate/dry-run; the live runner overwrites compose + NL at runtime.

If `api.binance.com` is geo-blocked (HTTP 451), the runner tries `data-api.binance.vision` and `api.binance.us`, then `bookTicker` mid on those hosts. Use `--skip-market-fetch` to force `REFERENCE_BTC_PRICE` (100k) instead of a live fetch, or `--market-mid 60359` to supply mid manually.

### Dialog-format approvals (`approvalFormat: "dialog"`)

Create, preview, and cancel cases submit human-input approval **parameters** using the same shape as `HumanInputDialog` Confirm: parsed SSE `fields` + `fieldSchema`, with hidden/injected fields omitted (`client_order_id`, `exchange`, `userId`, etc.). Compose params still drive `message/stream`; the approval POST uses the live interrupt payload, not the approval template blob.

See **Canonical intent coverage** in [`CASE_INDEX.md`](CASE_INDEX.md) after generate.

## Cancel + teardown

- **Cancel test cases** in section `cancel` validate `cancel_order` (NL + compose).
- **Cancel-all-open cases** (`cancel-nl`, `cancel-compose-all-open`) approve **all open BTC-USDT orders** on the account, not only `harness-*` IDs. Run these only on a dedicated test account, or exclude them with `--filter-ids` / skip the `cancel` section on shared prod accounts.
- **Teardown** runs automatically after every suite (even filtered runs): cancel only harness-placed orders from the current run (`harness-*` client order IDs), then verify those IDs are not still open. Unrelated manual orders on the account are left untouched. See `teardown.json` in the run dir.
- **Trading mode cases** run at the end of the full matrix: `set-trading-mode-paper` then `set-trading-mode-live` restores the account to live mode after the paper-mode test.

## Artifacts

`tests/agent-harness/runs/trading-prod-<ts>/`

- `report.json` — harness summary + `teardown` block
- `teardown.json` — cleanup steps
- `cases/<id>.jsonl` — SSE with `at` offsets
- `cases/<id>.summary.json` — requestId, latencies
- `audit/<id>.json` — CloudWatch `[Trading]` events
- `analysis/` — correctness.json, latency.csv, report.md, dashboard.html
