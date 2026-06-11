/**
 * GEAP §8 Auto-Optimizer — the four SAFETY/SECURITY gates that decide whether an iteration may
 * AUTO-APPROVE (no human). An iteration auto-approves only when ALL gates pass; any failure makes
 * the iteration `autoApprovable: false` with an `escalations` list, and the loop halts + notifies
 * the user for explicit review. Pure predicates over the candidate change (LLM/exec/git are upstream).
 *
 *   1. behavioralFloorGate — the 14 criticals must not regress AND the rubric score must not drop.
 *   2. protectedFilesGate  — no changed file touches a protected safety surface (policy.mjs).
 *   3. securityScanGate     — the diff adds no secret / outbound-network / dangerous construct / dep,
 *                             AND removes no safety control.
 *   4. buildTestsGate       — build + tests + lint are green (injected runner results).
 *
 * IMPORTANT (adversarial-review note, 2026-06-10): securityScanGate is a HEURISTIC scanner and is
 * fundamentally evadable (obfuscation, reflection, split strings). It is defense-in-depth, NEVER a
 * sufficient certificate of safety for arbitrary source. The load-bearing guarantee that an unsafe
 * code change cannot auto-approve comes from the PLANNER forcing every `code`-target step to require
 * human approval (deny-by-default; see optimizationPlannerAgent.finalizeStep + policy.EDITABLE_ALLOWLIST)
 * and from protectedFilesGate, which keys off the REAL on-disk delta (add/modify/delete/rename).
 */

import { checkFloors } from "../agent-sim/metrics.mjs";
import { isProtectedPath } from "./policy.mjs";
import { parseChangedFiles } from "./executor.mjs";

/** Single source of truth for the iteration's score scalar (rubric total). Exported so the loop's
 *  adoption decision and the behavioral floor compare the SAME number (no silent divergence).
 *  Clamped to the 0–100 rubric range and fail-closed to 0 on a non-finite value, so a malformed
 *  candidateVector (rubricTotal=1e9 / NaN) can't sail to a premature "success" / adoption. */
export const scoreOf = (v) => {
    const raw = typeof v?.rubricTotal === "number" ? v.rubricTotal : typeof v?.taskScore === "number" ? v.taskScore * 100 : 0;
    return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
};

/**
 * Gate 1 — behavioral floor: criticals don't regress (per-scenario) + rubric score doesn't drop.
 *
 * SCOPE CAVEAT: this floor can only detect a regression in a safety control that the evaluation
 * scenario actually EXERCISES (its 14 criticals). A change that guts an UNexercised control (e.g.
 * a leverage cap or off-allowlist refusal the benign scenario never triggers) does not move
 * safetyPassRate/safetyByScenario and would pass this gate in isolation. That blind spot is covered
 * by protectedFilesGate (every risk-control/refusal source file is a PROTECTED_PATH ⇒ a human-only
 * edit) and by the planner forcing all code steps to human approval. Wiring adversarial probe
 * scenarios into the eval set is the load-bearing completion (tracked in the §8 spec follow-ups).
 */
export function behavioralFloorGate({ baselineVector, candidateVector }) {
    const floor = checkFloors(candidateVector, baselineVector);
    const reasons = [...floor.reasons];
    const candScore = scoreOf(candidateVector);
    const baseScore = scoreOf(baselineVector);
    if (candScore < baseScore) reasons.push(`rubric score regressed (${candScore} < ${baseScore})`);
    // Tool-trajectory is an OBJECTIVE, not a HARD_FLOOR, and the live metricVector does not always
    // carry it; guard it only when BOTH sides are finite (fail-open when absent, by design).
    const ct = candidateVector?.toolTrajectoryScore;
    const bt = baselineVector?.toolTrajectoryScore;
    if (Number.isFinite(ct) && Number.isFinite(bt) && ct < bt) reasons.push(`tool-trajectory score regressed (${ct} < ${bt})`);
    return { gate: "behavioral", pass: reasons.length === 0, reasons };
}

/** Gate 2 — protected-files: any protected surface in the diff escalates to explicit human approval.
 *  Fail-closed on a malformed (non-array, non-nullish) changedFiles input. */
export function protectedFilesGate(changedFiles = []) {
    if (changedFiles != null && !Array.isArray(changedFiles)) {
        return { gate: "protected", pass: false, reasons: ["changedFiles is not an array (fail closed)"] };
    }
    const hits = (changedFiles ?? []).filter(isProtectedPath);
    return { gate: "protected", pass: hits.length === 0, reasons: hits.length ? [`touches protected surface(s): ${hits.join(", ")}`] : [] };
}

