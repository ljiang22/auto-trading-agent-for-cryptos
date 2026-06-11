# Autotrading live-launch checklist

Plan §8.12. Sign-off required from **engineering**, **product**, **compliance** before flipping live mode on for general availability.

## Hard gates

- [ ] **CDK stacks green for 7 consecutive days in staging** — `TradingMetrics-staging`, `TradingDashboard-staging`, `TradingAlarms-staging`, `SloBurn-staging` all deployed and no `Trading/FailClosed`, `Trading/IdempotencyCollision`, or `Trading/UnknownStateBacklog` alarms over the 7-day window.
- [ ] **3-day paper-soak archived** — `scripts/qa/paper-soak-runner.mjs` ran continuously, results in `s3://sentiedge2025/autotrading/paper-soak/<run-id>/`, Sharpe variance < 0.3 across the 3-day window. Run `scripts/qa/paper-soak-report.mjs` to produce a summary.
- [ ] **Shadow vs paper divergence < 5%** — on the 100-prompt synthetic suite. Compare `shadow_decisions` rows against paper-mode outcomes.
- [ ] **Audit-log completeness test green** — `packages/plugin-cex/__tests__/audit/completeness.test.ts` (≥12 records per order). Run with `pnpm --filter @elizaos-plugins/plugin-cex test audit/completeness`.
- [ ] **Chaos drills all pass** — `pnpm --filter / node scripts/chaos/{wsKillSoak,exchange5xxSoak,killSwitchDrill,failClosedDrill}.mjs` exit 0.
- [ ] **Duplicate-submit prevention 100%** — `pnpm --filter @elizaos-plugins/plugin-cex test idempotency/preSubmitDedup`.
- [ ] **Unknown-state drill** — kill the venue stub mid-request, assert no retry, assert reconciliation resolves cleanly. Test in `packages/plugin-cex/__tests__/safety/unknownState.test.ts` (to be authored).
- [ ] **ADK eval CI gate** — macro-F1 ≥ 0.92, critical-label precision ≥ 0.95 on the eval suite. Wired into GitHub Actions `test:ci-gates`.
- [ ] **Red-team risk test** — `packages/plugin-cex/__tests__/risk.redTeam.test.ts` green.
- [ ] **Prompt-injection corpus** — zero successful jailbreaks across the 50+ adversarial corpus. Run `pnpm --filter @elizaos/core test promptInjectionDefense`.
- [ ] **Geo-gating** — tested for 3 restricted regions, returns HTTP 451.
- [ ] **Consent flow recorded** — 5 internal users walked through the consent modal and a `consent_log` row exists per user.
- [ ] **Secrets-in-payload scan** — `pnpm --filter @elizaos/client-direct test secretsLeak` green; CloudWatch Logs Insights query for entropy-flagged tokens over the past 24 h returns zero hits.
- [ ] **Frontend E2E suite (Playwright) all green** — `client/__tests__/e2e/trading/` (when the suite lands).
- [ ] **TOS / risk-disclosure content version-locked** — `client/src/content/consent/liveTrading.v1.md` checked in; SHA recorded in this checklist:
  - Recorded SHA: `<fill in>`
- [ ] **On-call rotation set** — `docs/runbooks/autotrading-live.md` reviewed by primary + secondary on-call.
- [ ] **Rollback plan rehearsed** — flipping `LIVE_TRADING_GLOBAL_KILL=true` env-flag at the ECS task definition fail-closes to read-only globally within 2 min. Rehearsal recorded in the runbook.

## Sign-off

| Role | Name | Date | Sig |
|------|------|------|-----|
| Engineering lead | | | |
| Product owner | | | |
| Compliance | | | |
| On-call primary | | | |
