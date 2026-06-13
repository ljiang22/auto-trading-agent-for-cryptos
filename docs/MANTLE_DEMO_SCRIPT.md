# Mantle Hackathon — 3-Minute Demo Script & Storyboard

Recording-ready shot list for the SentiEdge AI Trading Agent on Mantle. Each scene
maps to a test case in [MANTLE_BROWSER_TEST_CASES.md](MANTLE_BROWSER_TEST_CASES.md)
and to a scoring criterion in [MANTLE_HACKATHON.md](MANTLE_HACKATHON.md).

> **Recording tip:** record at 1280×720+, use a fresh chat room per scene (pending
> swap state is per room+user, 15-min TTL), and keep the Mantle explorer open in a
> second tab so you can cut to the confirmed tx after each on-chain action.

## Pre-flight (do NOT record)

| Check | Command / action |
|-------|------------------|
| Chain = mainnet | `.env`: `MANTLE_CHAIN_ID=5000`, `MANTLE_RPC_URL=https://rpc.mantle.xyz` |
| Demo wallet funded | `0x97dD…9678` holds USDC **and** native MNT for gas |
| Audit log deployed on mainnet | `MANTLE_AUDIT_LOG_ADDRESS` points at the 5000 deployment |
| Agent + client up | `curl :3000/api/health` → ok; open `:5173` |
| Signed in | dev-auth cookie (`pnpm dev:auth token --email …`) or `/signin` |

---

## Scene 1 — Happy path (0:00–1:15) · maps to G1–G2, D1–D7 · A-Technical 15, B-Transparency 7.5

**Narration:** "SentiEdge analyzes the market, then executes a real swap on Mantle — risk-gated and approval-gated."

1. **(optional analysis lead-in)** Type: `Analyze BTC sentiment` → let the analysis render (shows the agent is more than a swap bot).
2. New room. Type: **`swap 5 USDC to WMNT on Mantle`**
   - Show the **quote + approval prompt**: buy/sell amounts, slippage, `Intent hash: 0x…`, and the `Reply approve / cancel` prompt with the server-demo-wallet disclosure.
3. Type: **`approve`**
   - Show the processing steps (`mantle_execute`) and the success message.
4. Show the **"Mantle on-chain" box** under the reply with **Swap tx** + **Audit tx** links + the **Intent hash**.
5. Cut to the explorer: open **Swap tx** → status success; open **Audit tx** → the `IntentLogged` event on `StrategyAuditLog`, with the **same intent hash** linking intent → swap.
6. Point out the badge: **"Mode: Mantle on-chain (0x aggregation) — not CEX paper trading."**

**Live proof — captured from a real mainnet run (2026-06-13, chain 5000):**
- Swap: **5 USDC → 9.0704 WMNT** via FusionX V3 (0x aggregation)
- Swap tx: [`0xc744fe99…ede76b35`](https://explorer.mantle.xyz/tx/0xc744fe99c319db07365734bd315795fb4b5ce840355e1c3eefbe79a0ede76b35) — status **success**, block 96626173
- Audit tx: [`0xf2aff69e…ecf8c265`](https://explorer.mantle.xyz/tx/0xf2aff69e2fedfba261c0bd5b9ee9be74c75691ad08a48d4ef5d81073ecf8c265) — status **success**, emits `IntentLogged`
- Intent hash: `0x02cce5e6dbfd0ec7f9262944c6c784d13dcc27e3171ea0bcac4e61586414af91` — **matches between the swap intent and the on-chain audit event** (intent ↔ swap linkage proven on-chain)
- `StrategyAuditLog` (mainnet): [`0x9e6c…f5b7a`](https://explorer.mantle.xyz/address/0x9e6c3216ade766d127acfa40c41011ffdc1f5b7a)
- Wallet balance delta verified: USDC 18.8 → 13.8 (−5), WMNT 0 → 9.0704 (+9.07)
- UI screenshot: `client/mantle-d1-d7-happy-path.png`

---

## Scene 2 — Risk refusal (1:15–2:00) · maps to C1 · B-Strategy 7.5, BGA ethos 10

**Narration:** "The agent refuses unsafe trades — transparency and safety over PnL."

1. New room. Type: **`swap all my balance YOLO on Mantle`**
   - Show the refusal: **"Mantle swap refused (risk gate)"**, the explanation (oversized / all-balance), and that **no on-chain link box** appears (nothing was signed or submitted).
2. (optional) Type: `swap 1000 USDC to WMNT on Mantle` → refused, exceeds `MANTLE_MAX_TRADE_USD`.

---

## Scene 3 — Cancel / explain-before-execute (2:00–2:30) · maps to E1–E3

**Narration:** "Every execution is opt-in. The user is always in control."

1. New room. Type: **`swap 5 USDC to WMNT on Mantle`** → quote + approval prompt.
2. Type: **`cancel`** → **"Mantle swap cancelled — no transaction was submitted."** No explorer links.

---

## Scene 4 — BGA narrative: paper CEX vs on-chain Mantle (2:30–3:00) · maps to I1–I3 · BGA ethos 10

**Narration:** "Same agent, two honest execution modes: paper-traded CEX for rehearsal, real on-chain settlement on Mantle — each clearly disclosed."

1. CEX paper: `buy market 10 USDT BTC/USDT on Binance` → show the **[PAPER MODE]** disclosure, no Mantle links.
2. Mantle on-chain: reference Scene 1's real swap + explorer links.
3. Close on the contrast: paper badge vs. the **Mantle on-chain (0x aggregation)** badge + explorer-verifiable audit trail.

---

## Coverage already validated (automated, this branch)

These behaviors are proven by unit tests, the API QA harness, and live Playwright UI
runs — the recording just narrates them:

- Routing (B1–B6), risk refusal (C1–C4) + no link box (J1), cancel (E2) + no link box (J2),
  balance read (B4) — **validated in the browser** on the running agent.
- `26 PASS / 2 BLOCKED / 0 FAIL` in `docs/mantle-browser-qa-results.json` from the Sepolia run
  (the 2 BLOCKED are the Sepolia 0x-mainnet-only limitation, honestly reported — not green).
- **Scene 1 happy path is PROVEN on Mantle mainnet** with a real 5 USDC → 9.07 WMNT swap (Permit2
  approve + signed `PermitTransferFrom` + on-chain settle), a matching on-chain `IntentLogged`
  audit event, and explorer-verified success on both transactions — see the live-proof block above.
