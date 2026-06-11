/**
 * CEX Plan Executor — pure-function helpers for walking a saved plan.
 *
 * This file deliberately does NOT touch the runtime or the LangGraph
 * workflow. Its job is to answer questions like:
 *
 *   - What's the next step to execute given the current cursor?
 *   - Are there any read-only steps I can run in parallel right now?
 *   - Does the plan still have writes ahead of it, or are we done?
 *   - When step N completes successfully / fails, what new status does
 *     the plan transition to?
 *
 * The workflow imports these helpers and calls them from each LangGraph
 * node. Keeping the logic pure makes it cheap to unit-test all the
 * branch combinations without mocking the runtime or the venue adapters.
 *
 * Approval modes:
 *   - `step_by_step` (DEFAULT) — exactly one write executes per user
 *     turn. After the write completes, the plan transitions to
 *     `awaiting_approval` and the executor returns control. The user
 *     must reply "yes" (or "approve" / "continue") to proceed.
 *   - `batch` — all remaining writes execute back-to-back without
 *     pausing between. The user must explicitly opt in by replying
 *     "yes, all" / "approve all" / "batch" to a prior plan card.
 *
 * Failure handling:
 *   - DEFAULT IS BAIL. On the first step failure, the executor marks
 *     the failed step `failed`, marks every subsequent step `skipped`,
 *     and transitions the plan to `failed`. No "continue past failure"
 *     mode in this PR.
 */

import { elizaLogger } from "../utils/logger.ts";
import {
    deriveStake,
    type CexPlan,
    type CexPlanStep,
    type CexPlanStepDecomposed,
    type CexPlanStatus,
} from "./cexPlanSchema.ts";

// ---------------------------------------------------------------------------
// Step derivation
// ---------------------------------------------------------------------------

/**
 * Convert a decomposer-output step into a runtime step, deriving
 * `stake` and `requires_approval` from the action name. Status starts
 * at `pending` and gets advanced by the workflow.
 */
export function inflateStep(decomposed: CexPlanStepDecomposed): CexPlanStep {
    const stake = deriveStake(decomposed.action);
    const params = recoverCancelOrderIds(decomposed.action, decomposed.parameters, decomposed.description);
    return {
        id: decomposed.id,
        action: decomposed.action,
        venue: decomposed.venue ?? null,
        parameters: params,
        depends_on: decomposed.depends_on ?? [],
        stake,
        requires_approval: stake === "write",
        status: "pending",
        description: decomposed.description,
    };
}

/**
 * M4 iter6 (post-PR246) — defense-in-depth. When the decomposer LLM emits
 * a `cancel_order` step with the order id(s) only in the `description`
 * field and `parameters.order_ids` empty (the observed failure mode for
 * "cancel order 12345, 67890, 33333"), parse the id(s) out of the
 * description text into `parameters.order_ids` so the action handler
 * doesn't reject the step with "order_ids is required".
 *
 * Conservative: only fires for `cancel_order`, only when params has no
 * order_ids AND no `all_open` flag, and only when description contains
 * recognisable id-shaped tokens. Patterns:
 *  - long numeric (Binance order ids, ≥6 digits) — `\d{6,}`
 *  - prefixed client ids — `bn-…` or `cb-…` (Binance / Coinbase shapes)
 * Returns a NEW params object; never mutates the input.
 */
