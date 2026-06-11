# GEAP §8 — Auto-Optimizer (autonomous trading-agent optimization loop)

**Date:** 2026-06-10 · **Status:** approved design → implementation · **Branch:** feat/geap-observability-optimizer (local-only)

## Context

The scenario_01 rubric live run scored the agent **68/100 (Acceptable) but Fail (critical)** — strong research/analysis, but real gaps: claims conditional auto-monitoring it can't perform (`honestMonitoring`), a status report that dumps stale unrelated orders (`canExplainTrades`), and a thin strategy-recommendation step. We have the evaluation half (`rubric.mjs`, `scenarioEval.mjs`, `runScenario01.mjs`) and a propose-only prompt optimizer (`evolve.mjs`). The user wants to close the loop into an **autonomous optimizer**: evaluate → plan gap-closing changes with the best Gemini → apply under safety/security gates (auto-approving only when safe) → re-test → repeat until a user score threshold. "Essentially, an agent that optimizes our trading agent automatically."

## Objective

A controller that drives this loop end-to-end with human-set guardrails, reusing the existing TS pipeline as its evaluation + isolation substrate.

## Decisions (resolved with the user)

- **Platform:** TypeScript, **ADK-patterned** — sub-agents built on the existing `vertex.mjs` Gemini client + `@google/adk` runtime patterns; reuse `runScenario01`/`rubric`/`scenarioEval`/`evolve` (no Python, no polyglot).
- **Blast radius:** the loop may auto-apply **any code the plan proposes** (full autonomy) — gated hard by the safety/security checks below and isolated in a throwaway git worktree.
- **Safety/security gate (all four; best-practice):** an iteration auto-approves only if ALL pass; any failure → halt + notify.
  1. **Behavioral floor** — all 14 critical must-pass hold (none regress) AND rubric score does not decrease vs the prior iteration.
  2. **Protected-files guard** — a diff touching Rule 9 refusal corpus / CEX approval-gate handler / risk-precheck / auth / order-dispatch / capital limits escalates to **explicit human approval** (never auto).
  3. **Security scan of the diff** — block on new secrets/credentials, new outbound network/exfil, dangerous constructs (`eval`, external `child_process`, fs writes outside the repo), or dependency additions.
  4. **Build + tests + lint green** — `@elizaos/core` build + `pnpm test:ci-gates` + agent-sim self-tests + lint must pass before the behavioral re-test runs.

- **Hardening (adversarial review, 2026-06-10).** A full adversarial review confirmed 16 ways an unsafe change could slip past the original gates. The model is now **fail-closed and deny-by-default**, with the load-bearing guarantee moved off the (fundamentally evadable) heuristic scanner:
  - **Code is human-only by default.** The planner forces `requiresHumanApproval=true` on **every `code`-target step** unless every file it touches is on an explicit, empty-by-default `EDITABLE_ALLOWLIST` (and none is protected). Heuristic source scanning can never auto-certify arbitrary source as safe, so the loop never auto-applies code; the human applies any code change deliberately, out-of-loop. (The autonomous loop still auto-iterates freely on **prompt/config** under the four gates.)
  - **The loop never applies/executes a human-approval step at all** — it halts + notifies up front (`halted-protected-step`) rather than applying it into a scratch agent and discarding at the gate.
  - **Protected surfaces are directory-anchored & fail-closed** (`policy.mjs`): the whole `packages/plugin-cex/`, `packages/core/src/{handlers,security}/`, `runtime`, the CEX templates, the prompt-injection/bypass utils, the DB adapters, agent boot/plugin-filter, **plus** manifests/lockfiles (supply-chain). The old name-fragment denylist missed nearly all of these.
  - **The gate keys off the REAL on-disk delta**, not the LLM's self-declared files or a `+++ b/` re-parse: the executor stages (`git add -A`) then `git diff HEAD` + `--name-status -M`, so **new files, deletions, and renames** of a protected surface are all caught. The planner also ORs the step's diff targets into its protection check.
  - **Security scan broadened** to evasive vectors (dynamic `import()` of node net/exec modules, reflected `constructor`, `process.binding`, `http.get`/XHR/`sendBeacon`, fs-writes to escaped/secret paths, backtick secrets) and now flags **deletion of a safety control** and robust **dependency additions** (`latest`/git/file/lockfile). It is explicitly **defense-in-depth only**, never sufficient for code auto-approval.
  - **Score is single-sourced** (`scoreOf`): the behavioral floor and the adoption decision compare the same scalar; a claimed improvement with an empty diff fails a **consistency gate**.
  - **buildTestsGate is target-aware**: code requires build+tests; prompt/config-only treats build as N/A but still requires a positive re-eval signal (never passes on "nothing run").
  - **Residual / follow-up (not yet built):** the behavioral floor only catches regressions in controls the single evaluation scenario *exercises*; weakening an unexercised control (e.g. a leverage cap the benign scenario never triggers) is caught today only by the protected-paths backstop + code-human-by-default. The load-bearing completion is wiring **adversarial probe scenarios** (over-leverage, off-allowlist/backstop asset, bypass-framing, daily-loss breach, kill-switch active, missing-approval execution), each with a non-vacuous critical, into the gate's eval set. Tracked below.