// ── Heuristic security scanners (conservative: a hit ⇒ escalate to human) ───────────────────────
// SECRET_RE now also matches backtick-quoted secrets.
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{20,}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'`][^"'`]{12,}["'`])/i;
const re = (...parts) => new RegExp(parts.map((r) => r.source).join("|"));
// Outbound network: fetch/axios/http(s)/net/dgram/ws + dynamic import/require of those + remote-URL import.
const NETWORK_RE = re(
    /\bfetch\s*\(/, /\baxios\b/, /\bhttps?\.(request|get)\b/, /\bnet\.(connect|createConnection)\b/,
    /new\s+WebSocket\b/, /\bdgram\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bEventSource\b/,
    /\b(?:import|require)\s*\(\s*["'`](?:node:)?(?:https?|net|dgram|tls|dns)\b/,
    /\bimport\s*\(\s*["'`](?:https?:)?\/\//, // dynamic import of a remote / protocol-relative URL
    /\bimport\s[^\n;]*\bfrom\s*["'`](?:node:)?(?:https?|net|dgram|tls|dns|ws|undici|got|node-fetch|superagent|phin)["'`]/, // static import of a net module
    /\bimport\s[^\n;]*\bfrom\s*["'`](?:https?:)?\/\//, // static import of a remote / protocol-relative URL
    /\b(?:from|require\s*\()\s*\(?\s*["'`](?:ws|undici|got|node-fetch|superagent|phin)["'`]/,
    /(?:window|self|globalThis)\s*\[\s*["'`](?:fetch|XMLHttpRequest|WebSocket)/, // computed-member network access
);
// Dangerous exec / dynamic-code / reflection constructs.
const DANGER_RE = re(
    /\beval\s*\(/, /new\s+Function\s*\(/, /\bchild_process\b/, /\bexecSync\b/, /\bspawnSync\b/,
    /\bexec\s*\(/, /\bspawn\s*\(/, /\bfork\s*\(/, /process\.binding\b/,
    /\b(?:import|require)\s*\(\s*["'`](?:node:)?(?:child_process|vm)\b/,
    /\bvm\.(runIn|compileFunction)/, /runInNewContext|runInThisContext/,
    /\.constructor\s*\.\s*constructor\b/, /\bconstructor\s*\(\s*["'`]/, /globalThis\s*\[/,
);
// fs write whose target escapes the repo (../) or targets a secret/credentials file.
const FS_WRITE_RE = /\bfs(?:\.promises)?\.(?:write|writeFile|writeFileSync|append|appendFile|appendFileSync|createWriteStream|mkdir|rm|rmdir|unlink|symlink|copyFile|rename)\w*\s*\(/;
const FS_ESCAPE_OR_SECRET_RE = /\.\.\/|["'`][^"'`]*\.(?:env|pem|key)\b|["'`][^"'`]*(?:credentials|secret)/i;
// Removal of a safety control (DELETED diff line). Removing a gate is a safety-equivalent edit.
const SAFETY_REMOVAL_RE = /\b(killSwitch|riskPrecheck|runRiskPrecheck|assetAllowlist|leverageCap|maxOrderSize|maxNotional|dailyLossLimit|cooldown|exposureCap|slippageCap|marketDataFreshness|reconciliationHealth|BACKSTOP_DENIED_ASSETS|requiresApproval|requiresHumanApproval|human_input_required|trading_safety_override|verifyBearerJwt|promptInjection)\b/;
// Dependency detection (only when a manifest/lockfile is touched).
const MANIFEST_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i;
const MANIFEST_HEADER_RE = /^\+\+\+ .*(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)/m;
const DEP_RE = /^\+\s*"[^"]+"\s*:\s*"[^"]+"\s*,?\s*$/; // any added "name": "<spec>" line in package.json
const DEP_SPEC_DANGER_RE = /"(?:git(?:\+(?:ssh|https?))?|github|gitlab|bitbucket|file|link|portal|https?):/i;
const LOCKFILE_PKG_RE = /^\+\s*\/?[^@\s]+@[^:\s]+:/; // e.g. pnpm-lock "+  /evil@1.0.0:"

/** Gate 3 — security scan of the unified diff (added lines + dep additions + safety-control removals). */
export function securityScanGate(diff = "", changedFiles = []) {
    const lines = String(diff).split("\n");
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const touchesManifest =
        (changedFiles ?? []).some((f) => MANIFEST_RE.test(String(f))) || MANIFEST_HEADER_RE.test(String(diff));
    const reasons = [];
    for (const line of added) {
        const body = line.slice(1);
        if (SECRET_RE.test(body)) reasons.push(`possible secret/credential added: ${body.trim().slice(0, 60)}`);
        if (NETWORK_RE.test(body)) reasons.push(`new outbound-network call added: ${body.trim().slice(0, 60)}`);
        if (DANGER_RE.test(body)) reasons.push(`dangerous construct added: ${body.trim().slice(0, 60)}`);
        if (FS_WRITE_RE.test(body) && FS_ESCAPE_OR_SECRET_RE.test(body)) reasons.push(`fs write to escaped/secret path: ${body.trim().slice(0, 60)}`);
        if (touchesManifest && (DEP_RE.test(line) || DEP_SPEC_DANGER_RE.test(body) || LOCKFILE_PKG_RE.test(line)))
            reasons.push(`dependency added: ${body.trim().slice(0, 60)}`);
    }
    for (const line of removed) {
        const body = line.slice(1);
        if (SAFETY_REMOVAL_RE.test(body)) reasons.push(`safety control removed: ${body.trim().slice(0, 60)}`);
    }
    const uniq = [...new Set(reasons)];
    return { gate: "security", pass: uniq.length === 0, reasons: uniq };
}

/**
 * Gate 4 — build/tests/lint must be green. Each input is { ok: boolean, summary?: string }.
 * Target-aware: a `code` step (or unknown targets ⇒ assume code, fail-safe) requires BUILD + TESTS;
 * a prompt/config-only plan has no compiled artifact, so build is N/A but a positive verification
 * signal (the scenario re-eval / self-tests = `tests`) is still REQUIRED — the gate never passes on
 * "nothing run". Missing required results (undefined) fail CLOSED.
 */
export function buildTestsGate({ build, tests, lint, targets } = {}) {
    const reasons = [];
    if (build && build.ok === false) reasons.push(`build failed: ${build.summary ?? ""}`.trim());
    if (tests && tests.ok === false) reasons.push(`tests failed: ${tests.summary ?? ""}`.trim());
    if (lint && lint.ok === false) reasons.push(`lint failed: ${lint.summary ?? ""}`.trim());
    const hasCode = !Array.isArray(targets) || targets.includes("code"); // unknown targets ⇒ strict
    const required = hasCode ? [build, tests] : [tests];
    const allRun = required.every((r) => r && r.ok === true) && (lint == null || lint.ok === true);
    const notRun = hasCode ? "build/tests not run (fail closed)" : "verification (tests/re-eval) not run (fail closed)";
    return { gate: "build", pass: reasons.length === 0 && allRun, reasons: reasons.length ? reasons : allRun ? [] : [notRun] };
}

// Safety INSTRUCTION language (for the prompt surface) — the prompt analog of SAFETY_REMOVAL_RE.
const SAFETY_INSTRUCTION_RE = /\b(?:requires?\s+approval|approval\s+required|human[\s_-]?(?:input|approval)|re-?approv\w*|refus\w*|\breject\b|\bdeny\b|leverage|\bmargin\b|risk[\s_-]?(?:check|pre-?check|gate|limit)?|capital\s+limit|max(?:imum)?\s+notional|daily\s+loss|kill[\s_-]?switch|paper[\s_-]?mode|guardrail|do not execute|must not|never\s+(?:execute|trade|approve|skip))\b/i;

/**
 * Gate 5 — prompt-safety floor. The prompt (top-level system) is the loop's ONLY auto-editable
 * surface, and behavioralFloorGate only catches regressions the evaluation scenario exercises. This
 * blocks an auto-eligible prompt edit that NET-removes safety-instruction language (e.g. deletes a
 * refusal / approval / leverage rule the benign scenario never triggers). A reword (remove 1 / add 1)
 * is allowed; a net deletion escalates to human review.
 */
export function promptSafetyGate(diff = "") {
    const lines = String(diff).split("\n");
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---") && SAFETY_INSTRUCTION_RE.test(l.slice(1)));
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++") && SAFETY_INSTRUCTION_RE.test(l.slice(1)));
    if (removed.length > added.length) {
        return { gate: "prompt-safety", pass: false, reasons: [`net removal of safety-instruction language (${removed.length} removed vs ${added.length} added): ${removed[0].slice(1).trim().slice(0, 60)}`] };
    }
    return { gate: "prompt-safety", pass: true, reasons: [] };
}

/**
 * Run all gates. `autoApprovable` is true only when ALL pass; otherwise `escalations` explains why
 * the iteration needs explicit human approval (and the loop notifies + halts). Protected-file
 * detection unions the supplied changedFiles with the diff's real targets, so the two gate inputs
 * (changedFiles vs diff) can't be wired inconsistently to hide a protected edit.
 */
export function runGates({ baselineVector, candidateVector, changedFiles = [], diff = "", build, tests, lint, targets }) {
    const protInput =
        changedFiles != null && !Array.isArray(changedFiles)
            ? changedFiles // malformed ⇒ let protectedFilesGate fail closed
            : [...new Set([...(changedFiles ?? []), ...parseChangedFiles(diff)])];
    const gates = [
        behavioralFloorGate({ baselineVector, candidateVector }),
        protectedFilesGate(protInput),
        securityScanGate(diff, changedFiles),
        promptSafetyGate(diff),
        buildTestsGate({ build, tests, lint, targets }),
    ];
    const escalations = gates.filter((g) => !g.pass).map((g) => ({ gate: g.gate, reasons: g.reasons }));
    return { autoApprovable: escalations.length === 0, gates, escalations };
}
