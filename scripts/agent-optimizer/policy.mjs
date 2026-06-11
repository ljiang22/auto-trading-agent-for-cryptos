/**
 * GEAP §8 Auto-Optimizer — shared safety policy: the PROTECTED source surfaces that the autonomous
 * loop may NEVER auto-edit, and the (deny-by-default) set of code surfaces it MAY auto-edit.
 *
 * Adversarial-review hardening (2026-06-10): the original list was a fragile NAME-FRAGMENT denylist
 * that missed nearly the whole trading-safety surface (the risk engine + every risk rule, the
 * human-approval store, exchange-key crypto, intent validators, the order-submit path, setTradingMode,
 * the prompt-injection defense, and the runtime router). A code step editing any of those — or even
 * DELETING a safety rule — was classified non-protected and could auto-approve. This is now FAIL-CLOSED
 * on whole safety DIRECTORIES (anchored to repo-relative or absolute paths), plus the manifests/lockfiles
 * (a malicious dependency is a supply-chain risk), plus the original name fragments as belt-and-braces.
 *
 * Two layers, both consulted by the planner (forces human approval) and the gates (blocks auto-approval):
 *   - PROTECTED_PATHS      — surfaces the loop may NEVER auto-edit (trading-safety / security core).
 *   - EDITABLE_ALLOWLIST   — the ONLY code surfaces a `code`-target step may auto-edit. Empty by
 *                            default ⇒ deny-by-default: ANY code edit escalates to a human until the
 *                            operator explicitly opts a non-safety file in. (Heuristic source scanning
 *                            is fundamentally evadable, so arbitrary code is never auto-certified safe.)
 */

export const PROTECTED_PATHS = [
    // ── Fail-closed safety DIRECTORIES (anchored; match repo-relative or absolute paths) ──────────
    /(^|\/)packages\/plugin-cex\//i, // the ENTIRE CEX trading plugin: risk engine + rules, intent
    //   validators, reconciliation/ledger, order dispatch, paper venue, ADK fast-path, strategy, actions.
    /(^|\/)packages\/core\/src\/handlers\//i, // CEX approval gate, plan runner/executor, message handlers.
    /(^|\/)packages\/core\/src\/security\//i, // tokensCrypto (exchange-key AES) + any security primitive.
    /(^|\/)packages\/core\/src\/core\/runtime\b/i, // routeMessage routing + CEX/anonymous bypass guards.
    /(^|\/)packages\/core\/src\/templates\/cex/i, // cexMessageTemplate (Rule 9), cexDecompose/PlanAsText.
    /(^|\/)packages\/core\/src\/utils\/(promptInjectionDefense|cexBypassPredicate|googleVertexCredentials|axiosErrorSanitize)\b/i,
    /(^|\/)packages\/core\/src\/config\//i, // env/settings validation (validates EXCHANGE_TOKEN_ENCRYPTION_KEY etc.).
    /(^|\/)packages\/client-direct\/src\//i, // HTTP API + auth middleware + kill-switch / exchange-key / trading-prefs endpoints.
    /(^|\/)packages\/adapter-(mongodb|sqlite)\//i, // DB adapters (persistence of orders/prefs/ledger).
    /(^|\/)agent\/src\/(index|databaseAdapterSelection|pluginFilter)\b/i, // boot, DB selection, plugin allowlist.
    // ── Manifests + lockfiles: a dependency change is a supply-chain risk → always human review ───
    /(^|\/)package\.json$/i,
    /(^|\/)pnpm-lock\.yaml$/i,
    /(^|\/)package-lock\.json$/i,
    /(^|\/)yarn\.lock$/i,
    /(^|\/)pnpm-workspace\.yaml$/i,
    // ── Build / CI / deploy (out of scope entirely) ──────────────────────────────────────────────
    /Dockerfile|\.github\/workflows|\bdeploy\b|turbo\.json|biome\.json/i,
    // ── Name fragments (belt-and-braces; also catch bare filenames the planner self-declares) ─────
    /cexMessageTemplate/i, // Rule 9 non-negotiable refusal corpus
    /cexWorkflowMessageHandler|cexWorkflowSteps|cexPlanRunner|cexPlanExecutor|cexPlanState|cexPlanSchema/i,
    /riskEngine|riskPrecheck|runRiskPrecheck|risk[_-]?check|leverageCap|assetAllowlist|maxOrderSize|dailyLossLimit|killSwitch|BACKSTOP_DENIED_ASSETS/i,
    /humanInputState|human[_-]?input[_-]?required|requiresApproval|approvalGate/i,
    /tokensCrypto|EXCHANGE_TOKEN_ENCRYPTION_KEY|ipUtils|verifyBearerJwt|verifyJwt|\bauth\b|authentication/i,
    /canonicalIntent|intentHash|tradingLock|setTradingMode|getTradingMode/i,
    /reconciliation|pendingOrdersLedger|paper[_-]?venue|create[_-]?order|orderDispatch|binance|coinbase/i,
    /capital[_-]?limit|maxNotional|max[_-]?daily[_-]?loss|promptInjection/i,
    /\.env|dev-auth|credentials|secret/i, // secrets / auth material
];

/**
 * Code surfaces a `code`-target step is permitted to auto-edit (deny-by-default: EMPTY ⇒ every code
 * edit escalates to a human). Populate with anchored regexes for specific NON-safety files the
 * operator has reviewed and is willing to let the loop auto-modify. A path is auto-editable ONLY if
 * it matches the allowlist AND is not protected (protection always wins).
 */
export const EDITABLE_ALLOWLIST = [];

/** True if a file path (or a string mentioning one) touches a protected surface. */
export const isProtectedPath = (p) => {
    const s = String(p ?? "");
    return PROTECTED_PATHS.some((re) => re.test(s));
};

/**
 * True if a code path may be auto-edited by the loop: on the editable allowlist AND not protected.
 * With the default empty allowlist this is always false ⇒ all code escalates to a human.
 */
export const isAutoEditableCodePath = (p) => {
    const s = String(p ?? "");
    if (isProtectedPath(s)) return false; // protection always wins
    return EDITABLE_ALLOWLIST.some((re) => re.test(s));
};

/** Partition a list of file paths into { protected, editable }. */
export function partitionPaths(paths = []) {
    const prot = [];
    const editable = [];
    for (const p of paths) (isProtectedPath(p) ? prot : editable).push(p);
    return { protected: prot, editable };
}
