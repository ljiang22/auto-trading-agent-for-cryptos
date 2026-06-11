/**
 * SSE step hooks — auto-approve task chains and CEX workflow modals.
 */

import {
    INTERRUPT_APPROVAL_DEBOUNCE_MS,
    interruptDedupeKey,
    interruptLevelKey,
    isHumanInputInterruptStep,
    isLegacyCexApprovalStep,
    parseInterruptStep,
    recordLatestInterrupt,
    resolveInterrupt,
    shouldApproveInterrupt,
} from "./humanInputInterrupt.mjs";
import { markApprovalPrompt } from "./transcript.mjs";

/** @type {Map<string, HookFactory>} */
const hookRegistry = new Map();

/**
 * @typedef {(ctx: HookContext) => HookHandler} HookFactory
 * @typedef {(event: unknown) => Promise<void>} HookHandler
 * @typedef {Object} HookContext
 * @property {import("./client.mjs").AgentClient} client
 * @property {string} roomId
 * @property {Record<string, unknown> | null} approvalTemplates
 * @property {Record<string, unknown>} caseDef
 * @property {import("./transcript.mjs").TranscriptState} [transcript]
 */

/**
 * @param {string} name
 * @param {HookFactory} factory
 */
export function registerHook(name, factory) {
    hookRegistry.set(name, factory);
}

/**
 * @param {string[]} names
 * @param {HookContext} ctx
 * @returns {HookHandler}
 */
export function createCombinedHookHandler(names, ctx) {
    const handlers = [];
    for (const name of names || []) {
        const factory = hookRegistry.get(name);
        if (!factory) {
            console.warn(`[hooks] unknown hook: ${name}`);
            continue;
        }
        handlers.push(factory(ctx));
    }

    return async (event) => {
        for (const handler of handlers) {
            await handler(event);
        }
    };
}

function isCEXApprovalStep(step) {
    return isLegacyCexApprovalStep(step);
}

function isApprovalPromptStep(step) {
    if (!step) {
        return false;
    }
    return isCEXApprovalStep(step) || isHumanInputInterruptStep(step);
}

function pickString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * @param {HookContext} ctx
 * @param {"approved" | "rejected"} defaultDecision
 */
