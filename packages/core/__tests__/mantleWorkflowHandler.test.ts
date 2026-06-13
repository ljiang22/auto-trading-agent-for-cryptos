import { beforeEach, describe, expect, it } from "vitest";
import {
    __clearPendingMantleSwapsForTests,
    __setPendingMantleSwapForTests,
    executeApprovedMantleSwap,
    hasPendingMantleSwap,
    isMantleApprovalContinuation,
    shouldRouteMantleApprovalContinuation,
    type MantleActionResult,
} from "../src/handlers/mantleWorkflowMessageHandler.ts";
import type { UUID } from "../src/core/types.ts";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const USER = "22222222-2222-2222-2222-222222222222" as UUID;

const PENDING = {
    intentHash: "0xintent" as `0x${string}`,
    tokenIn: "0xaaaa000000000000000000000000000000000000" as `0x${string}`,
    tokenOut: "0xbbbb000000000000000000000000000000000000" as `0x${string}`,
    amountIn: "5000000",
    amountInHuman: "5",
    maxSlippageBps: 100,
    chainId: 5000,
    quote: {},
    riskScore: 10,
    createdAt: Date.now(),
    userId: USER,
    roomId: ROOM,
} as Parameters<typeof executeApprovedMantleSwap>[0];

/** Build a recording invoker keyed by action name. */
function makeInvoker(
    responses: Record<string, MantleActionResult | (() => MantleActionResult)>,
) {
    const calls: string[] = [];
    const invoke = async (
        actionName: string,
        _options: Record<string, unknown>,
    ): Promise<MantleActionResult> => {
        calls.push(actionName);
        const r = responses[actionName];
        if (!r) throw new Error(`unexpected action: ${actionName}`);
        return typeof r === "function" ? r() : r;
    };
    return { invoke, calls };
}

const swapOk: MantleActionResult = {
    text: "**Mantle Swap Executed**\n- Tx: `0xswap`",
    content: { txHash: "0xswap", explorerUrl: "https://x/tx/0xswap", chainId: 5000 },
    metadata: { success: true, actionName: "execute_mantle_swap" },
};
const swapFailed: MantleActionResult = {
    text: "Swap execution failed: Request failed with status code 400",
    metadata: {
        success: false,
        actionName: "execute_mantle_swap",
        error: { message: "Request failed with status code 400" },
    },
};
const auditOk: MantleActionResult = {
    text: "Intent logged",
    content: { auditTxHash: "0xaudit" },
    metadata: { success: true, actionName: "log_mantle_intent" },
};
const auditFailed: MantleActionResult = {
    text: "audit failed",
    metadata: {
        success: false,
        actionName: "log_mantle_intent",
        error: { message: "audit revert" },
    },
};

describe("R1 — Mantle approval-continuation routing guard", () => {
    beforeEach(() => __clearPendingMantleSwapsForTests());

    it("does NOT route a bare 'yes'/'no'/'ok' when there is no pending swap", () => {
        expect(hasPendingMantleSwap(ROOM, USER)).toBe(false);
        for (const w of ["yes", "no", "ok", "okay", "sure", "yeah", "nope"]) {
            expect(shouldRouteMantleApprovalContinuation(w, ROOM, USER)).toBe(false);
        }
    });

    it("routes weak affirmations once a pending swap exists for room+user", () => {
        __setPendingMantleSwapForTests(ROOM, USER);
        expect(hasPendingMantleSwap(ROOM, USER)).toBe(true);
        expect(shouldRouteMantleApprovalContinuation("yes", ROOM, USER)).toBe(true);
        expect(shouldRouteMantleApprovalContinuation("no", ROOM, USER)).toBe(true);
    });

    it("routes deliberate verbs ('approve'/'cancel') even with no pending swap", () => {
        // These keep the pre-existing behavior so the F2/F3/C5/E4/F1 edge cases
        // still get the helpful "No pending Mantle swap to approve" nudge.
        expect(hasPendingMantleSwap(ROOM, USER)).toBe(false);
        for (const w of ["approve", "confirm", "execute", "proceed", "cancel", "abort"]) {
            expect(shouldRouteMantleApprovalContinuation(w, ROOM, USER)).toBe(true);
        }
    });

    it("does not route non-affirmations even with a pending swap", () => {
        __setPendingMantleSwapForTests(ROOM, USER);
        expect(shouldRouteMantleApprovalContinuation("what is bitcoin", ROOM, USER)).toBe(
            false,
        );
        expect(
            shouldRouteMantleApprovalContinuation("yes please do it", ROOM, USER),
        ).toBe(false);
    });

    it("weak-affirmation pending swap for one room does not leak to a different room", () => {
        __setPendingMantleSwapForTests(ROOM, USER);
        const otherRoom = "33333333-3333-3333-3333-333333333333" as UUID;
        expect(shouldRouteMantleApprovalContinuation("yes", otherRoom, USER)).toBe(
            false,
        );
    });

    it("isMantleApprovalContinuation matches the affirmation/decline vocabulary", () => {
        for (const w of ["approve", "confirm", "yes", "cancel", "no", "abort", "ok"]) {
            expect(isMantleApprovalContinuation(w)).toBe(true);
        }
        expect(isMantleApprovalContinuation("yes please do it")).toBe(false);
    });
});