function recoverCancelOrderIds(
    action: string,
    parameters: Record<string, unknown>,
    description?: string,
): Record<string, unknown> {
    if (action !== "cancel_order") return parameters;
    if (parameters?.all_open === true || parameters?.all_open === "true") return parameters;
    if (!description || typeof description !== "string") return parameters;
    // M4a iter7 (post-PR247): MERGE ids found in description with any
    // partial set in parameters (instead of skipping when parameters
    // has SOME). The LLM sometimes captures only the first id of a
    // comma-separated list in parameters.order_ids while the
    // description text contains all of them. Union both sets so no
    // id is left behind.
    const longNumeric = description.match(/\b\d{6,}\b/g) ?? [];
    const clientId = description.match(/\b(?:bn|cb)-[A-Za-z0-9._-]{2,}\b/g) ?? [];
    const fromDescription = [...new Set([...longNumeric, ...clientId])];
    const fromParams = Array.isArray(parameters?.order_ids)
        ? (parameters.order_ids as unknown[]).map(String)
        : [];
    const merged = [...new Set([...fromParams, ...fromDescription])];
    if (merged.length === 0) return parameters;
    if (merged.length === fromParams.length) return parameters; // no new ids added
    return { ...parameters, order_ids: merged };
}

// ---------------------------------------------------------------------------
// Cursor / next-step queries
// ---------------------------------------------------------------------------

/**
 * Return the indices of all read-only steps that:
 *   1. Have status `pending` (not yet started),
 *   2. Have no unfulfilled dependencies,
 *   3. Sit at or beyond the cursor.
 *
 * The executor batches these into a single `Promise.all` so a "show
 * my balance and my orders" request hits both endpoints concurrently.
 */
export function readableSteps(plan: CexPlan): number[] {
    const completedIds = new Set(
        plan.steps.filter((s) => s.status === "ok").map((s) => s.id),
    );
    const out: number[] = [];
    for (let i = plan.cursor; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        if (step.stake !== "read") break; // stop at the first write — see note below
        if (step.status !== "pending") continue;
        if (step.depends_on.some((dep) => !completedIds.has(dep))) continue;
        out.push(i);
    }
    return out;
}
// NOTE on `break`: we stop at the first write because reads after a
// write may need the write's result (e.g. "place limit then show open
// orders"). The executor will resume scanning for parallel reads after
// each write completes.

/**
 * Return the index of the next write step that's ready to execute,
 * or null when there are no writes ahead. A write is "ready" when:
 *   - Its status is `pending`,
 *   - All `depends_on` steps are `ok`,
 *   - All earlier writes have already completed (writes are serial).
 */
export function nextWriteStep(plan: CexPlan): number | null {
    const completedIds = new Set(
        plan.steps.filter((s) => s.status === "ok").map((s) => s.id),
    );
    for (let i = plan.cursor; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        if (step.status !== "pending") continue;
        if (step.stake !== "write") continue;
        if (step.depends_on.some((dep) => !completedIds.has(dep))) continue;
        return i;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * Mark a step `ok` with the venue payload. Caller is responsible for
 * advancing the cursor if appropriate (parallel reads advance to the
 * highest completed index; writes advance one at a time).
 */
export function markStepOk(plan: CexPlan, stepId: string, payload?: unknown): void {
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
        elizaLogger.warn(`[CexPlanExecutor] markStepOk: step id=${stepId} not found`);
        return;
    }
    step.status = "ok";
    step.result = { payload, completed_at: Date.now() };
}

/**
 * Mark a step `failed` AND apply the bail policy: every later step
 * transitions to `skipped` and the plan moves to `failed`. The cursor
 * pins to the failing step's index so postmortem inspections can
 * locate the culprit.
 */
export function markStepFailedAndBail(
    plan: CexPlan,
    stepId: string,
    error: string,
): void {
    const idx = plan.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) {
        elizaLogger.warn(`[CexPlanExecutor] markStepFailedAndBail: step id=${stepId} not found`);
        return;
    }
    plan.steps[idx].status = "failed";
    plan.steps[idx].result = { error, completed_at: Date.now() };
    for (let i = idx + 1; i < plan.steps.length; i++) {
        if (plan.steps[i].status === "pending") {
            plan.steps[i].status = "skipped";
        }
    }
    plan.cursor = idx;
    plan.status = "failed";
    elizaLogger.info(
        `[CexPlan] step id=${stepId} idx=${idx} failed; bailing plan id=${plan.id} (skipped ${plan.steps.length - idx - 1} remaining)`,
    );
}

