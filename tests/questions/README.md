# Question Runner Script

Legacy question JSON under `tests/questions/` is executed through the **agent test harness** (`tests/agent-harness/`), which uses **JWT Bearer auth** against Django (`POST /authentication/validation/`) — not the old forgeable `user_info` cookie.

For new suites, prefer JSON under `tests/agent-harness/suites/` and `pnpm test:agent-suite`. See [tests/agent-harness/README.md](../agent-harness/README.md).

## Prerequisites

- Agent server URL (default `https://agent.sentiedge.ai`; override with `--base-url` or `AGENT_TEST_AGENT_URL`)
- Django auth URL (default prod: `https://api.sentiedge.ai/api`)
- Credentials: `AGENT_TEST_EMAIL` / `AGENT_TEST_PASSWORD` or `--email` / `--password`
- Target agent name or ID

## Basic Usage

```bash
AGENT_TEST_EMAIL=you@example.com AGENT_TEST_PASSWORD=secret \
  node tests/questions/run_questions.mjs --agent-name CryptoTrader
```

## Run Only Certain Levels

```bash
node tests/questions/run_questions.mjs --agent-name CryptoTrader --levels 1,3 \
  --email you@example.com --password secret
```

## Binance Agent-Process Integration Suite

```bash
PLUGIN_CEX_TEST_EMAIL=you@example.com PLUGIN_CEX_TEST_PASSWORD=secret \
  AGENT_TEST_AGENT_URL=https://agent.sentiedge.ai \
  node tests/questions/run_plugin_cex_binance_suite.mjs
```

Or via harness directly:

```bash
pnpm test:agent-suite -- \
  --suite tests/questions/binance_action_execution_questions.json \
  --approval-json tests/questions/binance_endpoint_approval_templates.json \
  --email you@example.com --password secret \
  --agent-url https://agent.sentiedge.ai
```

Before running trading cases, edit approval templates and keep create-order `quote_size` in a low-notional range.

## Options (`run_questions.mjs`)

- `--base-url` Agent base URL (`QUESTION_RUNNER_BASE_URL` / `AGENT_TEST_AGENT_URL`, default `https://agent.sentiedge.ai`)
- `--auth-base-url` Django API base (`AGENT_TEST_AUTH_URL`, default `https://api.sentiedge.ai/api`)
- `--questions` Questions JSON path (default: `tests/questions/test_questions.json`)
- `--agent-id` Target agent UUID
- `--agent-name` Target agent name (character)
- `--email` Login email
- `--password` Login password
- `--levels` Comma-separated levels to run (e.g. `1,2,3`)
- `--approval-json` CEX workflow approval template JSON for auto-approve hooks

## Notes

- The harness auto-approves task chains and CEX workflow steps when hooks and `--approval-json` are configured.
- Run artifacts (reports, SSE transcripts) are written under `tests/agent-harness/runs/<timestamp>/`.
- `--user-email` is removed; use Django login credentials for production.
