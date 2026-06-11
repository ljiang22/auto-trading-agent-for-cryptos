import { describe, it, expect, vi, beforeEach } from "vitest";
import { summaryAction } from "../../src/actions/summary.ts";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";

// Mock the core functions
vi.mock("@elizaos/core", async () => {
    const actual = await vi.importActual("@elizaos/core");
    return {
        ...actual,
        generateText: vi.fn(),
        embed: vi.fn(),
        formatMessages: vi.fn(),
        MemoryManager: vi.fn(),
    };
});

describe("Summary Action", () => {
    let mockRuntime: IAgentRuntime;
    let mockMessage: Memory;
    let mockState: State;
    let mockCallback: any;

    beforeEach(() => {
        // Reset all mocks
        vi.clearAllMocks();

        // Mock runtime
        mockRuntime = {
            agentId: "550e8400-e29b-41d4-a716-446655440000",
            character: {
                name: "TestAgent",
            },
        } as any;

        // Mock message
        mockMessage = {
            id: "550e8400-e29b-41d4-a716-446655440001",
            userId: "550e8400-e29b-41d4-a716-446655440002",
            agentId: "550e8400-e29b-41d4-a716-446655440000",
            roomId: "550e8400-e29b-41d4-a716-446655440003",
            content: {
                text: "Can you summarize our conversation?",
            },
            createdAt: Date.now(),
        };

        // Mock state
        mockState = {
            userId: "550e8400-e29b-41d4-a716-446655440002",
            agentId: "550e8400-e29b-41d4-a716-446655440000",
            roomId: "550e8400-e29b-41d4-a716-446655440003",
            bio: "Test agent bio",
            lore: "Test agent lore",
            messageDirections: "Test directions",
            postDirections: "Test post directions",
            actors: "Test actors",
            recentMessages: "Test recent messages",
            recentMessagesData: [
                {
                    id: "550e8400-e29b-41d4-a716-446655440004",
                    userId: "550e8400-e29b-41d4-a716-446655440005",
                    agentId: "550e8400-e29b-41d4-a716-446655440000",
                    roomId: "550e8400-e29b-41d4-a716-446655440003",
                    content: { text: "Hello, how are you?" },
                    createdAt: Date.now() - 1000,
                },
                {
                    id: "550e8400-e29b-41d4-a716-446655440006",
                    userId: "550e8400-e29b-41d4-a716-446655440000",
                    agentId: "550e8400-e29b-41d4-a716-446655440000",
                    roomId: "550e8400-e29b-41d4-a716-446655440003",
                    content: { text: "I'm doing well, thank you!" },
                    createdAt: Date.now() - 500,
                },
            ],
            knowledge: "Test knowledge base content",
            goals: "Test goals",
        };

        // Mock callback
        mockCallback = vi.fn();
    });

    describe("validate", () => {
        it("should return true when there are recent messages", async () => {
            const result = await summaryAction.validate(mockRuntime, mockMessage, mockState);
            expect(result).toBe(true);
        });

        it("should return true when message has content", async () => {
            const stateWithoutMessages = { ...mockState, recentMessagesData: [] };
            const result = await summaryAction.validate(mockRuntime, mockMessage, stateWithoutMessages);
            expect(result).toBe(true);
        });

        it("should return false when no content or messages available", async () => {
            const emptyMessage = { ...mockMessage, content: { text: "" } };
            const emptyState = { ...mockState, recentMessagesData: [] };
            const result = await summaryAction.validate(mockRuntime, emptyMessage, emptyState);
            expect(result).toBe(false);
        });
    });

    describe("handler", () => {
        beforeEach(() => {
            // Mock the imported functions
            const { generateText, embed, formatMessages, MemoryManager } = require("@elizaos/core");
            
            generateText.mockResolvedValue("Generated summary content");
            embed.mockResolvedValue([0.1, 0.2, 0.3]);
            formatMessages.mockReturnValue("Formatted messages");
            
            // Mock MemoryManager
            const mockMemoryManager = {
                searchMemoriesByEmbedding: vi.fn().mockResolvedValue([
                    {
                        id: "550e8400-e29b-41d4-a716-446655440007",
                        content: { text: "Important fact 1" },
                    },
                    {
                        id: "550e8400-e29b-41d4-a716-446655440008",
                        content: { text: "Important fact 2" },
                    },
                ]),
                createMemory: vi.fn().mockResolvedValue(undefined),
            };
            MemoryManager.mockImplementation(() => mockMemoryManager);
        });

        it("should successfully generate a summary", async () => {
            const result = await summaryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith({
                text: "Generated summary content",
                action: "SUMMARIZE",
                source: "summary_action",
            });
        });

        it("should handle missing state gracefully", async () => {
            const result = await summaryAction.handler(
                mockRuntime,
                mockMessage,
                undefined,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(mockCallback).toHaveBeenCalled();
        });

        it("should handle errors gracefully", async () => {
            const { generateText } = require("@elizaos/core");
            generateText.mockRejectedValue(new Error("Generation failed"));

            const result = await summaryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(result).toBe(false);
            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining("error while generating"),
                action: "SUMMARIZE",
                source: "summary_action_error",
            });
        });

        it("should work without callback", async () => {
            const result = await summaryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {}
            );

            expect(result).toBe(true);
        });

        it("should include knowledge base in context", async () => {
            const { generateText } = require("@elizaos/core");
            
            await summaryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(generateText).toHaveBeenCalledWith({
                runtime: mockRuntime,
                context: expect.stringContaining("Test knowledge base content"),
                modelClass: expect.any(String),
            });
        });

        it("should include goals in context", async () => {
            const { generateText } = require("@elizaos/core");
            
            await summaryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(generateText).toHaveBeenCalledWith({
                runtime: mockRuntime,
                context: expect.stringContaining("Test goals"),
                modelClass: expect.any(String),
            });
        });
    });

    describe("action properties", () => {
        it("should have correct name", () => {
            expect(summaryAction.name).toBe("SUMMARIZE");
        });

        it("should have appropriate similes", () => {
            expect(summaryAction.similes).toContain("SUMMARY");
            expect(summaryAction.similes).toContain("RECAP");
            expect(summaryAction.similes).toContain("OVERVIEW");
        });

        it("should have a description", () => {
            expect(summaryAction.description).toBeTruthy();
            expect(summaryAction.description).toContain("summary");
        });

        it("should have examples", () => {
            expect(summaryAction.examples).toBeDefined();
            expect(summaryAction.examples.length).toBeGreaterThan(0);
        });

        it("should have valid example structure", () => {
            summaryAction.examples.forEach((example) => {
                expect(example).toHaveLength(2); // User message and agent response
                expect(example[0]).toHaveProperty("user");
                expect(example[0]).toHaveProperty("content");
                expect(example[1]).toHaveProperty("user");
                expect(example[1]).toHaveProperty("content");
                expect(example[1].content).toHaveProperty("action", "SUMMARIZE");
            });
        });
    });
}); 