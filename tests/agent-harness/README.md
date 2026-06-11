# Agent test harness

General-purpose HTTP test runner for the SentiEdge agent API. Logs in with email/password against Django, calls the agent with **JWT Bearer** auth, consumes SSE from `POST /{agentId}/message/stream`, and evaluates extensible JSON suites.

Exchange API calls always execute on the **agent server** (e.g. production ECS), not on your laptop.

## URLs (production)

| Role | Typical base | Notes |
|------|----------------|-------|
| Auth (Django) | `https://api.sentiedge.ai/api` | `POST /authentication/validation/` |
| Agent (Node) | `https://agent.sentiedge.ai` (override with `AGENT_TEST_AGENT_URL`) | No `/api` prefix; same routes as [client-direct](../../packages/client-direct/src/index.ts) |

The React client uses [API_BASE_URL](https://github.com) `https://api.sentiedge.ai/api` for login and `VITE_SERVER_BASE_URL` for chat/stream.

## Quick start

```bash
cd senti-agent-0428

export AGENT_TEST_EMAIL="your-test-user@example.com"
export AGENT_TEST_PASSWORD="your-password"
export AGENT_TEST_AGENT_URL="https://agent.sentiedge.ai"
export AGENT_TEST_AUTH_URL="https://api.sentiedge.ai/api"   # optional default

pnpm test:agent-suite -- \
  --suite tests/agent-harness/suites/example.general.json \
  --agent-name CryptoTrader
```

Local dev (agent on 3000):

```bash
export AGENT_TEST_EMAIL="test@test.com"
export AGENT_TEST_PASSWORD="test"
export AGENT_TEST_AGENT_URL="http://127.0.0.1:3000"
export AGENT_TEST_AUTH_URL="http://127.0.0.1:3000"   # if auth is proxied locally

pnpm test:agent-suite -- --suite tests/agent-harness/suites/example.general.json
```

## CLI options

| Flag / env | Purpose |
|------------|---------|
| `--suite` | Path to suite JSON (required) |
| `AGENT_TEST_EMAIL` / `--email` | Login email |
| `AGENT_TEST_PASSWORD` / `--password` | Login password |
| `AGENT_TEST_AUTH_URL` / `--auth-url` | Django API base |
| `AGENT_TEST_AGENT_URL` / `--agent-url` | Agent API base |
| `AGENT_TEST_AGENT_NAME` / `--agent-name` | Character name |
| `AGENT_TEST_AGENT_ID` / `--agent-id` | Agent UUID |
| `--approval-json` | CEX approval templates (see `tests/questions/`) |
| `--filter-tags` | Subset by tag |
| `--filter-ids` | Subset by case id |
| `--concurrency` | Default `1` |
| `--out-dir` | Report output (default `runs/<timestamp>/`) |
| `--dry-run` | Validate suite JSON only |

## Outputs

- `report.json` — pass/fail summary per case
- `cases/<id>.jsonl` — raw SSE events per case

## Suite format

```json
{
  "name": "my-suite",
  "defaults": {
    "agentName": "CryptoTrader",
    "roomStrategy": "perCase",
    "hooks": ["cexAutoApprove"],
    "approvalTemplates": "tests/questions/binance_endpoint_approval_templates.json"
  },
  "cases": [
    {
      "id": "case-1",
      "tags": ["cex"],
      "message": { "text": "Show my balances" },
      "compose": {
        "action": "create_order",
        "params": {},
        "preApproved": false
      },
      "expect": {
        "finalTextContains": ["balance"],
        "expectedClassification": "CEX_WORKFLOW_MESSAGE",
        "expectedActions": ["get_balance"],
        "stepsInclude": ["Trading: risk check"],
        "maxDurationMs": 120000
      }
    }
  ]
}
```

### `roomStrategy`

- `perCase` (default) — new room per case
- `perLevel` — one room per `level` field (legacy question runner style)
- `reuse` — single shared room (`defaults.reuseRoomId` optional)

### Hooks

- `cexAutoApprove` / `humanInputAutoApprove` — on `human_input_required` SSE steps: polls `GET /agents/:id/:roomId/active-workflow`, then submits `POST /agents/:id/human-input/approval` with case approval templates + compose params. Legacy `cex_workflow_param_*` steps still use `cex-workflow/approval`.
- `cexAutoReject` / `humanInputAutoReject` — same path with `approvalDecision: rejected` or rejection template.
- Multi-step plan interrupts (`plan_context` on `human_input_required`) defer to the runner, which sends a continuation message (`yes` or `approve all remaining steps`).
- `taskChainAutoApprove` — approves task-chain steps

### Expectations

See [lib/assertions.mjs](./lib/assertions.mjs). Register custom checks:

```js
import { registerAssertion } from "./lib/assertions.mjs";
registerAssertion("myCheck", ({ transcript }) => {
  if (!transcript.lastAssistantText?.includes("OK")) return "missing OK";
  return null;
});
```

Suite: `"expect": { "custom": { "myCheck": true } } }`

### Compose (deterministic orders)

Set `compose.action`, `compose.params`, optional `composedPreApproved` — same fields as the trade-compose UI ([index.ts](../../packages/client-direct/src/index.ts)).

## Programmatic use

```js
import { runSuite } from "./tests/agent-harness/lib/runner.mjs";

await runSuite({
  authBaseUrl: "https://api.sentiedge.ai/api",
  agentBaseUrl: process.env.AGENT_TEST_AGENT_URL,
  email: process.env.AGENT_TEST_EMAIL,
  password: process.env.AGENT_TEST_PASSWORD,
  suitePath: "tests/agent-harness/suites/example.general.json",
  agentName: "CryptoTrader",
});
```

## Legacy runners

- [tests/questions/run_questions.mjs](../questions/run_questions.mjs) — wraps this harness for `test_questions.json` format
- [tests/questions/run_plugin_cex_binance_suite.mjs](../questions/run_plugin_cex_binance_suite.mjs) — Binance integration entry

## Production trading matrix (LIVE)

**`pnpm test:trading-prod`** runs the live Binance BTC-USDT suite (~6 USDT per write). Edit cases in [suites/trading-prod/trading-prod-catalog.mjs](suites/trading-prod/trading-prod-catalog.mjs); see [suites/trading-prod/README.md](suites/trading-prod/README.md) and [CASE_INDEX.md](suites/trading-prod/CASE_INDEX.md).

```bash
export AGENT_TEST_EMAIL=...
export AGENT_TEST_PASSWORD=...
export AWS_PROFILE=sentiedge-target   # CloudWatch [Trading] harvest

pnpm test:trading-prod:generate
pnpm test:trading-prod -- --filter-tags read_only   # safe partial run; teardown always runs
```

Uses three rooms (`perRoomGroup`): `read_only`, `spot`, `margin`. Venue prompts alternate explicit/implicit by catalog index (~50/50). Post-run: mandatory harness-scoped teardown (cancels only `harness-*` orders from the run), `audit/`, `analysis/dashboard.html`.

Re-analyze an existing run:

```bash
node scripts/qa/analyze-trading-suite.mjs --run-dir tests/agent-harness/runs/<timestamp>
```

## Safety

The harness does **not** enforce paper/live guards. Each suite file should document its own constraints (tags, `paper mode:` prefix, approval templates, testnet keys on the server).
