# GEAP side-environment — testing & deploy runbook

Operator runbook for standing up and verifying the **GCP side-environment** for the GEAP work
(§4 Observability, §5 Optimizer, §6 Deploy). This is a **separate, parallel** environment — it
touches **nothing** in AWS (the prod `Dockerfile`, `.github/workflows/*`, `deploy-production.sh`,
and the `sentiedge-docdb` cluster are all out of scope). Design doc: [docs/geap-optimization-guide.md](../../docs/geap-optimization-guide.md).

> **You can validate §4 + §3 with ZERO deploy** — the Cloud Trace exporter writes from anywhere
> with ADC. Do Phase 2 (local) first; deploy only when you want the agent hosted on GCP.

## Guardrails (do not violate)
- Throwaway datastore only — **never** `sentiedge-docdb` / `senti-agent-prod` / `senti-agent-staging`.
- Paper-trading account only (`PAPER_TRADING_ENABLED=true`); never a real venue/funds.
- Tracing is default-OFF (`OTEL_TRACING_ENABLED` unset) everywhere except this side-environment.
- `deploy-cloud-run.sh` aborts if any DB env var references a production datastore.

## Values you provide
`PROJECT_ID` · `REGION` (e.g. `us-central1`) · `RUNTIME_SA` (a dedicated service-account email).

---

## Phase 1 — GCP project / auth / IAM / Artifact Registry (§2)

```bash
gcloud auth login
gcloud auth application-default login          # ADC — used by the Cloud Trace exporter locally
PROJECT_ID=<id> RUNTIME_SA=<sa-email> REGION=<region> scripts/geap/setup-gcp.sh
```
`setup-gcp.sh` enables the APIs, creates the dedicated `senti-agent-geap` Artifact Registry repo
(idempotent), configures docker auth, and grants the SA `roles/cloudtrace.agent` +
`roles/aiplatform.user`. The OTel deps from the guide's §2 are **already committed** to
`packages/core/package.json` — no `pnpm add` needed.

## Phase 2 — test locally FIRST (validates §4 + §3, no deploy)

```bash
# terminal A — paper-mode agent with tracing ON
export GOOGLE_CLOUD_PROJECT=<PROJECT_ID>                     # Cloud Trace exporter target
export GOOGLE_VERTEX_PROJECT=<PROJECT_ID> GOOGLE_VERTEX_LOCATION=global
export GOOGLE_APPLICATION_CREDENTIALS_JSON="$(cat /path/sa-key.json)"   # agent Gemini + §3 judge
export DATABASE_ADAPTER=sqlite          # throwaway datastore (NEVER the prod cluster)
export PAPER_TRADING_ENABLED=true
export OTEL_TRACING_ENABLED=true        # default-off everywhere; ON here to exercise §4
pnpm build && pnpm start                # serves on SERVER_PORT (default 3000)
```
```bash
# terminal B — drive the §3 simulation (JWT keypair per scripts/agent-sim/README.md)
openssl genrsa -out /tmp/sim_priv.pem 2048 && openssl rsa -in /tmp/sim_priv.pem -pubout -out /tmp/sim_pub.pem
export JWT_PUBLIC_KEY_B64="$(base64 -w0 < /tmp/sim_pub.pem)"   # ← also export on terminal A before start
export SIM_JWT_PRIVATE_KEY_B64="$(base64 -w0 < /tmp/sim_priv.pem)"
export SIM_MOCK_PROVIDER=1
pnpm sim -- --server http://127.0.0.1:3000 --user-email <paper-user@example.com> --sim-mode
```
**Verify in Cloud Trace** (console → Trace Explorer, project `<PROJECT_ID>`): `handler:routeMessage`
roots with `node:requestParameterReview` / `node:executeAction` children, `Trading: …` step events,
and a filterable `decision.outcome` attribute — try `decision.outcome="risk_block"` and
`decision.outcome="awaiting_approval"`. That is §4 proven end-to-end.

## Phase 3 + 4 — build → push → deploy to Cloud Run

```bash
PROJECT_ID=<id> RUNTIME_SA=<sa-email> REGION=<region> scripts/geap/deploy-cloud-run.sh --dry-run   # preview
PROJECT_ID=<id> RUNTIME_SA=<sa-email> REGION=<region> scripts/geap/deploy-cloud-run.sh             # build+push+deploy
```
On Cloud Run the service runs **as** `RUNTIME_SA`, so ADC covers both Vertex and the Cloud Trace
exporter — no SA-JSON is passed. `PORT` is injected by Cloud Run and the image's CMD maps it to
`SERVER_PORT`. Defaults: `gen2`, `16Gi`/`4cpu`, `--no-cpu-throttling`, `--timeout 3600` (SSE),
`--no-allow-unauthenticated`. Sanity-check the memory/timeout against your project quota.

Re-run the Phase-2 sim against the Cloud Run URL (authenticated) and re-check Cloud Trace.

## §6.1 — Agent Runtime vs Cloud Run (the unverified contract)

The guide's chosen target was a custom container on **Agent Runtime**. From the GCP docs:
- ✅ `PORT` is a reserved env the platform injects; deploy is the Python SDK
  `client.agent_engines.create(config={"container_spec": {"image_uri": "<IMG>"}})`, whose
  documented `container_spec` exposes only `image_uri` (port/health/route internally managed).
- ❌ The exact **request/response interface** an Agent-Runtime custom container must serve
  (arbitrary HTTP on `$PORT` vs a fixed `/query`+`/streamQuery` or the inference `{"instances"}`
  contract) is **not documented**, so it can't be assumed for a long-lived SSE server.

**Therefore: deploy to Cloud Run first** (unambiguous "any HTTP server on `$PORT`", fits the SSE
server as-is, same Cloud Trace observability — and the guide's documented fallback). Once that's
green, try the same image via the Console **"Deploy from Container Image"** wizard, which shows the
exact port/health/serving fields it expects. If it accepts a plain HTTP server on `$PORT`, the
identical image works; if it demands `/query`+`/streamQuery` or `{"instances"}`, stay on Cloud Run
or add a thin adapter route. **Do not guess the contract.**

## Phase 5 — end-to-end DoD (guide Appendix C)
1. **Observability** — `decision.outcome` is a filterable Cloud Trace attribute on the conflict-node spans.
2. **Simulation** — `pnpm sim …` writes `tests/scenarios/sim_results.json`; **non-zero exit on any safety failure**.
3. **Optimizer** — `pnpm build` → `pnpm sim` (produces `sim_results.json`) → `pnpm optimize` → emits a
   report (and a `.patch` only after an A/B pass); confirm it does **not** mutate the tree or commit.

## Files
| File | Purpose |
|---|---|
| `setup-gcp.sh` | Phase 1: enable APIs, create AR repo, docker auth, IAM (idempotent; `--dry-run`) |
| `deploy-cloud-run.sh` | Phase 3+4: build `Dockerfile.agentruntime` → push → Cloud Run, with the prod-datastore guard (`--dry-run`, `--skip-build`) |