/**
 * Advance the cursor past steps that are no longer pending. Called
 * after a parallel read batch or a successful write completes.
 */
export function advanceCursor(plan: CexPlan): void {
    while (
        plan.cursor < plan.steps.length &&
        plan.steps[plan.cursor].status !== "pending"
    ) {
        plan.cursor++;
    }
}

/**
 * Decide the plan's next status given the current step statuses. The
 * caller passes this back into the store via `updatePlan`. Pure
 * function of `plan.steps` — no side effects.
 *
 * - If any step is `failed`, the plan is `failed` (regardless of
 *   `cursor` — failure is sticky).
 * - If all steps are `ok` / `skipped`, the plan is `completed`.
 * - If the cursor points at a pending write, the plan is
 *   `awaiting_approval` (step-by-step mode) or `executing` (batch).
 * - Otherwise the plan is `executing`.
 */
export function decideStatus(plan: CexPlan): CexPlanStatus {
    if (plan.steps.some((s) => s.status === "failed")) return "failed";
    if (plan.steps.every((s) => s.status === "ok" || s.status === "skipped")) {
        return "completed";
    }
    if (plan.cursor >= plan.steps.length) return "completed";
    const next = plan.steps[plan.cursor];
    if (next.stake === "write" && plan.approval_mode === "step_by_step") {
        return "awaiting_approval";
    }
    return "executing";
}

// ---------------------------------------------------------------------------
// Plan-shape introspection
// ---------------------------------------------------------------------------

/**
 * Count writes vs. reads. Used by the workflow to decide whether to
 * show the plan card at all (a single-step plan can take the legacy
 * path) and what to put in the approval prompt.
 */
export function planShape(plan: CexPlan): {
    total: number;
    reads: number;
    writes: number;
    hasMixedKinds: boolean;
} {
    const reads = plan.steps.filter((s) => s.stake === "read").length;
    const writes = plan.steps.filter((s) => s.stake === "write").length;
    return {
        total: plan.steps.length,
        reads,
        writes,
        hasMixedKinds: reads > 0 && writes > 0,
    };
}

/**
 * Detect dependency cycles via DFS. The decomposer can emit any
 * `depends_on` graph; a cycle would make the plan unexecutable. We
 * reject such plans at decomposition time rather than executing
 * partially.
 *
 * Returns null on no cycle; otherwise an array of step ids forming
 * the cycle.
 */
