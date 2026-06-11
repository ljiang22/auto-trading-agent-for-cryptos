# Autotrading live-mode runbook

This runbook covers the **paging** events on `Trading/*` CloudWatch alarms after live trading is enabled. See [scripts/qa/live-launch-checklist.md](../../scripts/qa/live-launch-checklist.md) for the pre-launch criteria.

## Quick reference

| Symptom | Likely cause | First action |
|---------|--------------|--------------|
| `Trading/FailClosed` firing | risk-audit-sink dead OR reconciliation down | check `[Memory]` rss + Mongo writes |
| `Trading/IdempotencyCollision` firing | retry storm or duplicate user click | inspect `client_order_id` in logs |
| `Trading/UnknownStateBacklog` firing | venue 5xx storm; reconciliation not catching up | check Binance/Coinbase status pages |
| `Trading/KillSwitchActivation` | user-driven; not necessarily incident | reach out to the user |
| `Trading/PromptInjectionSpike` | corpus drift or actual attack | grep `[Trading] {"stage":"prompt_injection_detected"}` |
| `Trading/VenueLatencyP99` | venue degradation | exchange status page → potentially pause |

## Global kill (rollback)

Setting `LIVE_TRADING_GLOBAL_KILL=true` on the ECS task definition and forcing a deployment **fail-closes every live trade for every user** within ~2 min. Paper / shadow continue.

```bash
aws ecs update-service \
  --cluster sentiedge-prod \
  --service sentiedge-agent \
  --task-definition $(aws ecs describe-services \
      --cluster sentiedge-prod --services sentiedge-agent \
      --query 'services[0].taskDefinition' --output text) \
  --force-new-deployment \
  --region ap-southeast-1
```

After flipping the env var in the task def, this command picks up the change.

## Per-alarm playbook

### `Trading/FailClosed`

1. Pull recent failures:
   ```
   fields @timestamp, @message
     | filter @message like /\[Trading\]/ and @message like /"stage":"fail_closed"/
     | sort @timestamp desc
     | limit 50
   ```
2. Check the `reasons` field on the first failure.
3. If `risk_audit_sink_dead`: confirm MongoDB writes are landing — `db.risk_decisions.find().sort({createdAt:-1}).limit(1)`.
4. If `reconciliation_dead`: check `ReconciliationService.isHealthy()` — usually a WS issue, see CLAUDE.md "WS keep-alive vs ALB idle".
5. If alarm persists > 15 min and root cause not resolved: flip the global kill, page secondary on-call.

### `Trading/IdempotencyCollision`

The pre-submit dedup gate fired, which is *by design* — but the metric should be ~0 in steady state. A nonzero rate is a *signal*, not necessarily an incident.

1. Pull the client_order_id from the log:
   ```
   filter @message like /"stage":"idempotency_hit"/
     | sort @timestamp desc
   ```
2. Run `scripts/qa/replay-request.mjs --client-order-id <id>` to see the full timeline.
3. Common causes: a user double-clicked, an SSE reconnect re-fired the same intent, a script bug repeatedly submitted the same canonical params. The first is benign; the others are bugs.

### `Trading/UnknownStateBacklog`

UNKNOWN-state means a venue REST submit failed *after* the request was sent. We don't know if the order landed.

1. List currently UNKNOWN orders:
   ```js
   db.pending_orders_ledger.find({state: "unknown"}).sort({submittedAt:1}).limit(20)
   ```
2. Reconciliation poller is supposed to drive these to terminal state. Confirm the poller is running — search logs for `[ReconciliationFallback]`.
3. If backlog > 30 and not draining: the venue's `getOrder` endpoint is likely also degraded. Switch to manual reconciliation: page the on-call engineer.

### `Trading/KillSwitchActivation`

A user flipped their kill switch. Not an incident — but reach out: it usually means they saw something they don't trust.

1. Identify the user from the `userId` field.
2. Check `kill_switch_events` for the reason field (free-form, optional).
3. Sentiment check: was there a recent execution? Pull the user's last 10 orders via `db.pending_orders_ledger.find({userId}).sort({submittedAt:-1}).limit(10)`.

### `Trading/PromptInjectionSpike`

3+ injection-positive classifications in 5 min.

1. Pull the matching prompts:
   ```
   filter @message like /"stage":"prompt_injection_detected"/
     | fields @timestamp, userId, score, matched_patterns
   ```
2. If concentrated in one userId — review for malicious or compromised account; consider per-user soft block.
3. If spread across users — your classifier may have a false-positive regression. Compare `matched_patterns` distribution vs the eval corpus.

### `Trading/VenueLatencyP99` and `Trading/WSDisconnectRateHigh`

Both signal venue health. Cross-reference with the exchange's public status page.

If sustained for >15 min on a single venue, consider an automatic pause for that venue:

```bash
# Hypothetical — venue pause not yet implemented. For now, page on-call.
```

## Deploy guidelines

- **Never deploy autotrading changes on a Friday afternoon.**
- **Always deploy to staging first.** Wait at least 24 h before promoting to prod.
- **The first prod deploy after any autotrading change should be during low-volume hours** (typically Sunday 06:00 SGT) to limit blast radius.

## Contacts

- Primary on-call: see PagerDuty schedule "Sentiedge Trading".
- Secondary on-call: ditto, override-on-call.
- Compliance escalation: see internal Slack channel `#compliance-escalation`.
