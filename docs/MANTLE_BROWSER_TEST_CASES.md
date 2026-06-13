# Mantle Hackathon — Cursor Browser Test Cases

Manual QA checklist for validating the Mantle implementation end-to-end in the Cursor browser.
Use with **Crypto Trader** agent on local dev.

---

## Prerequisites (run once before testing)

| Check | Command / action | Pass? |
|-------|------------------|-------|
| Agent healthy | `curl http://localhost:3000/api/health` → `{"status":"ok"}` | ☐ |
| Client up | Open http://localhost:5173 | ☐ |
| Signed in | `/signin` → `jiang2015leon@gmail.com` + any password **or** `pnpm dev:auth token` cookie snippet | ☐ |
| Mantle env set | `.env` has `ZERO_EX_API_KEY`, `MANTLE_PRIVATE_KEY`, `MANTLE_AUDIT_LOG_ADDRESS` | ☐ |
| Demo wallet funded | `cast balance 0x97dD…9678 --rpc-url https://rpc.sepolia.mantle.xyz --ether` > 0 | ☐ |
| Plugin loaded | Agent log shows `plugin-mantle-dex` in special plugins | ☐ |

**Chat URL (local):**

```
http://localhost:5173/chat/d13ee77f-407c-024d-8892-bfa7f1b861f7
```

**Chain caveat:** Your `.env` may use `MANTLE_CHAIN_ID=5003` (Sepolia). **0x quotes only work on mainnet `5000`.**
For full swap E2E, temporarily set `MANTLE_CHAIN_ID=5000` and fund mainnet USDC+MNT, then restart agent.

---

## How to record results

- Mark **Pass / Fail / Blocked** per row.
- On fail: note actual response text, screenshot, and browser console errors (F12).
- Use a **fresh chat room** for approval-flow tests (pending state is per room+user, 15 min TTL).

---

## A. Auth & shell (P0)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| A1 | Open http://localhost:5173 without login → click agent → "Stay logged out" | Can enter chat anonymously (LOCAL_DEV_MODE) | ☐ |
| A2 | Sign in at `/signin` with `jiang2015leon@gmail.com` + any password | Header shows user; no login prompt on new chat | ☐ |
| A3 | Header → **Connect Mantle Wallet** (no wallet) | Toast: connect failed or MetaMask prompt | ☐ |
| A4 | Connect MetaMask on Mantle Sepolia (`5003`) | Button shows truncated address `0x…9678` | ☐ |
| A5 | Disconnect wallet | Button returns to "Connect Mantle Wallet" | ☐ |

---

## B. Routing — short-circuit to Mantle workflow (P0)

These messages must **not** go to CEX paper trading or generic LLM-only paths. Response should mention Mantle / quote / risk / balance (not CEX order UI).

| ID | Message to send | Expected routing / behavior | Pass? |
|----|-----------------|---------------------------|-------|
| B1 | `swap 5 USDC to WMNT on Mantle` | Mantle workflow; quote or risk step (not CEX approval modal) | ☐ |
| B2 | `convert 10 USDC to WMNT on mantle` | Same as B1 | ☐ |
| B3 | `exchange 1 USDC for WMNT on Mantle` | Same as B1 | ☐ |
| B4 | `show my Mantle wallet balance` | Balance response (MNT + allowlisted tokens) | ☐ |
| B5 | `what are my holdings on Mantle?` | Balance path | ☐ |
| B6 | `swap 10 USDC to WMNT on Mantle please` | Mantle wins over CEX trade regex | ☐ |
| B7 | `buy BTC on Binance` (control) | **Not** Mantle — CEX or regular path | ☐ |
| B8 | `what is Bitcoin?` (control) | Regular analysis; no on-chain swap UI | ☐ |

---

## C. Risk gate — refusal paths (P0)

No pending approval; no explorer links; clear refusal explanation.

