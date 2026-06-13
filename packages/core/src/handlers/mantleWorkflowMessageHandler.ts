/**
 * Mantle on-chain swap workflow — thin handler mirroring CEX approval pattern.
 * Two-turn confirm: quote + risk summary, then approve/cancel on next message.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { v4 as uuidv4 } from "uuid";
import type {
    HandlerCallback,
    IAgentRuntime,
    Memory,
    StreamingCallback,
    UUID,
} from "../core/types.ts";
import { elizaLogger } from "../utils/logger.ts";
import { getMantleActions } from "../utils/pluginFilter.ts";
import { attachResponseSummary } from "../utils/persistResponseSummary.ts";
import { stringToUuid } from "../utils/uuid.ts";
import {
    setDecisionOutcome,
    spanFromProcessingStep,
    withSpan,
} from "../utils/tracing.ts";

const PENDING_TTL_MS = 15 * 60 * 1000;

const ANALYSIS_THEN_SWAP_RE =
    /\b(?:analy(?:z|s)e|analysis|sentiment|research)\b.*\b(?:swap|exchange|convert)\b|\b(?:swap|exchange|convert)\b.*\b(?:after|then)\b.*\b(?:analy(?:z|s)e|analysis)\b/i;

interface PendingMantleSwap {
    intentHash: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: string;
    amountInHuman: string;
    maxSlippageBps: number;
    chainId: number;
    quote: Record<string, unknown>;
    riskScore: number;
    createdAt: number;
    userId: UUID;
    roomId: UUID;
}

const pendingByRoomUser = new Map<string, PendingMantleSwap>();

type MantlePluginExports = typeof import("@elizaos-plugins/plugin-mantle-dex");

let mantlePluginCache: MantlePluginExports | null = null;

async function loadMantlePlugin(): Promise<MantlePluginExports> {
    if (!mantlePluginCache) {
        try {
            mantlePluginCache = await import("@elizaos-plugins/plugin-mantle-dex");
        } catch (primaryError) {
            const here = dirname(fileURLToPath(import.meta.url));
            const candidates = [
                join(here, "../../plugin-mantle-dex/dist/index.js"),
                join(here, "../../../plugin-mantle-dex/dist/index.js"),
                join(
                    here,
                    "../../../agent/node_modules/@elizaos-plugins/plugin-mantle-dex/dist/index.js",
                ),
            ];
            let loaded: MantlePluginExports | null = null;
            for (const candidate of candidates) {
                try {
                    loaded = (await import(
                        pathToFileURL(candidate).href
                    )) as MantlePluginExports;
                    break;
                } catch {
                    continue;
                }
            }
            if (!loaded) {
                const hint =
                    primaryError instanceof Error
                        ? primaryError.message
                        : String(primaryError);
                throw new Error(
                    `Cannot load @elizaos-plugins/plugin-mantle-dex (${hint}). ` +
                        "Ensure the plugin is built and linked in the agent workspace.",
                );
            }
            mantlePluginCache = loaded;
        }
    }
    return mantlePluginCache;
}

function pendingKey(roomId: UUID, userId: UUID): string {
    return `${roomId}:${userId}`;
}

function pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of pendingByRoomUser) {
        if (now - entry.createdAt > PENDING_TTL_MS) {
            pendingByRoomUser.delete(key);
        }
    }
}

export interface MantleActionResult {
    text: string;
    content?: Record<string, unknown>;
    /**
     * Top-level action-response metadata (from createActionResponse /
     * createActionErrorResponse). Carries `success: false` + `error` on the
     * failure path — the authoritative success/failure discriminator the
     * workflow uses so a failed action can't be rendered as executed.
     */
    metadata?: Record<string, unknown>;
}