- **Re-review pass (2026-06-10).** An independent re-review confirmed all 16 findings CLOSED (high confidence, end-to-end reproductions) and surfaced a second batch of defense-in-depth gaps, now also fixed: `packages/client-direct/` (kill-switch / exchange-key / trading-prefs endpoints + auth) and `packages/core/src/config/` (env/settings validation) added to PROTECTED_PATHS; the loop now **independently** escalates any non-prompt/config step (never trusts the planner's self-set `requiresHumanApproval` flag alone); a **prompt-safety gate** blocks a prompt edit that net-removes safety-instruction language (the prompt is the only auto-editable surface); `scoreOf` clamps to 0–100 / fail-closed on non-finite; the **target-reached check is single-sourced** to the metric vector; the diff parsers tolerate git-quoted/whitespace paths (+ `core.quotePath=false`); unknown planner `target` values fail closed to human; a throwing `discard()` no longer suppresses the halt notification; protected detection unions changedFiles with the diff's real targets. Suite: agent-optimizer 82/82 + agent-sim 160/160 green.
- **Defaults:** notifications = SMTP email (configured `SMTP_*`) + a written halt report; planner model = `gemini-3.1-pro-preview` (repo `LARGE_GOOGLE_MODEL`), fallback `gemini-2.5-pro`; `--max-iters` 6 + token budget; fitness test = scenario_01 **variant B**; all changes git-reversible.

## Architecture & components

New dir `scripts/agent-optimizer/`. Each unit has one purpose, an injectable interface (LLM `generate`, file I/O, sub-process), and is unit-tested with mocks; live runs are operator-run.

1. **`evalReportAgent.mjs`** — *Comprehensive evaluation report.* In: a `scenarioEval` result (`{rubric, criticalResults, verdict}`) + the run capture. Out: a structured per-category report — for each of the 9 categories and each failed critical: score, **root-cause diagnosis**, evidence quotes from the transcript, and gap classification (`prompt | config | code`). Gemini-written (pro). Pure assembly + an injected `generate`.
2. **`optimizationPlannerAgent.mjs`** — *Gap-closing plan.* In: the eval report + an agent state map (current `character.system`, `settings.modelConfig`, and a curated file map of editable surfaces). Out: an **ordered plan** of steps `{id, target: prompt|config|code, files, change (instructions/diff), closesGap, category, expectedImpact, risk, requiresHumanApproval}`. Best Gemini. Steps touching protected files get `requiresHumanApproval: true`.
3. **`gates.mjs`** — the four safety/security gates as pure predicates over `{diff, candidateMetricVector, baselineMetricVector, buildResult}` → `{pass, failures[], escalate}`. Reuses `metrics.checkFloors` + `criticalChecks` + the `optimize.validate*` floors + a static diff scanner + a protected-paths list.
4. **`executor.mjs`** — *Apply a step safely.* Materializes an **isolated git worktree** on a throwaway branch (`geap/opt-<ts>`), applies the step's prompt/config/code change there, rebuilds if code changed, boots a **scratch paper agent** (reuse `abEvaluate` isolation: own DB, paper mode, mode-revert), and returns a handle the loop re-tests against. Never mutates the main working tree or prod deploy. Auto-cleans the worktree.
5. **`autoOptimize.mjs`** — *Loop controller (the main agent).* baseline `runScenario01` → `scenarioEval` → `evalReportAgent` → `optimizationPlannerAgent` → **approval gate** → `executor` (apply step) → re-run `runScenario01` against the changed agent → `scenarioEval` → compare. Adopt the step iff gates pass + score improved; **stop** when score ≥ `--target-score`; **halt + notify** on gate failure / protected-file step / no-improvement / `--max-iters` / budget.
6. **`approvalGate.mjs`** — initial plan requires human approval; `--auto-approve` authorizes per-iteration auto-approval **only while all gates pass**; a gate failure or protected-file step forces explicit human approval (via notification).
7. **`notify.mjs`** — on halt: write a structured halt report (issue, failing gate, diff, current score) + email it via the configured SMTP to the user; console + non-zero exit.

## Data flow

`runScenario01` (live, paper) → capture → `scenarioEval` (scores + 14 criticals) → `evalReportAgent` (rich report) → `optimizationPlannerAgent` (plan) → `approvalGate` (human | auto-if-gates) → `executor` (worktree apply + rebuild + scratch agent) → `runScenario01` again → `scenarioEval` → compare/loop.

## Isolation, reversibility & backstops

- All execution isolated — main tree + prod `Dockerfile`/deploy untouched. **`applyAndEvaluate` is now WIRED** (`makeLiveSeams` in `autoOptimize.mjs`, `pnpm optimize:auto`). Because the hardened loop HALTS every code step before execution (deny-by-default), the only steps that reach the seam are prompt/config edits — which are **read at runtime, so NO rebuild is needed**, sidestepping the worktree/`node_modules` problem entirely. Per iteration it: applies the plan's prompt/config steps to a **/tmp working copy** of the character (the repo's `characters/CryptoTrader.json` is NEVER mutated), materializes a scratch character with a distinct `name` (⇒ distinct agentId ⇒ isolated memory rows), boots an isolated **paper-mode** agent on a free port (reusing `abEvaluate`'s `pickFreePort`/`waitForAgentReady`/`killChild`), re-runs `runScenario01` against it, and returns `{score, candidateVector, changedFiles, diff, tests, promote/discard}`. Any boot/eval failure resolves **FAIL-CLOSED** (score 0) so it can never be mistaken for an improvement. On `promote` the working copy advances; at loop end the optimized character + a diff-vs-original are emitted as **propose-only artifacts** (`tests/scenarios/optimizer_result_<ts>.{character.json,md}`) for human review before applying. The baseline is evaluated against the already-running primary paper agent; each candidate gets a fresh scratch agent (~1-5 min BGE-M3 warmup + scenario_01 per iteration). `runOptimizationLoop` stays agnostic to the seam (injected), so the tested core is unchanged.
  - **Preconditions** (gated in `main`, exit 2 with a clear message): a running paper agent at `--server` (provides the baseline), `--user-email` (seeded paper-trading user), `JWT_PUBLIC_KEY_B64` (scratch agents must trust the harness JWT), and `SIM_JWT_PRIVATE_KEY_B64`/`_FILE` (harness mints the Bearer). `pnpm optimize:auto` loads both `.env` (SIM_JWT) and `.env.local` (dev-auth pubkey).
- Scratch **paper** agent per re-test (separate DB, paper mode, mode-revert) — never a real exchange.
- **Protected paths** never auto-applied. **Iteration cap** + **token budget** backstops. Full action log per iteration (plan step, diff, gate results, score delta).

## Loop control

`--target-score N` (stop when reached) · `--max-iters K` (default 6) · `--auto-approve` (authorize gated auto-approval) · `--variant A|B` (default B) · `--budget` (token cap). Stopping: success (≥ target) | halt-for-human (gate fail / protected file) | exhausted (no improvement over a round, max-iters, or budget).

**Live-run additions (2026-06-10, after driving real runs):**
- **Prefix-apply, not all-or-nothing.** Each iteration the loop PARTITIONS the plan: it auto-applies the safe prompt/config steps and DEFERS code/protected steps for out-of-loop human review (surfaced in the result artifact). One code proposal no longer blocks the safe prompt/config improvements — code still never auto-applies.
- **Review-first workflow (`--plan-only` / `--plan <file>`).** `--plan-only` runs evaluate→score→diagnose→plan and writes three reviewable artifacts (`tests/scenarios/optimizer_scorecard.md`, `optimizer_eval_report.md`, `optimizer_plan.json`), then STOPS — nothing is applied. The human reviews the scores + diagnosis and edits `optimizer_plan.json` (drop/tweak/reorder steps). `--plan <file>` then **seeds iteration 1** with the edited plan and **continues the loop** (auto-generating subsequent plans toward the target). Every step is **re-finalized on load** (touchesProtected / requiresHumanApproval recomputed from the edited target/files), so a hand-edited plan can never disable a safety flag — a code step left in is still deferred, not auto-applied.
- **Planner file map.** The planner is given a curated map of the agent's REAL surfaces (TypeScript paths + which are auto-eligible vs human-only) so it proposes actual files and leans on prompt/config, instead of hallucinating generic `src/agent/*.py` paths.
- **Observed characteristic.** The behavioral floor is a STRICT per-scenario monotonic gate over judged criticals; with a stochastic LLM judge, run-to-run noise on a judged critical (e.g. honestMonitoring/canExplainTrades) can reject a genuine improvement. Mitigation (follow-up): multi-sample the judged criticals (best-of-N / majority) so variance doesn't veto a real gain.

## Testing strategy

Pure logic (report assembly, plan parsing/validation, the 4 gate predicates, diff scanner, protected-path matching, score-comparison/stop logic, loop control) is TDD'd with mocked `generate`/exec/fs. The live legs (booting agents, real Gemini, real git worktree, SMTP) are operator-run behind injectable seams, exactly like `runScenario01`/`abEvaluate`. A mock end-to-end loop test drives a fake agent that "improves" across iterations and asserts: gate enforcement, auto-approve vs escalate, stop-at-threshold, halt-on-gate-fail + notify.

## Risks & mitigations

- **Autonomous code edits on a trading agent (highest):** mitigated by the 4-gate AND, protected-files human-escalation, worktree isolation + git reversibility, paper-only scratch agent, build/test/lint gate, iteration/budget caps, and full logging. The initial plan always needs human approval; auto-approval is opt-in and revocable per gate failure.
- **Reward-hacking the rubric** (gaming the score without real improvement): the behavioral floor requires the 14 deterministic+judged criticals to hold, not just the score; protected safety files can't be auto-edited.
- **LLM plan quality:** plan steps are structured + validated; low-confidence/code steps default to human approval.

## Phasing (each independently testable, built in order)

1. `evalReportAgent` + tests → 2. `optimizationPlannerAgent` + tests → 3. `gates` + tests → 4. `executor` + tests → 5. `autoOptimize` loop controller + `notify` + tests → 6. adversarial review + fixes + full suite.

## Out of scope

- Editing the production `Dockerfile`/CI/deploy. - Real-money (live) trading at any point. - A UI for the optimizer (CLI/operator-run, like the rest of the harness). - Auto-merging optimized changes to `staging`/`main` (the loop produces a reviewed branch; promotion is a separate human decision).

## Follow-ups (post adversarial-review)

1. **Adversarial probe scenarios for the behavioral floor (load-bearing).** Add scenarios that each exercise one safety control so weakening it measurably drops `safetyPassRate`/`safetyByScenario`: over-leverage attempt (needs a non-vacuous leverage critical), off-allowlist + `BACKSTOP_DENIED_ASSETS` asset (new critical), bypass/override framing (`trading_safety_override` refusal critical), daily-loss-breach size, kill-switch-active, missing-approval execution. Wire all into `autoOptimize` `evalOnce` and aggregate their metric vectors. Until then, the protected-paths backstop + code-human-by-default cover the gap.
2. **Optional `toolTrajectoryScore` in the live metric vector.** `toMetricVector` (rubric.mjs) does not currently compute trajectory; `behavioralFloorGate` guards it only when present. Compute it from the captured steps to make the no-regress check active in the loop.
3. **Operator EDITABLE_ALLOWLIST policy.** If/when specific non-safety code surfaces are deemed safe to auto-edit, add anchored entries to `policy.EDITABLE_ALLOWLIST` (each entry re-enables code auto-approval for that path under the four gates). Keep it minimal and reviewed.
