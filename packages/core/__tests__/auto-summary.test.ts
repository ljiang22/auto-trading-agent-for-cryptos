import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentRuntime } from "../src/runtime.ts";
import type { Memory, Action, Character, UUID } from "../src/types.ts";
import { ModelProviderName } from "../src/types.ts";
import { stringToUuid } from "../src/uuid.ts";

// Mock summary action for testing
const mockSummaryAction: Action = {
    name: "SUMMARIZE",
    similes: ["SUMMARY", "RECAP", "OVERVIEW"],
    description: "Generate a summary of the conversation",
    examples: [],
    validate: async () => true,
    handler: async () => {
        console.log("Executing SUMMARIZE");
        return true;
    }
};

// Mock actions for testing
const mockAction1: Action = {
    name: "TEST_ACTION_1",
    similes: ["TEST1", "ACTION1"],
    description: "First test action",
    examples: [],
    validate: async () => true,
    handler: async () => {
        console.log("Executing TEST_ACTION_1");
        return true;
    }
};

const mockAction2: Action = {
    name: "TEST_ACTION_2", 
    similes: ["TEST2", "ACTION2"],
    description: "Second test action",
    examples: [],
    validate: async () => true,
    handler: async () => {
        console.log("Executing TEST_ACTION_2");
        return true;
    }
};

const mockCharacter: Character = {
    id: stringToUuid("test-character"),
    name: "Test Character",
    username: "testchar",
    plugins: [],
    modelProvider: ModelProviderName.OPENAI,
    settings: {
        secrets: {},
        voice: {
            model: "en_US-hfc_female-medium"
        }
    },
    system: "You are a helpful AI assistant for testing.",
    bio: ["Test character for auto-summary feature"],
    lore: [],
    messageExamples: [],
    postExamples: [],
    topics: [],
    style: {
        all: [],
        chat: [],
        post: []
    },
    adjectives: []
};

// Mock database adapter
const mockDatabaseAdapter = {
    getRoom: vi.fn(),
    createRoom: vi.fn(),
    getParticipantsForAccount: vi.fn().mockResolvedValue([]),
    addParticipant: vi.fn(),
    getAccountById: vi.fn(),
    createAccount: vi.fn(),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getMemories: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    log: vi.fn(),
    getActorDetails: vi.fn().mockResolvedValue([]),
    searchMemoriesByEmbedding: vi.fn().mockResolvedValue([])
};