async function invokeAction(
    runtime: IAgentRuntime,
    actionName: string,
    message: Memory,
    options: Record<string, unknown>,
): Promise<MantleActionResult> {
    const actions = getMantleActions(runtime);
    const action = actions.find((a) => a.name === actionName);
    if (!action) {
        throw new Error(`Mantle action not found: ${actionName}`);
    }

    let captured: MantleActionResult = {
        text: "",
    };

    await action.handler(
        runtime,
        message,
        await runtime.composeState(message),
        options,
        async (response) => {
            const text =
                (typeof response.text === "string" ? response.text : null) ??
                response.content?.text ??
                "";
            captured = {
                text: typeof text === "string" ? text : String(text),
                content: response.content as Record<string, unknown>,
                metadata: (response as { metadata?: Record<string, unknown> })
                    .metadata,
            };
            return [];
        },
    );

    return captured;
}

/**
 * Returns true when an action result signals failure. A Mantle action that
 * fails calls its error callback (createActionErrorResponse → success:false,
 * no content/txHash) and returns instead of throwing, so the workflow must
 * inspect the result here rather than rely on a thrown exception.
 */
function actionFailed(result: MantleActionResult): boolean {
    return result.metadata?.success === false;
}

function actionErrorMessage(result: MantleActionResult, fallback: string): string {
    const err = result.metadata?.error as { message?: string } | undefined;
    return err?.message || result.text || fallback;
}

/**
 * Execute an approved Mantle swap. Pure orchestration over an injected action
 * invoker so the ordering + failure contract is unit-testable without a live
 * chain or the dynamically-imported plugin.
 *
 * Contract (fixes R2 + R3 from the plan-execution review):
 *  - The swap is submitted FIRST; the on-chain audit intent is logged only
 *    AFTER a confirmed swap (R3) — a failed swap leaves no dangling intent.
 *  - A failed swap (error response, or a response with no txHash) yields
 *    `ok: false` so the caller renders a failure, never an "executed" badge (R2).
 *  - Audit-log failure is non-fatal: the swap already settled on-chain, so the
 *    swap success stays authoritative; the audit gap is only logged.
 */
export async function executeApprovedMantleSwap(
    pending: PendingMantleSwap,
    invoke: (
        actionName: string,
        options: Record<string, unknown>,
    ) => Promise<MantleActionResult>,
    deps?: { logger?: { warn: (msg: string) => void } },
): Promise<{
    ok: boolean;
    text: string;
    swapPayload: Record<string, unknown>;
    auditPayload: Record<string, unknown>;
    errorMessage?: string;
    actionOrder: string[];
}> {
    const actionOrder: string[] = [];

    // 1. Submit the swap first.
    actionOrder.push("execute_mantle_swap");
    const swap = await invoke("execute_mantle_swap", {
        tokenIn: pending.tokenIn,
        tokenOut: pending.tokenOut,
        amountIn: pending.amountIn,
        maxSlippageBps: pending.maxSlippageBps,
        chainId: pending.chainId,
        intentHash: pending.intentHash,
    });

    const swapPayload = (swap.content ?? {}) as Record<string, unknown>;
    const txHash = swapPayload.txHash;
    const swapSucceeded =
        !actionFailed(swap) && typeof txHash === "string" && txHash.length > 0;

    if (!swapSucceeded) {
        // R2: a failed swap must NOT render as executed / badged.
        const errorMessage = actionErrorMessage(
            swap,
            "Mantle swap did not return a transaction hash",
        );
        return {
            ok: false,
            text: errorMessage,
            swapPayload,
            auditPayload: {},
            errorMessage,
            actionOrder,
        };
    }

    // 2. Swap confirmed — now write the on-chain audit intent (R3). Audit
    //    failure is non-fatal: the swap already happened on-chain.
    let auditPayload: Record<string, unknown> = {};
    try {
        actionOrder.push("log_mantle_intent");
        const audit = await invoke("log_mantle_intent", {
            intentHash: pending.intentHash,
            tokenIn: pending.tokenIn,
            tokenOut: pending.tokenOut,
            amountIn: pending.amountIn,
            maxSlippageBps: pending.maxSlippageBps,
            riskScore: pending.riskScore,
            action: "swap",
        });
        if (actionFailed(audit)) {
            throw new Error(actionErrorMessage(audit, "log_mantle_intent failed"));
        }
        auditPayload = (audit.content ?? {}) as Record<string, unknown>;
    } catch (auditErr) {
        const m = auditErr instanceof Error ? auditErr.message : String(auditErr);
        deps?.logger?.warn(
            `[Mantle] audit intent log failed after swap settled (non-fatal): ${m}`,
        );
    }

    return {
        ok: true,
        text: swap.text,
        swapPayload,
        auditPayload,
        actionOrder,
    };
}

