/**
 * Fix 9 — Anonymous-throttle: honest auth-required reply.
 *
 * `AgentRuntime.routeMessage` used to force-reroute every anonymous
 * (`metadata.isAnonymous === true`) message to `handleRegularMessage`
 * regardless of intent. CEX-intent questions ("show my balance",
 * "buy BTC", "我的账户余额") therefore landed on the REGULAR handler
 * which would decline with a generic "I don't have access to your
 * accounts" — looking like a product bug, not a permissions issue.
 *
 * This test pins the new behavior: a deterministic short-circuit on
 * `cex_account_intent` or `cex_trade_intent` produces a synthetic
 * Memory carrying the CEX auth-required template (locale-aware) AND
 * skips the REGULAR handler entirely. Non-CEX anonymous messages
 * still flow through REGULAR as before.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRuntime } from "../src/core/runtime";
import {
    type IDatabaseAdapter,
    ModelProviderName,
    type Memory,
    type UUID,
} from "../src/core/types";
import { mockCharacter } from "./mockCharacter.ts";

const mockDatabaseAdapter: IDatabaseAdapter = {
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getAccountById: vi.fn().mockResolvedValue(null),
    createAccount: vi.fn().mockResolvedValue(true),
    getMemories: vi.fn().mockResolvedValue([]),
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    log: vi.fn().mockResolvedValue(undefined),
    getActorDetails: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    updateGoalStatus: vi.fn().mockResolvedValue(undefined),
    searchMemoriesByEmbedding: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn().mockResolvedValue(undefined),
    removeMemory: vi.fn().mockResolvedValue(undefined),
    removeAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getGoals: vi.fn().mockResolvedValue([]),
    updateGoal: vi.fn().mockResolvedValue(undefined),
    createGoal: vi.fn().mockResolvedValue(undefined),
    removeGoal: vi.fn().mockResolvedValue(undefined),
    removeAllGoals: vi.fn().mockResolvedValue(undefined),
    getRoom: vi.fn().mockResolvedValue(null),
    createRoom: vi.fn().mockResolvedValue("test-room-id" as UUID),
    getRoomById: vi.fn().mockResolvedValue({
        id: "test-room-id" as UUID,
        name: "Test Room",
        createdAt: new Date().toISOString(),
    }),
    removeRoom: vi.fn().mockResolvedValue(undefined),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    addParticipant: vi.fn().mockResolvedValue(true),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForAccount: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(true),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
};

const mockCacheManager = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
};

const ROOM_ID = "00000000-0000-0000-0000-000000000aaa" as UUID;
const ANON_USER_ID = "00000000-0000-0000-0000-000000000bbb" as UUID;
const AUTH_USER_ID = "00000000-0000-0000-0000-000000000ccc" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000ddd" as UUID;

function buildMessage(
    text: string,
    opts: { isAnonymous?: boolean; userId?: UUID } = {},
): Memory {
    return {
        id: "00000000-0000-0000-0000-000000000eee" as UUID,
        userId: opts.userId ?? ANON_USER_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        createdAt: Date.now(),
        content: {
            text,
            metadata:
                opts.isAnonymous !== undefined
                    ? { isAnonymous: opts.isAnonymous }
                    : undefined,
        },
    };
}

describe("AgentRuntime.routeMessage — Fix 9: anonymous CEX-intent short-circuit", () => {
    let runtime: AgentRuntime;
    let handleRegularSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        runtime = new AgentRuntime({
            token: "test-token",
            character: mockCharacter,
            databaseAdapter: mockDatabaseAdapter,
            cacheManager: mockCacheManager,
            modelProvider: ModelProviderName.OPENAI,
        });

        // Stub `handleRegularMessage` so we can assert it's NOT called on
        // CEX-intent and IS called on non-CEX intent without exercising
        // the full LLM pipeline.
        handleRegularSpy = vi
            .spyOn(runtime, "handleRegularMessage" as never)
            .mockImplementation(
                (async (_msg: Memory) => {
                    return [];
                }) as never,
            );

        // Silence the background userFeature task — it accesses MongoDB
        // in real life. Replace its `processMessage` with a no-op.
        (runtime.userFeatureManager as unknown as {
            processMessage: (m: Memory) => Promise<void>;
        }).processMessage = vi.fn().mockResolvedValue(undefined);
    });

    it("CEX account-intent (EN) → auth-required reply, NOT REGULAR", async () => {
        const message = buildMessage("show my balance", { isAnonymous: true });

        const responses = await runtime.routeMessage(message);

        expect(handleRegularSpy).not.toHaveBeenCalled();
        expect(responses).toHaveLength(1);

        const reply = responses[0];
        expect(reply.content.text).toContain("sign in");
        expect(reply.content.text).toContain("Please sign in and try again");

        const metadata = reply.content.metadata as Record<string, unknown>;
        expect(metadata.classification).toBe("CEX_WORKFLOW_MESSAGE");
        expect(metadata.anonymousCexAuthRequired).toBe(true);
        expect(metadata.shortCircuitPattern).toBe("cex_account_intent");

        // The synthetic reply was persisted (chat shows the prompt).
        expect(mockDatabaseAdapter.createMemory).toHaveBeenCalled();
    });

    it("CEX account-intent (zh-CN) → auth-required reply in Chinese", async () => {
        const message = buildMessage("我的账户余额", { isAnonymous: true });

        const responses = await runtime.routeMessage(message);

        expect(handleRegularSpy).not.toHaveBeenCalled();
        expect(responses).toHaveLength(1);

        const reply = responses[0];
        // Chinese template — verify both the polite request and the
        // sign-in directive made it through.
        expect(reply.content.text).toContain("登录");
        expect(reply.content.text).toContain("请登录");
        expect(reply.content.language).toBe("zh-CN");

        const metadata = reply.content.metadata as Record<string, unknown>;
        expect(metadata.shortCircuitPattern).toBe("cex_account_intent");
    });

    it("CEX trade-intent (EN) → auth-required reply, NOT REGULAR", async () => {
        const message = buildMessage("buy BTC", { isAnonymous: true });

        const responses = await runtime.routeMessage(message);

        expect(handleRegularSpy).not.toHaveBeenCalled();
        expect(responses).toHaveLength(1);

        const metadata = responses[0].content.metadata as Record<string, unknown>;
        expect(metadata.shortCircuitPattern).toBe("cex_trade_intent");
        expect(metadata.classification).toBe("CEX_WORKFLOW_MESSAGE");
    });

    it("non-CEX anonymous message keeps existing REGULAR handler path", async () => {
        const message = buildMessage("what is BTC's price?", { isAnonymous: true });

        await runtime.routeMessage(message);

        expect(handleRegularSpy).toHaveBeenCalledTimes(1);

        // The metadata mutation that the REGULAR-path branch performs
        // tells us the right branch ran.
        const passedMessage = handleRegularSpy.mock.calls[0][0] as Memory;
        const metadata = passedMessage.content.metadata as Record<string, unknown>;
        expect(metadata.classification).toBe("REGULAR_MESSAGE");
    });

    it("authenticated CEX-intent message does NOT trigger the anonymous fast-path", async () => {
        // `isAnonymous` is absent → the anonymous gate is skipped entirely.
        // We stub the downstream classifier and the comprehensive override
        // so the call resolves cleanly, then assert the Fix 9 synthetic
        // memory was never produced.
        const message = buildMessage("show my balance", {
            isAnonymous: false,
            userId: AUTH_USER_ID,
        });

        const precheckSpy = vi
            .spyOn(runtime.messagePrecheckService, "classifyMessage")
            .mockResolvedValue({
                classification: "REGULAR_MESSAGE",
                confidence: 0.9,
                reasoning: "test",
                isCryptoRelated: true,
            } as never);

        vi.spyOn(runtime, "isComprehensiveAnalysisEnabled" as never).mockReturnValue(
            false as never,
        );

        // Disable the CEX deterministic bypass for this test so the
        // authenticated message reaches the regular classifier and our
        // stub above gets exercised.
        const prevBypassEnv = process.env.CEX_DETERMINISTIC_BYPASS;
        process.env.CEX_DETERMINISTIC_BYPASS = "false";

        try {
            const responses = await runtime.routeMessage(message);

            for (const r of responses) {
                const meta = (r.content?.metadata ?? {}) as Record<string, unknown>;
                expect(meta.anonymousCexAuthRequired).toBeFalsy();
            }

            // REGULAR handler should have been invoked because the
            // classifier returned REGULAR_MESSAGE — confirms we exited
            // the anonymous branch correctly and stayed on the standard
            // authenticated routing path.
            expect(handleRegularSpy).toHaveBeenCalled();
        } finally {
            if (prevBypassEnv === undefined) {
                delete process.env.CEX_DETERMINISTIC_BYPASS;
            } else {
                process.env.CEX_DETERMINISTIC_BYPASS = prevBypassEnv;
            }
            precheckSpy.mockRestore();
        }
    });
});