| ID | Message | Expected rules / text | Pass? |
|----|---------|---------------------|-------|
| C1 | `swap all my balance YOLO on Mantle` | Refused; mentions YOLO / oversized / risk; `yolo_size` | ☐ |
| C2 | `swap everything to WMNT on Mantle` | Refused (yolo / all balance) | ☐ |
| C3 | `swap 1000 USDC to WMNT on Mantle` | Refused; exceeds `MANTLE_MAX_TRADE_USD` (default $25) | ☐ |
| C4 | `swap 5 FAKECOIN to WMNT on Mantle` | Refused; token not on allowlist | ☐ |
| C5 | After C1, send `approve` | No execution; no stale pending swap from unrelated session | ☐ |

---

## D. Two-turn approval — happy path (P0)

**Requires:** 0x quote working (mainnet `5000` recommended).

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| D1 | New room → `swap 5 USDC to WMNT on Mantle` | Quote summary; buy/sell amounts; slippage; **reply `approve` or `cancel`** prompt | ☐ |
| D2 | Reply `approve` | Processing steps: audit + execute; success message | ☐ |
| D3 | Check assistant message metadata UI | **Mantle on-chain** box with Swap tx + Audit tx links | ☐ |
| D4 | Click **Swap tx** link | Opens Mantle explorer; tx status success or pending | ☐ |
| D5 | Click **Audit tx** link | Opens explorer; `IntentLogged` event on `StrategyAuditLog` | ☐ |
| D6 | Verify intent hash shown | `Intent hash: 0x…` matches audit log | ☐ |
| D7 | Response includes BGA badge | Text contains `Mantle on-chain (0x aggregation) — not CEX paper trading` | ☐ |

---

## E. Two-turn approval — cancel path (P0)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| E1 | New room → `swap 5 USDC to WMNT on Mantle` | Quote + approval prompt | ☐ |
| E2 | Reply `cancel` | `Mantle swap cancelled` — no transaction submitted | ☐ |
| E3 | No MantleExecutionLinks | No swap/audit explorer links in message | ☐ |
| E4 | Reply `approve` after cancel | No execution (pending cleared) | ☐ |

---

## F. Approval edge cases (P1)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| F1 | Room A: get quote → switch to Room B → `approve` in B | No cross-room execution | ☐ |
| F2 | Get quote → wait 16+ min → `approve` | Pending expired; no swap (or clear error) | ☐ |
| F3 | `approve` with no prior quote | No swap; benign message | ☐ |
| F4 | `APPROVE` / `Cancel` (case variants) | Handled same as `approve` / `cancel` if supported | ☐ |
| F5 | Quote pending → send another `swap 3 USDC to WMNT on Mantle` | New quote or clear handling (no double-spend) | ☐ |

---

## G. Analyze-then-swap narrative (P1)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| G1 | `Analyze BTC sentiment` → wait for reply | Normal analysis completes | ☐ |
| G2 | Follow-up: `swap 5 USDC to WMNT on Mantle` | Mantle quote path (may note analysis+swap in prompt) | ☐ |
| G3 | Single message: `analyze ETH sentiment and swap 5 USDC to WMNT on Mantle` | Routes to Mantle workflow | ☐ |

---

## H. Balance & quote-only (P1)

| ID | Message / action | Expected | Pass? |
|----|------------------|----------|-------|
| H1 | `show my Mantle wallet balance` | Non-error balance for demo wallet | ☐ |
| H2 | Quote response lists route | Mentions 0x sources (e.g. Agni, Merchant Moe) when quote succeeds | ☐ |
| H3 | Sepolia (`5003`) swap quote | May fail at 0x — document as **Blocked** not Fail if env is Sepolia | ☐ |

---

## I. CEX vs Mantle separation — BGA ethos (P1)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| I1 | CEX: `buy market 10 USDT BTC/USDT on Binance` (paper) | CEX / paper workflow; **no** Mantle explorer links | ☐ |
| I2 | Mantle: `swap 5 USDC to WMNT on Mantle` → approve | Mantle badge + explorer links; **no** CEX order modal | ☐ |
| I3 | Side-by-side in demo script | Can show paper CEX vs on-chain Mantle in one session | ☐ |