function mantleOutcome(
    phase: "quoted" | "risk_block" | "awaiting_approval" | "executed" | "cancelled" | "failed",
): void {
    const map: Record<string, string> = {
        quoted: "allow",
        risk_block: "risk_block",
        awaiting_approval: "awaiting_approval",
        executed: "executed",
        cancelled: "refused",
        failed: "failed",
    };
    setDecisionOutcome(map[phase] ?? phase);
}

export async function handleMantleWorkflowMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    streamingCallback?: StreamingCallback,
    _intermediateResponseCallback?: (response: Memory) => void,
    _onToken?: (delta: string) => void | Promise<void>,
): Promise<Memory[]> {
    return withSpan(
        "mantle.workflow",
        { "mantle.room_id": message.roomId, "mantle.user_id": message.userId },
        async () => {
            const mantle = await loadMantlePlugin();
            const {
                computeIntentHash,
                evaluateMantleRisk,
                getDefaultChainId,
                isApprovalMessage,
                isBalanceQuery,
                parseAmountToBaseUnits,
                parseSwapIntentFromText,
                resolveTokenSymbol,
            } = mantle;

            pruneExpired();

            const text = (message.content?.text ?? "").trim();
            const userId = message.userId;
            const roomId = message.roomId;
            const key = pendingKey(roomId, userId);

            const emitStep = (
                name: string,
                status: "in_progress" | "completed" | "error",
                stepMessage: string,
            ) => {
                const step = {
                    id: uuidv4(),
                    name,
                    status,
                    message: stepMessage,
                    timestamp: Date.now(),
                };
                streamingCallback?.(step);
                spanFromProcessingStep(step);
            };

            const chainId = getDefaultChainId();
            const approval = isApprovalMessage(text);
            const pending = pendingByRoomUser.get(key);

            if (approval && !pending) {
                const responseText =
                    approval === "cancel"
                        ? "No pending Mantle swap to cancel."
                        : "No pending Mantle swap to approve. Request a quote first (e.g. `swap 5 USDC to WMNT on Mantle`).";
                const memory = buildResponseMemory(runtime, message, responseText, {
                    chainId,
                    noPending: true,
                });
                return persistAndReturn(runtime, memory, callback);
            }

            if (approval && pending) {
                pendingByRoomUser.delete(key);

                if (approval === "cancel") {
                    mantleOutcome("cancelled");
                    const responseText =
                        "**Mantle swap cancelled** — no transaction was submitted.";
                    const memory = buildResponseMemory(
                        runtime,
                        message,
                        responseText,
                        { cancelled: true, chainId },
                    );
                    return persistAndReturn(runtime, memory, callback);
                }

                emitStep(
                    "mantle_execute",
                    "in_progress",
                    "Executing approved Mantle swap…",
                );

                try {
                    const swapResult = await executeApprovedMantleSwap(
                        pending,
                        (actionName, opts) =>
                            invokeAction(runtime, actionName, message, opts),
                        { logger: elizaLogger },
                    );

                    if (!swapResult.ok) {
                        // R2: a failed swap is reported as a failure, never
                        // rendered as executed with the on-chain badge.
                        const failMsg =
                            swapResult.errorMessage ?? "Mantle swap failed";
                        emitStep("mantle_execute", "error", failMsg);
                        mantleOutcome("failed");
                        const memory = buildResponseMemory(
                            runtime,
                            message,
                            `**Mantle swap failed:** ${failMsg}`,
                            { error: failMsg, chainId },
                        );
                        return persistAndReturn(runtime, memory, callback);
                    }

                    emitStep(
                        "mantle_execute",
                        "completed",
                        "Mantle swap confirmed on-chain.",
                    );
                    mantleOutcome("executed");

                    const badge =
                        "\n\n> **Mode:** Mantle on-chain (0x aggregation) — not CEX paper trading.";
                    const responseText = `${swapResult.text}${badge}`;
                    const memory = buildResponseMemory(
                        runtime,
                        message,
                        responseText,
                        {
                            ...swapResult.swapPayload,
                            intentHash: pending.intentHash,
                            auditTxHash: swapResult.auditPayload.auditTxHash,
                            chainId: pending.chainId,
                            mantleExecution: true,
                        },
                    );
                    attachResponseSummary(memory, "Mantle swap executed");
                    return persistAndReturn(runtime, memory, callback);
                } catch (error) {
                    const msg =
                        error instanceof Error ? error.message : String(error);
                    emitStep("mantle_execute", "error", msg);
                    mantleOutcome("failed");
                    const memory = buildResponseMemory(
                        runtime,
                        message,
                        `**Mantle swap failed:** ${msg}`,
                        { error: msg, chainId },
                    );
                    return persistAndReturn(runtime, memory, callback);
                }
            }

            const intent = parseSwapIntentFromText(text);

            if (isBalanceQuery(text) && !intent) {
                emitStep(
                    "mantle_balance",
                    "in_progress",
                    "Fetching Mantle wallet balance…",
                );
                const result = await invokeAction(
                    runtime,
                    "get_mantle_balance",
                    message,
                    {},
                );
                emitStep("mantle_balance", "completed", "Balance ready.");
                const memory = buildResponseMemory(
                    runtime,
                    message,
                    result.text,
                    { ...(result.content ?? {}), chainId },
                );
                return persistAndReturn(runtime, memory, callback);
            }

            if (!intent) {
                const helpText = [
                    "**Mantle DEX** — I can quote and execute swaps on Mantle via 0x.",
                    "",
                    "Try: `swap 5 USDC to WMNT on Mantle`",
                    "Or: `show my Mantle wallet balance`",
                    "",
                    "> Risk gate + approval required before any on-chain execution.",
                ].join("\n");
                const memory = buildResponseMemory(
                    runtime,
                    message,
                    helpText,
                    { chainId },
                );
                return persistAndReturn(runtime, memory, callback);
            }

            const tokenIn = resolveTokenSymbol(intent.tokenInSymbol, chainId);
            const tokenOut = resolveTokenSymbol(intent.tokenOutSymbol, chainId);
            if (!tokenIn || !tokenOut) {
                const unknown = !tokenIn ? intent.tokenInSymbol : intent.tokenOutSymbol;
                const refusal = [
                    "**Mantle swap refused** (risk gate)",
                    "",
                    `- Token **${unknown}** is not on the Mantle demo allowlist.`,
                    "",
                    "> Demo caps apply. CEX paper mode remains available for strategy rehearsal.",
                ].join("\n");
                const memory = buildResponseMemory(runtime, message, refusal, {
                    chainId,
                    risk: {
                        verdict: "refuse",
                        rulesFired: ["token_allowlist"],
                        explanations: [
                            `Token ${unknown} is not on the Mantle demo allowlist.`,
                        ],
                    },
                });
                return persistAndReturn(runtime, memory, callback);
            }

            const maxSlippageBps = intent.maxSlippageBps ?? 100;

            const preQuoteRisk = evaluateMantleRisk({
                chainId,
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountInHuman: intent.amountIn,
                tokenInSymbol: intent.tokenInSymbol,
                requestedSlippageBps: maxSlippageBps,
            });
            if (preQuoteRisk.verdict === "refuse") {
                emitStep("mantle_risk", "error", "Risk gate refused swap.");
                mantleOutcome("risk_block");
                const refusal = [
                    "**Mantle swap refused** (risk gate)",
                    "",
                    ...preQuoteRisk.explanations.map((e) => `- ${e}`),
                    "",
                    "> Demo caps apply. CEX paper mode remains available for strategy rehearsal.",
                ].join("\n");
                const memory = buildResponseMemory(runtime, message, refusal, {
                    risk: preQuoteRisk,
                    chainId,
                });
                return persistAndReturn(runtime, memory, callback);
            }

            const amountIn = parseAmountToBaseUnits(
                intent.amountIn,
                tokenIn.decimals,
            );

            emitStep(
                "mantle_quote",
                "in_progress",
                "Fetching 0x swap quote on Mantle…",
            );

            const quoteResult = await invokeAction(
                runtime,
                "get_mantle_swap_quote",
                message,
                {
                    tokenIn: tokenIn.address,
                    tokenOut: tokenOut.address,
                    amountIn,
                    maxSlippageBps,
                    chainId,
                },
            );

            mantleOutcome("quoted");

            const risk = evaluateMantleRisk({
                chainId,
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountInHuman: intent.amountIn,
                tokenInSymbol: intent.tokenInSymbol,
                quote: quoteResult.content as never,
                requestedSlippageBps: maxSlippageBps,
            });

            if (risk.verdict === "refuse") {
                emitStep("mantle_risk", "error", "Risk gate refused swap.");
                mantleOutcome("risk_block");
                const refusal = [
                    "**Mantle swap refused** (risk gate)",
                    "",
                    ...risk.explanations.map((e) => `- ${e}`),
                    "",
                    "> Demo caps apply. CEX paper mode remains available for strategy rehearsal.",
                ].join("\n");
                const memory = buildResponseMemory(runtime, message, refusal, {
                    risk,
                    chainId,
                });
                return persistAndReturn(runtime, memory, callback);
            }

            const intentHash = computeIntentHash({
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountIn,
                maxSlippageBps,
                chainId,
                userId,
            });

            pendingByRoomUser.set(key, {
                intentHash,
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountIn,
                amountInHuman: intent.amountIn,
                maxSlippageBps,
                chainId,
                quote: quoteResult.content ?? {},
                riskScore: risk.riskScore,
                createdAt: Date.now(),
                userId,
                roomId,
            });

            emitStep("mantle_quote", "completed", "Quote ready — awaiting approval.");
            mantleOutcome("awaiting_approval");

            const analysisNote = ANALYSIS_THEN_SWAP_RE.test(text)
                ? "\n\n> **Analysis:** For richer context, run sentiment/TA in a prior turn; execution still requires your `approve`."
                : "";

            const approvalPrompt = [
                quoteResult.text,
                "",
                "**Risk summary:** passed demo checks.",
                `Intent hash: \`${intentHash}\``,
                "",
                "Reply **`approve`** to execute on Mantle, or **`cancel`** to abort.",
                "",
                "> **Disclosure:** Server demo wallet signs this swap (MVP). Explorer link follows execution.",
                analysisNote,
            ].join("\n");

            const memory = buildResponseMemory(
                runtime,
                message,
                approvalPrompt,
                {
                    pending: true,
                    intentHash,
                    quote: quoteResult.content,
                    chainId,
                },
            );
            attachResponseSummary(memory, "Mantle swap awaiting approval");
            return persistAndReturn(runtime, memory, callback);
        },
    );
}

