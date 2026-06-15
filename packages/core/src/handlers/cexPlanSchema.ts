/**
 * CEX Plan Executor — types and zod schemas.
 *
 * A *plan* is the structured representation of a user request that may
 * decompose into multiple atomic CEX operations. The decomposer LLM emits
 * a plan; the executor walks it according to a strategy (parallel reads,
 * sequential writes with approval); the continuation parser maps the
 * user's next-turn reply ("yes" / "yes, all" / "cancel" / "place 2") back
 * onto plan commands.
 *
 * Architecture notes:
 *   - 1-step plans are the degenerate single-action case and preserve
 *     legacy behavior. The decomposer ALWAYS emits a plan, even for a
 *     bare "buy 0.01 BTC at market".
 *   - Approval defaults to STEP_BY_STEP. The user can opt into BATCH
 *     by replying "yes, all" / "approve all" — a deliberate two-touch
 *     contract for safety.
 *   - On mid-plan step failure the executor BAILS by default. Remaining
 *     steps are marked `skipped`; the plan moves to `failed`. This
 *     matches the user's choice in the design discussion.
 *   - Plans persist between turns (15-min TTL) so the continuation
 *     ("yes please") can resume from `cursor`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Step-level types
// ---------------------------------------------------------------------------

/**
 * Stake of a single step. Mirrors the runtime's existing read/write
 * classification but is denormalized here so the executor doesn't need
 * to re-resolve the action's stake on every iteration.
 */
export type CexPlanStepStake = "read" | "write";

export type CexPlanStepStatus =
    | "pending"      // not yet executed
    | "in_progress" // currently executing (parallel reads or active write)
    | "ok"           // execution succeeded
    | "failed"       // execution failed
    | "skipped";    // executor bailed before reaching this step

/**
 * One atomic operation inside a plan. The decomposer LLM is responsible
 * for filling in `action`, `venue`, and `parameters`; the executor
 * derives `stake` and `requires_approval` from the action name via the
 * existing `classifyStake` / `intentClassForAction` predicates.
 */
export interface CexPlanStep {
    /**
     * Stable id within the plan. The decomposer assigns "1", "2", "3"
     * etc.; the executor uses these to resolve continuation references
     * ("place 2") and to record results.
     */
    id: string;
    /** Action name, e.g. "create_order" / "get_balance" / "cancel_order". */
    action: string;
    /** Venue, e.g. "binance" / "coinbase". May be null pre-resolution. */
    venue: string | null;
    /** Canonical action parameters as parsed by the LLM. */
    parameters: Record<string, unknown>;
    /**
     * Step ids this step depends on. Empty for independent steps;
     * non-empty when a read needs to land before a write (e.g. balance
     * lookup feeds a buy sizing). Forms a DAG; cycles are rejected.
     */
    depends_on: string[];
    /**
     * Stake classification, denormalized from the action name.
     * Read-only actions never trigger approval modals.
     */
    stake: CexPlanStepStake;
    /**
     * True when execution requires the user to approve via the existing
     * CEXApprovalDialog modal. All writes require approval; reads do
     * not. Derivation lives in `cexPlanExecutor.ts`.
     */
    requires_approval: boolean;
    /** Current status; updated as the executor walks the plan. */
    status: CexPlanStepStatus;
    /** Free-form description from the decomposer, shown in the in-chat plan card. */
    description?: string;
    /** Populated post-execution. */
    result?: {
        payload?: unknown;
        error?: string;
        completed_at: number;
    };
}

// ---------------------------------------------------------------------------
// Plan-level types
// ---------------------------------------------------------------------------

export type CexPlanApprovalMode = "step_by_step" | "batch";

export type CexPlanStatus =
    | "draft"               // emitted by the decomposer, not yet executed
    | "awaiting_approval"  // paused waiting for user confirmation (next write)
    | "executing"           // actively running (transient; rare to observe)
    | "completed"           // all steps reached terminal status, plan ok
    | "failed"              // a step failed and the executor bailed
    | "cancelled"          // user cancelled via continuation parser
    | "expired";           // TTL elapsed before completion