export function detectCycle(plan: CexPlan): string[] | null {
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const onStack = new Set<string>();
    const stack: string[] = [];

    function visit(id: string): string[] | null {
        if (onStack.has(id)) {
            const startIdx = stack.indexOf(id);
            return stack.slice(startIdx).concat(id);
        }
        if (visited.has(id)) return null;
        visited.add(id);
        onStack.add(id);
        stack.push(id);
        const step = byId.get(id);
        if (step) {
            for (const dep of step.depends_on) {
                if (!byId.has(dep)) continue; // dangling deps ignored by executor
                const cycle = visit(dep);
                if (cycle) return cycle;
            }
        }
        onStack.delete(id);
        stack.pop();
        return null;
    }

    for (const step of plan.steps) {
        if (!visited.has(step.id)) {
            const cycle = visit(step.id);
            if (cycle) return cycle;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Plan card rendering — for the in-chat status message
// ---------------------------------------------------------------------------

/**
 * Render the plan as a markdown card. Shown at three moments:
 *   1. Right after decomposition, before any execution.
 *   2. After each step completes in step-by-step mode.
 *   3. On plan completion / failure / cancellation.
 *
 * The status column reads from each step's live `status` so the same
 * function works for all three points.
 *
 * Format:
 *   **Plan**: <summary>
 *   **Mode**: step-by-step | batch
 *   **Status**: awaiting_approval | executing | …
 *
 *   | # | Status      | Action       | Venue   | Notes                |
 *   |---|-------------|--------------|---------|----------------------|
 *   | 1 | ✅ ok       | create_order | binance | filled at 62000      |
 *   | 2 | ⏳ pending  | create_order | binance | step-by-step gate    |
 *
 * The Notes column carries either the step's `description`
 * (pre-execution) or a one-line result summary (post-execution).
 */
const STATUS_ICONS: Record<CexPlanStep["status"], string> = {
    pending: "⏳",
    in_progress: "🔄",
    ok: "✅",
    failed: "❌",
    skipped: "⏭️",
};

// ---------------------------------------------------------------------------
// Inlined step-result rendering (Fix 3)
// ---------------------------------------------------------------------------

/**
 * Max line count for an inlined step-result block. Beyond this we
 * truncate and append a marker. The full result still lives in
 * `step.result.payload` for postmortem inspection.
 */
export const STEP_RESULT_BLOCK_MAX_LINES = 80;

const STEP_RESULT_TRUNCATION_MARKER = "_…truncated; full result persisted in step state_";

/**
 * Shape we expect on `step.result.payload` when the action callback
 * passes a `Content` object. The runner stores `{ ok, payload: content }`
 * where `content` came from the action handler — so this lines up with
 * the plugin-cex callback contract: `{ text, accounts | orders | fills | positions, ... }`.
 *
 * `text` is the deterministic markdown table the action callback already
 * built per Fix 1/2/4/4b. When present, we use it verbatim. When absent
 * we fall back to a minimal deterministic renderer (or to the LLM
 * fallback in the runner — that path lives in `cexPlanRunner.ts`).
 */
interface StepResultPayloadShape {
    text?: string;
    accounts?: unknown[];
    orders?: unknown[];
    fills?: unknown[];
    positions?: unknown[];
    scanned_symbols?: string[];
    estimated_total_usdt?: number;
    [key: string]: unknown;
}

function isPayloadShape(value: unknown): value is StepResultPayloadShape {
    return typeof value === "object" && value !== null;
}

/**
 * Render a `<details>` block carrying the deterministic content from a
 * single step's payload. Returns null when the step has no renderable
 * content (failure-only steps render via the Notes column instead).
 *
 * The block is wrapped in a `<details>` element so the in-chat card
 * stays compact — the user clicks to expand if they want the table.
 *
 * CEX post-PR237 Commit 5 (Issue 6) — Prefer the structured payload
 * over the action's pre-rendered short text when both are present.
 * Read-only actions whose `payload.text` is a one-line "No orders /
 * positions / fills found." swallowed the structured rows that
 * downstream renderers needed to surface per-scope detail; the result
 * was three identical `get_orders` collapsed `<details>` blocks when
 * the user asked for "check orders, spot and margin". The structured
 * tables (`formatOrdersTable`, etc.) are now the default and the
 * short text falls back when no rows exist.
 */
export function renderStepResultBlock(step: CexPlanStep): string | null {
    // Failed steps surface their error in the Notes column; no <details>.
    if (step.status === "failed") return null;
    if (step.status !== "ok") return null;
    const payload = step.result?.payload;
    if (!isPayloadShape(payload)) return null;

    // Commit 5 — prefer structured rows when present. Falls back to
    // `payload.text` for actions without structured rows (e.g.
    // get_ticker price summaries) and finally to an explicit
    // "(no rows)" sentinel so the user can see which scopes returned
    // empty results.
    let body: string | null = renderPayloadDeterministic(step.action, payload);
    if (!body && typeof payload.text === "string" && payload.text.trim().length > 0) {
        body = payload.text.trim();
    }
    if (!body) {
        body = renderEmptyScopeFallback(step.action, payload);
    }
    if (!body) return null;

    const summary = buildBlockSummary(step, payload);
    const block = `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
    return truncateBlockLines(block, STEP_RESULT_BLOCK_MAX_LINES);
}

/**
 * CEX post-PR237 Commit 5 (Issue 6) — When a read-only action returns
 * zero structured rows, emit an explicit "No <thing> found" line so
 * the user can distinguish "we executed and there's nothing" from
 * "we forgot to execute". Per-scope (spot / cross-margin / isolated)
 * variants surfaced via `buildBlockSummary` give it the right label.
 */
function renderEmptyScopeFallback(
    action: string,
    payload: StepResultPayloadShape,
): string | null {
    if (
        (action === "get_orders" ||
            action === "get_open_orders" ||
            action === "get_order_history") &&
        Array.isArray(payload.orders) &&
        payload.orders.length === 0
    ) {
        return "_No orders in this scope._";
    }
    if (
        action === "get_fills" &&
        Array.isArray(payload.fills) &&
        payload.fills.length === 0
    ) {
        return "_No fills in this scope._";
    }
    if (
        (action === "get_position" || action === "get_positions") &&
        Array.isArray(payload.positions) &&
        payload.positions.length === 0
    ) {
        return "_No open positions in this scope._";
    }
    if (
        (action === "get_balance" || action === "get_account") &&
        Array.isArray(payload.accounts) &&
        payload.accounts.length === 0
    ) {
        return "_No balances in this scope._";
    }
    return null;
}

/**
 * Build the `<summary>` text for the step's `<details>` block.
 *
 * CEX post-PR237 Commit 5 (Issue 6) — Append the step's most
 * discriminating parameter (wallet_type, margin_mode, scope, side,
 * product_id) so a multi-scope plan ("check orders, spot and
 * margin") renders three visually distinct rows instead of three
 * collapsed copies of "get_orders".
 */
function buildBlockSummary(step: CexPlanStep, payload: StepResultPayloadShape): string {
    const scanned = Array.isArray(payload.scanned_symbols)
        ? payload.scanned_symbols.filter((s): s is string => typeof s === "string")
        : [];
    const params = step.parameters ?? {};
    const scopeBits: string[] = [];

    const walletType =
        typeof params.wallet_type === "string"
            ? params.wallet_type
            : typeof (payload as Record<string, unknown>).wallet_type === "string"
              ? ((payload as Record<string, unknown>).wallet_type as string)
              : undefined;
    if (walletType) scopeBits.push(`wallet=${walletType}`);

    const marginMode =
        typeof params.margin_mode === "string"
            ? params.margin_mode
            : typeof (payload as Record<string, unknown>).margin_mode === "string"
              ? ((payload as Record<string, unknown>).margin_mode as string)
              : undefined;
    if (marginMode) scopeBits.push(`margin=${marginMode}`);

    const productId =
        typeof params.product_id === "string" ? params.product_id : undefined;
    if (productId) scopeBits.push(productId);

    const venue = step.venue ?? undefined;
    if (venue && !scopeBits.some((b) => b.includes(venue))) {
        scopeBits.unshift(venue);
    }

    const scopeSuffix = scopeBits.length > 0 ? ` (${scopeBits.join(", ")})` : "";
    const scannedSuffix = scanned.length > 0 ? ` — ${scanned.join(", ")}` : "";
    return `${step.action}${scopeSuffix}${scannedSuffix}`;
}

/**
 * Truncate the block to at most `maxLines` lines (counting newlines).
 * The closing `</details>` tag is preserved so the markdown stays
 * well-formed even after truncation.
 */
function truncateBlockLines(block: string, maxLines: number): string {
    const lines = block.split("\n");
    if (lines.length <= maxLines) return block;
    // Reserve the last three slots for: truncation marker, blank line,
    // closing `</details>`. Total kept = maxLines lines.
    const head = lines.slice(0, maxLines - 3);
    head.push(STEP_RESULT_TRUNCATION_MARKER);
    head.push("");
    head.push("</details>");
    return head.join("\n");
}

/**
 * Deterministic fallback formatter for the rare case where the action
 * callback didn't include a pre-rendered `text` field but did surface
 * structured rows. Keeps the renderer fully pure — no runtime / LLM
 * dependency.
 */
function renderPayloadDeterministic(
    action: string,
    payload: StepResultPayloadShape,
): string | null {
    if (action === "get_balance" || action === "get_account") {
        if (Array.isArray(payload.accounts) && payload.accounts.length > 0) {
            return formatBalanceTable(
                payload.accounts as Record<string, unknown>[],
                typeof payload.estimated_total_usdt === "number"
                    ? payload.estimated_total_usdt
                    : null,
            );
        }
    }
    if (action === "get_orders" || action === "get_open_orders" || action === "get_order_history") {
        if (Array.isArray(payload.orders) && payload.orders.length > 0) {
            return formatOrdersTable(payload.orders as Record<string, unknown>[]);
        }
    }
    if (action === "get_fills") {
        if (Array.isArray(payload.fills) && payload.fills.length > 0) {
            return formatFillsTable(payload.fills as Record<string, unknown>[]);
        }
    }
    if (action === "get_position" || action === "get_positions") {
        if (Array.isArray(payload.positions) && payload.positions.length > 0) {
            return formatPositionsTable(payload.positions as Record<string, unknown>[]);
        }
    }
    return null;
}

function cell(value: unknown): string {
    if (value === undefined || value === null) return "—";
    if (typeof value === "string") return value.replace(/\|/g, "\\|");
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value).replace(/\|/g, "\\|");
    } catch {
        return "—";
    }
}

function formatBalanceTable(
    accounts: Record<string, unknown>[],
    estimatedTotalUsdt: number | null,
): string {
    const rows: string[] = [];
    rows.push("| Asset | Free | Locked | Est. USDT |");
    rows.push("|-------|------|--------|-----------|");
    for (const a of accounts) {
        rows.push(
            `| ${cell(a.asset ?? a.currency)} | ${cell(a.free ?? a.available)} | ${cell(a.locked ?? a.hold)} | ${cell(a.estimated_usdt)} |`,
        );
    }
    if (estimatedTotalUsdt !== null && Number.isFinite(estimatedTotalUsdt)) {
        rows.push("");
        rows.push(`**Est. Total Value:** ${estimatedTotalUsdt.toFixed(2)} USDT`);
    }
    return rows.join("\n");
}

function formatOrdersTable(orders: Record<string, unknown>[]): string {
    const rows: string[] = [];
    const hasClientOrderId = orders.some(
        (o) =>
            (typeof o.client_order_id === "string" && o.client_order_id.length > 0) ||
            (typeof o.clientOrderId === "string" && o.clientOrderId.length > 0),
    );
    if (hasClientOrderId) {
        rows.push(
            "| Order ID | Client Order ID | Symbol | Side | Type | Price | Quantity | Status |",
        );
        rows.push(
            "|----------|-----------------|--------|------|------|-------|----------|--------|",
        );
        for (const o of orders) {
            const clientId = o.client_order_id ?? o.clientOrderId ?? "";
            rows.push(
                `| ${cell(o.order_id ?? o.orderId ?? o.id)} | ${cell(clientId)} | ${cell(o.symbol)} | ${cell(o.side)} | ${cell(o.type)} | ${cell(o.price)} | ${cell(o.quantity ?? o.origQty)} | ${cell(o.status)} |`,
            );
        }
    } else {
        rows.push("| Order ID | Symbol | Side | Type | Price | Quantity | Status |");
        rows.push("|----------|--------|------|------|-------|----------|--------|");
        for (const o of orders) {
            rows.push(
                `| ${cell(o.order_id ?? o.orderId ?? o.id)} | ${cell(o.symbol)} | ${cell(o.side)} | ${cell(o.type)} | ${cell(o.price)} | ${cell(o.quantity ?? o.origQty)} | ${cell(o.status)} |`,
            );
        }
    }
    return rows.join("\n");
}

function formatFillsTable(fills: Record<string, unknown>[]): string {
    const rows: string[] = [];
    rows.push("| Trade ID | Symbol | Side | Price | Quantity | Fee | Time |");
    rows.push("|----------|--------|------|-------|----------|-----|------|");
    for (const f of fills) {
        rows.push(
            `| ${cell(f.trade_id ?? f.tradeId ?? f.id)} | ${cell(f.symbol)} | ${cell(f.side)} | ${cell(f.price)} | ${cell(f.quantity ?? f.qty)} | ${cell(f.fee ?? f.commission)} | ${cell(f.time ?? f.timestamp)} |`,
        );
    }
    return rows.join("\n");
}

function formatPositionsTable(positions: Record<string, unknown>[]): string {
    const rows: string[] = [];
    rows.push("| Symbol | Side | Quantity | Entry | Mark | PnL |");
    rows.push("|--------|------|----------|-------|------|-----|");
    for (const p of positions) {
        rows.push(
            `| ${cell(p.symbol)} | ${cell(p.side ?? p.positionSide)} | ${cell(p.quantity ?? p.positionAmt)} | ${cell(p.entry_price ?? p.entryPrice)} | ${cell(p.mark_price ?? p.markPrice)} | ${cell(p.pnl ?? p.unRealizedProfit)} |`,
        );
    }
    return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Plan card
// ---------------------------------------------------------------------------

export interface RenderPlanCardOptions {
    include_next_prompt?: boolean;
    /**
     * When true, inline a `<details>` block under each `ok` step row
     * carrying the deterministic action result (per Fix 3). When
     * undefined, defaults to true on terminal states (`completed` /
     * `failed`) and false otherwise so the mid-flight card stays
     * compact.
     */
    include_results?: boolean;
}

export function renderPlanCard(
    plan: CexPlan,
    opts: RenderPlanCardOptions = {},
): string {
    const includeResults =
        opts.include_results ?? (plan.status === "completed" || plan.status === "failed");

    const lines: string[] = [];
    lines.push(`**Plan**: ${plan.summary}`);
    lines.push(`**Mode**: ${plan.approval_mode}`);
    lines.push(`**Status**: ${plan.status}`);
    lines.push("");
    lines.push("| # | Status | Action | Venue | Notes |");
    lines.push("|---|--------|--------|-------|-------|");

    // The plan card mixes a table row with optional per-step <details>
    // blocks. Some markdown renderers refuse to start a `<details>`
    // block in the middle of a table; we render all rows first, then
    // append blocks below the table.
    const resultBlocks: string[] = [];
    for (const step of plan.steps) {
        const icon = STATUS_ICONS[step.status] ?? "·";
        const action = step.action;
        const venue = step.venue ?? "—";
        const notes =
            step.status === "failed" && step.result?.error
                ? step.result.error.slice(0, 80)
                : step.description?.slice(0, 80) ?? "";
        lines.push(`| ${step.id} | ${icon} ${step.status} | ${action} | ${venue} | ${notes.replace(/\|/g, "\\|")} |`);

        if (includeResults) {
            const block = renderStepResultBlock(step);
            if (block) resultBlocks.push(block);
        }
    }

    if (resultBlocks.length > 0) {
        lines.push("");
        for (const block of resultBlocks) {
            lines.push(block);
            lines.push("");
        }
    }

    if (opts.include_next_prompt && plan.status === "awaiting_approval") {
        const remaining = plan.steps.filter((s) => s.status === "pending").length;
        lines.push("");
        lines.push(
            remaining > 1
                ? `Reply \`yes\` to approve the next step, \`yes, all\` to batch-approve the remaining ${remaining}, or \`cancel\` to stop.`
                : `Reply \`yes\` to approve the final step, or \`cancel\` to stop.`,
        );
    }
    return lines.join("\n");
}