async function persistAndReturn(
    runtime: IAgentRuntime,
    memory: Memory,
    callback?: HandlerCallback,
): Promise<Memory[]> {
    await runtime.messageManager.createMemory(memory);
    if (callback) {
        await callback(memory);
    }
    return [memory];
}

function buildResponseMemory(
    runtime: IAgentRuntime,
    message: Memory,
    text: string,
    metadata: Record<string, unknown>,
): Memory {
    const txHash =
        typeof metadata.txHash === "string" ? metadata.txHash : undefined;
    const explorerUrl =
        typeof metadata.explorerUrl === "string"
            ? metadata.explorerUrl
            : undefined;
    const chainId =
        typeof metadata.chainId === "number" ? metadata.chainId : undefined;

    return {
        id: stringToUuid(uuidv4()) as UUID,
        userId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        content: {
            text,
            source: "mantle_workflow",
            metadata: {
                classification: "MANTLE_WORKFLOW_MESSAGE",
                txHash,
                explorerUrl,
                chainId,
                ...metadata,
            },
        },
        createdAt: Date.now(),
    };
}

/** Test helper */
export function __clearPendingMantleSwapsForTests(): void {
    pendingByRoomUser.clear();
    mantlePluginCache = null;
}

/** Test helper — seed a pending swap so routing/approval paths are testable. */
export function __setPendingMantleSwapForTests(
    roomId: UUID,
    userId: UUID,
    partial: Partial<PendingMantleSwap> = {},
): void {
    pendingByRoomUser.set(pendingKey(roomId, userId), {
        intentHash: "0xtest",
        tokenIn: "0x0000000000000000000000000000000000000000",
        tokenOut: "0x0000000000000000000000000000000000000000",
        amountIn: "0",
        amountInHuman: "0",
        maxSlippageBps: 100,
        chainId: 5003,
        quote: {},
        riskScore: 0,
        createdAt: Date.now(),
        userId,
        roomId,
        ...partial,
    } as PendingMantleSwap);
}

