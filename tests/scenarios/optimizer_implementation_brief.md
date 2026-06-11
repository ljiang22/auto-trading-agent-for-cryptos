# GEAP Agent Optimization — Implementation Brief

> **For Cursor / Claude Code.** Implement the plan below in the repo, then verify.

## Goal
- **Target score:** ≥ 100/100 on scenario_01 (variant B) + adversarial probes passing
- **Current score:** 97/100
- **Cycle iteration:** 12
- **Overall verdict:** Excellent
- **Critical must-pass:** all passing

## Workflow (operator)
1. Implement every step in **Optimization Plan** below (any aspect: architecture, context, routing, tools, code, prompt).
2. Run `pnpm build` from repo root.
3. Restart the paper agent: `pnpm start` (must load your changes).
4. Re-test: `pnpm optimize:cycle:verify --user-email <paper-user>`
5. Repeat until verify reports **SUCCESS** (score ≥ target).

## Constraints (do not weaken)
- CEX approval gate, risk engine, Rule-9 refusal corpus, capital/leverage limits.
- Protected paths in `scripts/agent-optimizer/policy.mjs` — edit only when the plan explicitly requires it and explain why.
- Run relevant tests after code changes (`pnpm --filter @elizaos-plugins/plugin-cex test`, agent-sim selftest).

## Evaluation diagnosis (summary)
# Scenario 01 — Optimization-grade Evaluation Report

**Overall: Excellent** · 97/100 (Excellent)

## Per-category diagnosis
### Market Data and Research Quality — 15/15  _(gap: prompt)_
- **Root cause:** The agent failed to fetch real-time market data (live mark price) when checking the execution status, preventing it from calculating the current position value and PnL. Additionally, earlier price data was flagged as 16 hours stale.
- **Evidence:** "A live mark price was not fetched; therefore, current value and PnL are unavailable."
- **Suggested direction:** Update the system prompt to explicitly require the agent to fetch live market prices (e.g., via a `get_price` tool) whenever generating a status or portfolio report to ensure accurate PnL calculations.
### User Intent Understanding and Personalization — 8/10  _(gap: prompt)_
- **Root cause:** The assistant failed to adapt its communication style and analysis complexity to the user's beginner background, overwhelming them with advanced trading jargon and technical indicators instead of providing accessible, educational insights.
- **Evidence:** The assistant provided highly technical data like "Inflow Support Depth: $121.82M" and suggested strategies using "RSI(14) crosses above 30" to a user who explicitly stated they "do not know if now is a good time" and asked to "learn more about it."
- **Suggested direction:** Add a directive to the system prompt requiring the agent to profile the user's financial literacy level from their initial prompts and dynamically adjust the complexity of its analysis, vocabulary, and strategy recommendations to match.
### Agent-Defined Comprehensive Analysis Execution — 10/10  _(gap: prompt)_
- **Root cause:** The agent failed to trigger the predefined Comprehensive Analysis workflow via a tool call, instead directly generating an ad-hoc analysis response.
- **Evidence:** In response to 'Help me perform a comprehensive analysis on BTC', the assistant directly outputs '## 📊 BTC - Transaction Count Chart' without generating a JSON action block.
- **Suggested direction:** Modify the system prompt to explicitly require the agent to output the appropriate JSON tool call (e.g., `Comprehensive_Analysis`) when a user requests a comprehensive analysis, rather than generating it directly.
### Analysis Depth and Reasoning Transparency — 10/10  _(gap: prompt)_
- **Root cause:** No points were lost (score 10/10). The agent perfectly demonstrated analysis depth and reasoning transparency by explicitly outlining the trade-offs, risks, and assumptions of the user's custom strategy, as well as transparently addressing the backtest's limitations.
- **Evidence:** "If price rallies immediately, the staged legs never fill... if price falls, your average entry improves but full $800 deploys into a downtrend. ⚠️ No stop-loss defined."
- **Suggested direction:** Maintain the current prompt instructions that successfully enforce explicit risk warnings, trade-off explanations, and transparent communication of strategy mechanics.
### Strategy Design Quality — 15/15  _(gap: prompt)_
- **Root cause:** No points were lost. The agent achieved a perfect score by successfully providing multiple realistic, executable strategies complete with entry/exit rules, position sizing, stop/pause logic, and review cadences, while recommending one with justification and explicitly avoiding leverage.
- **Evidence:** "Recommended Strategy: Conservative DCA... Alternative Strategy: RSI Mean-Reversion... Alternative Strategy: SMA Trend-Following... Leverage: No leverage (spot only)."
- **Suggested direction:** Maintain the current system prompts and logic for strategy generation, as they perfectly fulfill the criteria for excellent strategy design.
### User-Modified Strategy Support — 10/10  _(gap: prompt)_
- **Root cause:** No points were lost. The agent perfectly satisfied all criteria for an Excellent score by accepting the user's custom DCA parameters, structuring them into a clear execution plan, verifying capital limits, warning about the lack of a stop-loss, suggesting a safer adjustment, and requiring explicit user approval.
- **Evidence:** ⚠️ No stop-loss defined. Before approving, you can reply 'add a stop-loss at <price>' to cap downside (suggested: ~10% below average entry), or approve as-is to proceed without one.
- **Suggested direction:** Maintain the current system prompts and architecture for strategy modification, as they successfully enforce risk checks, user intent preservation, and explicit approval workflows.
### Risk Management — 10/10  _(gap: prompt)_
- **Root cause:** No points were lost. The agent achieved a perfect score by proactively defining max exposure, staged entries, leverage limits, and explicitly warning the user when their custom strategy lacked a stop-loss.
- **Evidence:** "⚠️ No stop-loss defined. Before approving, you can reply 'add a stop-loss at <price>' to cap downside (suggested: ~10% below average entry)..."
- **Suggested direction:** Maintain the current system prompts and guardrails, as they successfully enforce comprehensive risk management and user safety warnings.
### User Approval and Compliance Control — 10/10  _(gap: architecture)_
- **Root cause:** No points were lost as the agent perfectly met all criteria (separating phases, confirming paper mode, requiring approval). However, a minor architectural redundancy exists where the user is asked for approval twice.
- **Evidence:** The transcript shows an out-of-band event '[The user reviewed the proposed order in the approval modal and clicked APPROVE]' but the assistant still pauses execution to ask 'Reply yes to approve the next step'.
- **Suggested direction:** Synchronize the UI modal approval event with the plan execution tool to prevent redundant text-based approval requests once the user has already clicked APPROVE in the modal.
### Execution Reliability, Monitoring, and Reporting — 9/10  _(gap: prompt)_
- **Root cause:** The agent generated the execution status report without first fetching the current market price of the asset, preventing it from calculating the position's current value, PnL, and updating market conditions.
- **Evidence:** "A live mark price was not fetched; therefore, current value and PnL are unavailable."
- **Suggested direction:** Update the system prompt or the status-reporting tool's logic to mandate fetching the current live price of the relevant assets before compiling the execution status and PnL report.