export interface CexPlan {
    /** UUID. */
    id: string;
    user_id: string;
    /**
     * Room id used by the continuation lookup. One active plan per
     * (user_id, room_id) — a fresh decomposer call cancels the prior
     * plan with an explicit user-visible note.
     */
    room_id: string;
    steps: CexPlanStep[];
    /**
     * Step-by-step is the default (safer). The user opts into batch by
     * replying "yes, all" / "approve all" / "batch" — at which point
     * the executor flips this to "batch" and runs remaining writes
     * without additional modals.
     */
    approval_mode: CexPlanApprovalMode;
    /** State-machine status; observable in CloudWatch via `[CexPlan]` log lines. */
    status: CexPlanStatus;
    /**
     * Index of the next step to execute (0-based). Advances as steps
     * complete; remains pinned at the failing step's index on bail.
     */
    cursor: number;
    /** Free-form one-line summary from the decomposer, e.g. "Place 2 limit buys on Binance". */
    summary: string;
    /** Millis since epoch. */
    created_at: number;
    /** TTL boundary; the store sweeps plans past this point. */
    expires_at: number;
    /**
     * Original user message that triggered the decomposer. Logged
     * verbatim for forensic value when a plan misbehaves.
     */
    source_message: string;
    /**
     * Count of CONSECUTIVE unrecognized continuation replies. A single
     * off-template reply re-prompts and preserves the plan (non-
     * destructive); the second consecutive one cancels (genuine topic
     * shift). Reset to 0 on any recognized command. Undefined ⇒ 0.
     */
    clarify_nudges?: number;
}

// ---------------------------------------------------------------------------
// Zod schemas — decomposer LLM output
// ---------------------------------------------------------------------------

/**
 * What the LLM emits. Looser than the runtime `CexPlanStep` (no
 * `status` / `stake` / `requires_approval` — those are derived by the
 * executor). Kept tight on the required fields so we fail-fast on
 * malformed output.
 */
export const CexPlanStepDecomposedSchema = z.object({
    id: z.string().min(1),
    action: z.string().min(1),
    venue: z.string().min(1).nullable().optional(),
    parameters: z.record(z.unknown()),
    depends_on: z.array(z.string()).default([]),
    description: z.string().optional(),
});

export type CexPlanStepDecomposed = z.infer<typeof CexPlanStepDecomposedSchema>;

export const CexPlanDecomposedSchema = z.object({
    /**
     * 1..N steps. We cap at 12 here as a defensive guard — the executor
     * could handle more but a 13-step request is almost always a
     * misclassification and we'd rather show a friendly "split this
     * into a couple of plans" error than execute 30 writes.
     */
    steps: z.array(CexPlanStepDecomposedSchema).min(1).max(12),
    /** One-liner shown in the in-chat plan card. */
    summary: z.string().min(1),
    /**
     * Optional clarification. When the decomposer cannot map the
     * request to any of the available CEX actions, it returns one
     * special step with `action: "clarify"` and a question. The
     * executor surfaces that question to the user verbatim and
     * does NOT persist the plan.
     */
    requires_clarification: z.boolean().default(false),
    // `nullable().optional()` — observed in production: Gemini 2.5 Flash
    // emits explicit `null` rather than omitting the field when no
    // clarification is needed. Without `.nullable()`, every multi-step
    // decomposition fails schema validation here. Repro on staging
    // 2026-05-21: a 2-step plan validated everything else correctly
    // but failed on `"clarification_question": null`.
    clarification_question: z.string().nullable().optional(),
});

export type CexPlanDecomposed = z.infer<typeof CexPlanDecomposedSchema>;

/**
 * Read-only action names — denormalized here so the executor can derive
 * `stake` without depending on the heavier `classifyStake` helper.
 * Kept in sync with `cexWorkflowStakeClassifier.ts:READ_ONLY_ACTIONS`.
 */
export const READ_ONLY_ACTIONS = new Set<string>([
    "get_balance",
    "get_orders",
    "get_fills",
    "get_account",
    "get_open_orders",
    "get_order_history",
    "get_position",
    "get_positions",
    "get_funding_balance",
    "get_ticker",
    "get_price",
    "get_trading_mode",
    // Fix 8 — read-only view of user's asset allowlist / blocklist.
    "list_asset_lists",
    // Fix 13 — realized + unrealized PnL across futures / margin wallets.
    "get_pnl",
    // Fix 15 — instant order-book lookup (public Binance endpoint).
    // `get_ticker` is already in the set above (added pre-Fix 15 as a
    // forward-looking entry).
    "get_orderbook",
    // Strategy actions: compiling + backtesting move no money (read-only
    // analysis); list_strategies is a status read. arm/pause/resume/stop are
    // writes (arm is the auto-execution gate) and stay out of this set.
    "compile_strategy",
    "run_backtest",
    "list_strategies",
]);

export function deriveStake(action: string): CexPlanStepStake {
    return READ_ONLY_ACTIONS.has(action) ? "read" : "write";
}

/**
 * Special action name reserved for the decomposer to signal it needs
 * a clarification from the user before any execution. The executor
 * never invokes a real venue for this step — it just relays the
 * `parameters.question` string.
 */
export const CLARIFY_ACTION = "clarify";