---

## J. Client UI — MantleExecutionLinks (P1)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| J1 | After failed risk (C1) | No Mantle on-chain link box | ☐ |
| J2 | After cancel (E2) | No link box | ☐ |
| J3 | After successful approve (D2) | Box visible under assistant bubble | ☐ |
| J4 | Link labels | "Swap tx:", "Audit tx:", "Intent hash:" | ☐ |
| J5 | Sepolia explorer | Links use `explorer.sepolia.mantle.xyz` when `chainId=5003` | ☐ |
| J6 | Mainnet explorer | Links use `explorer.mantle.xyz` when `chainId=5000` | ☐ |

---

## K. Wallet connect vs server signing (P2 — known MVP limit)

| ID | Steps | Expected (current MVP) | Pass? |
|----|-------|------------------------|-------|
| K1 | Connect different MetaMask account than demo wallet | UI shows connected address | ☐ |
| K2 | `approve` after quote | Swap still signed by **server** `MANTLE_PRIVATE_KEY` (demo wallet), not client EOA | ☐ |
| K3 | Document for judges | Client connect is UX stretch; execution uses server wallet | ☐ |

---

## L. Regression — must not break existing app (P1)

| ID | Steps | Expected | Pass? |
|----|-------|----------|-------|
| L1 | Home page loads agent list | Crypto Trader visible | ☐ |
| L2 | Create new chat room | Room created; messages send | ☐ |
| L3 | Non-Mantle question: `What is WMNT?` | Reasonable reply; no crash | ☐ |
| L4 | Agent survives 3 Mantle messages in a row | No 500 errors; stream completes | ☐ |

---

## M. CLI cross-checks (run alongside browser tests)

| ID | Command | Expected | Pass? |
|----|---------|----------|-------|
| M1 | `node scripts/mantle/gate-check.mjs` | Mainnet 5000 quote HTTP 200 (with API key) | ☐ |
| M2 | `node scripts/mantle/smoke-swap.mjs --quote-only` | Quote OK on configured chain | ☐ |
| M3 | `pnpm test:unit` in `packages/plugin-mantle-dex` | 12/12 pass | ☐ |
| M4 | `pnpm test` mantle tests in `packages/core` | precheck + handler tests pass | ☐ |

---

## N. Demo video script alignment (submission)

Record these scenes in order; each should map to a test above.

| Scene | Time | Browser action | Test IDs |
|-------|------|----------------|----------|
| 1 Happy path | 0:00–1:15 | Analyze → swap → approve → show links | G1–G2, D1–D7 |
| 2 Risk refusal | 1:15–2:00 | YOLO swap blocked | C1 |
| 3 Cancel | 2:00–2:30 | Quote → cancel | E1–E3 |
| 4 BGA narrative | 2:30–3:00 | CEX paper vs Mantle on-chain | I1–I3 |

---

## Failure triage quick reference

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Login prompt blocks chat | Missing `VITE_TEST_USER_EMAIL` or JWT | See `docs/local-dev-auth.md` |
| "0x quote 400" / chain invalid | `MANTLE_CHAIN_ID=5003` | Switch to `5000` for swap tests |
| No explorer links in UI | Metadata not on response | Check `MantleExecutionLinks` in chat.tsx |
| `approve` does nothing | Expired pending or wrong room | New room; quote again |
| Swap fails insufficient funds | Demo wallet empty on target chain | Fund Sepolia MNT or mainnet USDC+MNT |
| LLM errors / empty replies | Missing `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Add Vertex creds to `.env` |
| CEX modal on Mantle message | Routing regression | Check `langGraphPrecheck` short-circuit |

---

## Sign-off

| Area | Tester | Date | Result |
|------|--------|------|--------|
| Routing (B) | | | |
| Risk (C) | | | |
| Approval E2E (D,E) | | | |
| UI links (J) | | | |
| CEX separation (I) | | | |
| Demo script (N) | | | |

**Overall hackathon browser QA:** ☐ Pass ☐ Fail (blockers: _______________)