export function hasPendingMantleSwap(roomId: UUID, userId: UUID): boolean {
    pruneExpired();
    return pendingByRoomUser.has(pendingKey(roomId, userId));
}

/**
 * Weak affirmations/declines that are extremely common in ordinary
 * conversation. These must only reach the Mantle workflow when a swap is
 * actually pending — otherwise a bare "yes"/"no" in any chat was answered with
 * "No pending Mantle swap…", which is the R1 regression.
 */
const WEAK_AFFIRMATION_RE = /^(yes|y|yeah|yep|yup|no|n|nope|ok|okay|k|sure)$/i;

/**
 * Deliberate approval / decline verbs. A standalone "approve" or "cancel" is
 * a clear action intent, not chit-chat, so it keeps routing to the Mantle
 * handler even with no pending swap — the handler then replies with the
 * helpful "No pending Mantle swap to approve. Request a quote first" nudge
 * (relied on by the F2/F3/C5/E4/F1 edge cases). This matches the pre-existing
 * behavior, so it adds no new hijack surface; only the weak affirmations above
 * change.
 */
const DELIBERATE_APPROVAL_RE =
    /^(approve|confirm|execute|proceed|cancel|abort|stop|decline)$/i;

export function isMantleApprovalContinuation(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return (
        WEAK_AFFIRMATION_RE.test(normalized) ||
        DELIBERATE_APPROVAL_RE.test(normalized)
    );
}

/**
 * R1 fix: decide whether an approval-continuation message should be routed
 * into the Mantle workflow from runtime routing.
 *
 *  - Deliberate verbs ("approve"/"cancel"/…) route as before (unconditional).
 *  - Weak affirmations ("yes"/"no"/"ok"/…) route ONLY when a swap is pending,
 *    so generic conversational affirmations are no longer hijacked.
 */
export function shouldRouteMantleApprovalContinuation(
    text: string,
    roomId: UUID,
    userId: UUID,
): boolean {
    const normalized = text.trim().toLowerCase();
    if (DELIBERATE_APPROVAL_RE.test(normalized)) {
        return true;
    }
    if (WEAK_AFFIRMATION_RE.test(normalized)) {
        return hasPendingMantleSwap(roomId, userId);
    }
    return false;
}