describe("R2/R3 — executeApprovedMantleSwap ordering + failure contract", () => {
    it("R3: submits the swap BEFORE logging the on-chain intent", async () => {
        const { invoke, calls } = makeInvoker({
            execute_mantle_swap: swapOk,
            log_mantle_intent: auditOk,
        });
        const res = await executeApprovedMantleSwap(PENDING, invoke);
        expect(res.ok).toBe(true);
        expect(calls).toEqual(["execute_mantle_swap", "log_mantle_intent"]);
        expect(res.actionOrder).toEqual(["execute_mantle_swap", "log_mantle_intent"]);
        expect(res.swapPayload.txHash).toBe("0xswap");
        expect(res.auditPayload.auditTxHash).toBe("0xaudit");
    });

    it("R2: a failed swap returns ok=false and NEVER logs an intent", async () => {
        const { invoke, calls } = makeInvoker({
            execute_mantle_swap: swapFailed,
            log_mantle_intent: auditOk,
        });
        const res = await executeApprovedMantleSwap(PENDING, invoke);
        expect(res.ok).toBe(false);
        expect(res.errorMessage).toMatch(/400/);
        // The audit intent must NOT be written for a failed swap (R3 rationale).
        expect(calls).toEqual(["execute_mantle_swap"]);
        expect(calls).not.toContain("log_mantle_intent");
        expect(res.auditPayload).toEqual({});
    });

    it("R2: a swap response with no txHash is treated as a failure", async () => {
        const noTxHash: MantleActionResult = {
            text: "ambiguous",
            content: {},
            metadata: { success: true },
        };
        const { invoke, calls } = makeInvoker({
            execute_mantle_swap: noTxHash,
            log_mantle_intent: auditOk,
        });
        const res = await executeApprovedMantleSwap(PENDING, invoke);
        expect(res.ok).toBe(false);
        expect(calls).toEqual(["execute_mantle_swap"]);
    });

    it("audit-log failure is non-fatal: swap success stays authoritative", async () => {
        const warnings: string[] = [];
        const { invoke, calls } = makeInvoker({
            execute_mantle_swap: swapOk,
            log_mantle_intent: auditFailed,
        });
        const res = await executeApprovedMantleSwap(PENDING, invoke, {
            logger: { warn: (m) => warnings.push(m) },
        });
        expect(res.ok).toBe(true);
        expect(res.swapPayload.txHash).toBe("0xswap");
        expect(res.auditPayload).toEqual({});
        expect(calls).toEqual(["execute_mantle_swap", "log_mantle_intent"]);
        expect(warnings.some((w) => /audit intent log failed/i.test(w))).toBe(true);
    });

    it("happy path exposes both swap text and audit tx for the response", async () => {
        const { invoke } = makeInvoker({
            execute_mantle_swap: swapOk,
            log_mantle_intent: auditOk,
        });
        const res = await executeApprovedMantleSwap(PENDING, invoke);
        expect(res.text).toContain("Mantle Swap Executed");
        expect(res.auditPayload.auditTxHash).toBe("0xaudit");
    });
});