## Trace signals (Cloud Trace)

- Traces in window: **19**
- End-to-end latency: p50 **5607ms**, p95 **64864ms**, max 228928ms
- Error spans: **0**
- Decision-outcome oscillations (stalled reasoning): **0**

| Node | p50 (ms) | p95 (ms) | spans |
|---|---|---|---|
| handler:routeMessage | 7741 | 128667 | 12 |
| node:executeActions | 102313 | 102313 | 1 |
| node:generateAnalysis | 59698 | 59698 | 1 |
| node:synthesizeReport | 6612 | 6612 | 1 |
| node:generateResponse | 2258 | 6219 | 3 |

## Optimization Plan

# Optimization Plan

Updated the system prompt to enforce live price fetching for PnL calculations, mandate tool usage for comprehensive analysis, and strictly adapt communication complexity for beginners. Synchronized the plan runner architecture to recognize UI modal approval events, eliminating redundant text-based approval requests.

## s1 — prompt `characters/CryptoTrader.json`  ·  risk: low  ·  auto-eligible (legacy prompt/config path only)
- **Closes:** User Intent Understanding and Personalization, Execution Reliability, Agent-Defined Comprehensive Analysis Execution (category: User Intent Understanding and Personalization)
- **Expected impact:** +3 pts / fixes beginner jargon overload, missing live PnL, and ad-hoc comprehensive analysis
- **Change:** Update directives 4, 6, and 9 in the system prompt. 4. SYNTHESIS: NEVER dump raw tool data, raw news, or unformatted metrics. Synthesize every analysis into a structured report — Executive Summary, Technicals, Sentiment, On-Chain, and explicit Bullish / Bearish / Neutral scenarios — and explain the REASONING and trade-offs behind each recommendation. For a 'comprehensive analysis' request, you MUS…
## s2 — architecture `packages/core/src/handlers/cexPlanRunner.ts`  ·  risk: medium  ·  🔒 IMPLEMENT IN CURSOR / CLAUDE (human)
- **Closes:** User Approval and Compliance Control (category: User Approval and Compliance Control)
- **Expected impact:** Fixes architectural redundancy where user is asked for approval twice
- **Change:** Update the plan runner logic to detect out-of-band UI modal approval events (e.g., transcript messages matching '[The user reviewed the proposed order in the approval modal and clicked APPROVE]'). When this event is detected for the current pending step, automatically transition the step state to 'approved' and proceed with execution, bypassing any redundant text-based prompts asking the user to '…
- ⚠️ touches a PROTECTED safety surface → always requires human approval.

## Implementation checklist
- [ ] **s1** (prompt) — User Intent Understanding and Personalization, Execution Reliability, Agent-Defined Comprehensive Analysis Execution
  - Files: `characters/CryptoTrader.json`
  - Expected: +3 pts / fixes beginner jargon overload, missing live PnL, and ad-hoc comprehensive analysis
- [ ] **s2** (architecture) — User Approval and Compliance Control
  - Files: `packages/core/src/handlers/cexPlanRunner.ts`
  - Expected: Fixes architectural redundancy where user is asked for approval twice

## Verify command
```bash
pnpm build && pnpm start   # restart agent in another terminal
pnpm optimize:cycle:verify --user-email $VITE_TEST_USER_EMAIL --target-score 100
```