describe("Auto-Summary Feature", () => {
    let runtime: AgentRuntime;
    let testMessage: Memory;
    let callbackSpy: any;

    beforeEach(() => {
        // Create runtime with auto-summary enabled
        runtime = new AgentRuntime({
            character: mockCharacter,
            token: "test-token",
            modelProvider: ModelProviderName.OPENAI,
            databaseAdapter: mockDatabaseAdapter as any,
            autoSummaryEnabled: true
        });

        // Register test actions and summary action
        runtime.registerAction(mockAction1);
        runtime.registerAction(mockAction2);
        runtime.registerAction(mockSummaryAction);

        // Create test message
        testMessage = {
            id: stringToUuid("test-message"),
            userId: stringToUuid("test-user"),
            agentId: runtime.agentId,
            roomId: stringToUuid("test-room"),
            content: {
                text: "Execute multiple actions"
            },
            createdAt: Date.now()
        };

        // Create callback spy
        callbackSpy = vi.fn();
    });

    it("should be enabled by default", () => {
        expect(runtime.isAutoSummaryEnabled()).toBe(true);
    });

    it("should allow enabling/disabling auto-summary", () => {
        runtime.setAutoSummaryEnabled(false);
        expect(runtime.isAutoSummaryEnabled()).toBe(false);

        runtime.setAutoSummaryEnabled(true);
        expect(runtime.isAutoSummaryEnabled()).toBe(true);
    });

    it("should auto-trigger summary when multiple actions are executed", async () => {
        // Mock the summary action handler to track if it was called
        const originalHandler = mockSummaryAction.handler;
        const summaryHandlerSpy = vi.fn().mockImplementation(originalHandler);
        mockSummaryAction.handler = summaryHandlerSpy;

        // Create response with multiple actions
        const responseWithMultipleActions: Memory = {
            id: stringToUuid("response"),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: testMessage.roomId,
            content: {
                text: "I'll execute both actions",
                action: ["TEST_ACTION_1", "TEST_ACTION_2"]
            },
            createdAt: Date.now()
        };

        // Process the actions
        await runtime.processActions(
            testMessage,
            [responseWithMultipleActions],
            undefined,
            callbackSpy
        );

        // Verify summary action was called
        expect(summaryHandlerSpy).toHaveBeenCalled();
        
        // Verify it was called with auto-triggered options
        const callArgs = summaryHandlerSpy.mock.calls[0];
        expect(callArgs[3]).toEqual(expect.objectContaining({
            autoTriggered: true,
            executedActions: ["TEST_ACTION_1", "TEST_ACTION_2"]
        }));

        // Restore original handler
        mockSummaryAction.handler = originalHandler;
    });

    it("should not auto-trigger summary when only one action is executed", async () => {
        // Mock the summary action handler to track if it was called
        const originalHandler = mockSummaryAction.handler;
        const summaryHandlerSpy = vi.fn().mockImplementation(originalHandler);
        mockSummaryAction.handler = summaryHandlerSpy;

        // Create response with single action
        const responseWithSingleAction: Memory = {
            id: stringToUuid("response"),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: testMessage.roomId,
            content: {
                text: "I'll execute one action",
                action: "TEST_ACTION_1"
            },
            createdAt: Date.now()
        };

        // Process the actions
        await runtime.processActions(
            testMessage,
            [responseWithSingleAction],
            undefined,
            callbackSpy
        );

        // Verify summary action was NOT called
        expect(summaryHandlerSpy).not.toHaveBeenCalled();

        // Restore original handler
        mockSummaryAction.handler = originalHandler;
    });

    it("should not auto-trigger summary when feature is disabled", async () => {
        // Disable auto-summary
        runtime.setAutoSummaryEnabled(false);

        // Mock the summary action handler to track if it was called
        const originalHandler = mockSummaryAction.handler;
        const summaryHandlerSpy = vi.fn().mockImplementation(originalHandler);
        mockSummaryAction.handler = summaryHandlerSpy;

        // Create response with multiple actions
        const responseWithMultipleActions: Memory = {
            id: stringToUuid("response"),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: testMessage.roomId,
            content: {
                text: "I'll execute both actions",
                action: ["TEST_ACTION_1", "TEST_ACTION_2"]
            },
            createdAt: Date.now()
        };

        // Process the actions
        await runtime.processActions(
            testMessage,
            [responseWithMultipleActions],
            undefined,
            callbackSpy
        );

        // Verify summary action was NOT called
        expect(summaryHandlerSpy).not.toHaveBeenCalled();

        // Restore original handler
        mockSummaryAction.handler = originalHandler;
    });

    it("should not auto-trigger summary if summary action was already executed", async () => {
        // Mock the summary action handler to track if it was called
        const originalHandler = mockSummaryAction.handler;
        const summaryHandlerSpy = vi.fn().mockImplementation(originalHandler);
        mockSummaryAction.handler = summaryHandlerSpy;

        // Create response with multiple actions including summary
        const responseWithSummaryIncluded: Memory = {
            id: stringToUuid("response"),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: testMessage.roomId,
            content: {
                text: "I'll execute actions and summarize",
                action: ["TEST_ACTION_1", "SUMMARIZE", "TEST_ACTION_2"]
            },
            createdAt: Date.now()
        };

        // Process the actions
        await runtime.processActions(
            testMessage,
            [responseWithSummaryIncluded],
            undefined,
            callbackSpy
        );

        // Verify summary action was called only once (not auto-triggered)
        expect(summaryHandlerSpy).toHaveBeenCalledTimes(1);
        
        // Verify it was NOT called with auto-triggered options
        const callArgs = summaryHandlerSpy.mock.calls[0];
        expect(callArgs[3]).not.toEqual(expect.objectContaining({
            autoTriggered: true
        }));

        // Restore original handler
        mockSummaryAction.handler = originalHandler;
    });
}); 