function createCexApprovalHandler(ctx, defaultDecision) {
    const handledKeys = new Set();
    /** @type {Map<string, string>} */
    const latestInterruptByLevel = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    const pendingApprovalTimers = new Map();

    return async (event) => {
        if (!event || typeof event !== "object" || event.type !== "step") {
            return;
        }
        const step = event.step;
        if (!isApprovalPromptStep(step) || !step?.data) {
            return;
        }

        if (ctx.transcript) {
            markApprovalPrompt(ctx.transcript, Date.now() - ctx.transcript.startedAt);
        }

        if (isHumanInputInterruptStep(step)) {
            const interrupt = parseInterruptStep(step);
            if (!interrupt) {
                return;
            }
            recordLatestInterrupt(latestInterruptByLevel, interrupt);

            if (interrupt.plan_context) {
                const dedupeKey = interruptDedupeKey(
                    interrupt.approvalId,
                    interrupt.confirmationLevel,
                );
                if (ctx.transcript) {
                    ctx.transcript.markers.pendingPlanInterrupt = dedupeKey;
                }
                return;
            }

            if (!ctx.approvalTemplates && defaultDecision === "approved") {
                console.log(
                    "[hooks] human_input_required but no approvalTemplates loaded",
                );
                return;
            }

            const levelKey = interruptLevelKey(
                interrupt.threadId,
                interrupt.confirmationLevel,
            );
            const existingTimer = pendingApprovalTimers.get(levelKey);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            pendingApprovalTimers.set(
                levelKey,
                setTimeout(async () => {
                    pendingApprovalTimers.delete(levelKey);
                    if (!shouldApproveInterrupt(latestInterruptByLevel, interrupt)) {
                        return;
                    }
                    const dedupeKey = interruptDedupeKey(
                        interrupt.approvalId,
                        interrupt.confirmationLevel,
                    );
                    if (handledKeys.has(dedupeKey)) {
                        return;
                    }
                    handledKeys.add(dedupeKey);
                    try {
                        await resolveInterrupt(ctx, interrupt, defaultDecision);
                    } catch (err) {
                        console.warn(
                            `[hooks] human input resolve failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                }, INTERRUPT_APPROVAL_DEBOUNCE_MS),
            );
            return;
        }

        if (!isCEXApprovalStep(step)) {
            return;
        }

        if (!ctx.approvalTemplates) {
            console.log(
                "[hooks] CEX approval required but no approvalTemplates loaded",
            );
            return;
        }

        const confirmationLevel = Number(
            step.data?.confirmationLevel ?? step.data?.data?.confirmationLevel ?? 1,
        );
        const levelKey = `${defaultDecision}-L${confirmationLevel}`;
        if (handledKeys.has(levelKey)) {
            return;
        }
        handledKeys.add(levelKey);

        const templateKey = pickString(step.data?.approvalTemplateKey);
        const fallbackKey =
            confirmationLevel === 2 ? "confirmationLevel2" : "confirmationLevel1";
        const templates = ctx.approvalTemplates;

        const caseDecision = pickString(ctx.caseDef?.approvalDecision);
        const wantReject =
            defaultDecision === "rejected" ||
            caseDecision === "rejected";

        const rejectionTemplate = templates.rejectionTemplate || {
            decision: "rejected",
            feedback: "Rejected by test operator.",
        };

        let template;
        if (wantReject) {
            template = rejectionTemplate;
        } else {
            const caseTemplateKey = pickString(ctx.caseDef?.approvalTemplateKey);
            template =
                (caseTemplateKey && templates[caseTemplateKey]) ||
                (templateKey && templates[templateKey]) ||
                templates[fallbackKey] ||
                {};
        }

        const mergedParams = {
            ...(template.parameters || {}),
        };
        if (!wantReject) {
            const caseTemplateKey = pickString(ctx.caseDef?.approvalTemplateKey);
            const caseTemplate =
                caseTemplateKey && templates[caseTemplateKey]
                    ? templates[caseTemplateKey]
                    : null;
            Object.assign(mergedParams, caseTemplate?.parameters || {});
            const composeParams = ctx.caseDef?.compose?.params;
            if (composeParams && typeof composeParams === "object") {
                Object.assign(mergedParams, composeParams);
            }
        }

        const decision =
            template.decision ||
            (wantReject ? "rejected" : templates.defaults?.decision || "approved");

        console.log(
            `[hooks] CEX ${decision} L${confirmationLevel} template=${templateKey || (wantReject ? "rejectionTemplate" : fallbackKey)}`,
        );

        await ctx.client.postCexApproval(ctx.roomId, {
            decision,
            confirmationLevel,
            feedback:
                template.feedback ||
                templates.defaults?.feedback ||
                (wantReject
                    ? "Rejected by agent test harness"
                    : "Approved by agent test harness"),
            ...(Object.keys(mergedParams).length > 0
                ? { parameters: mergedParams }
                : {}),
        });
    };
}

registerHook("taskChainAutoApprove", (ctx) => {
    const approvedChainIds = new Set();

    return async (event) => {
        if (!event || typeof event !== "object" || event.type !== "step") {
            return;
        }
        const step = event.step;
        if (step?.name !== "chain_approval_required" || !step?.data) {
            return;
        }

        const approvalData = step.data;
        const chainId = approvalData?.chainId || approvalData?.taskChain?.id;
        if (chainId && approvedChainIds.has(chainId)) {
            return;
        }

        const taskChain = approvalData?.fullTaskChain || approvalData?.taskChain;
        if (!taskChain) {
            console.log("[hooks] taskChainAutoApprove skipped: missing taskChain");
            return;
        }

        if (chainId) {
            approvedChainIds.add(chainId);
        }

        console.log("[hooks] Auto-approving task chain...");
        await ctx.client.postTaskChainApproval(ctx.roomId, {
            decision: "approved",
            taskChain,
            feedback: "",
        });
    };
});

registerHook("cexAutoApprove", (ctx) => createCexApprovalHandler(ctx, "approved"));
registerHook("cexAutoReject", (ctx) => createCexApprovalHandler(ctx, "rejected"));
registerHook("humanInputAutoApprove", (ctx) => createCexApprovalHandler(ctx, "approved"));
registerHook("humanInputAutoReject", (ctx) => createCexApprovalHandler(ctx, "rejected"));

export { isCEXApprovalStep, isHumanInputInterruptStep };
