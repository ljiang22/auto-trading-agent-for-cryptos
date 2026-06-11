import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "../src/ai/generation.ts";
import type { IAgentRuntime, Memory, State, UUID } from "../src/core/types.ts";
import { LangGraphTaskChainPlanner } from "../src/tasks/taskChainPlanner.ts";
import { getLanguageInstruction } from "../src/utils/languageUtils.ts";

vi.mock("../src/ai/generation.ts", () => ({
    generateText: vi.fn(),
}));

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000002" as UUID;

function createBaseContext(roomId: UUID, extras: Record<string, unknown> = {}): State {
    return {
        actors: "",
        bio: "",
        lore: "",
        messageDirections: "",
        postDirections: "",
        recentMessages: "",
        recentMessagesData: [],
        roomId,
        ...extras,
    } as State;
}

function createFavoriteChainMemory(roomId: UUID): Memory {
    return {
        id: "00000000-0000-0000-0000-000000000003" as UUID,
        userId: USER_ID,
        agentId: AGENT_ID,
        roomId,
        createdAt: Date.now(),
        content: {
            text: "Use the saved chain",
            favoriteTaskChain: {
                taskChain: {
                    id: "favorite-chain",
                    name: "English Favorite Chain",
                    description: "English description",
                    tasks: [
                        {
                            id: "favorite-task-1",
                            name: "Collect data",
                            description: "Collect the required market data",
                            dependencies: [],
                        },
                    ],
                },
            },
        },
    };
}

describe("LangGraphTaskChainPlanner language handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("injects language instruction into the main planning prompt", async () => {
        vi.mocked(generateText).mockResolvedValue(`
\`\`\`json
{
  "chain_name": "BTC 趋势分析",
  "chain_description": "分析 BTC 趋势",
  "tasks": [
    {
      "id": "task-1",
      "name": "获取 BTC 数据",
      "description": "收集 BTC 所需市场数据",
      "dependencies": []
    }
  ]
}
\`\`\`
        `);

        const planner = new LangGraphTaskChainPlanner({
            agentId: AGENT_ID,
        } as IAgentRuntime);

        await planner.planChain(
            "分析 BTC 的趋势",
            createBaseContext("00000000-0000-0000-0000-000000000010" as UUID, {
                languageInstruction: getLanguageInstruction(),
            }),
            []
        );

        const firstCall = vi.mocked(generateText).mock.calls[0]?.[0];
        expect(firstCall?.prompt).toContain("RESPONSE LANGUAGE");
        expect(firstCall?.prompt).toContain("SAME language");
        expect(firstCall?.prompt).toContain('User Request: "分析 BTC 的趋势"');
    });

    it("preserves language instruction when personalizing a favorite task chain", async () => {
        vi.mocked(generateText).mockResolvedValue(`
\`\`\`json
{
  "chain_name": "中文收藏任务链",
  "chain_description": "根据当前请求更新收藏任务链",
  "tasks": [
    {
      "id": "favorite-task-1",
      "name": "收集市场数据",
      "description": "根据当前请求收集市场数据",
      "dependencies": []
    }
  ]
}
\`\`\`
        `);

        const roomId = "00000000-0000-0000-0000-000000000011" as UUID;
        const favoriteMemory = createFavoriteChainMemory(roomId);
        const planner = new LangGraphTaskChainPlanner({
            agentId: AGENT_ID,
        } as IAgentRuntime);

        await planner.planChain(
            "请按今天的市场情况调整这个任务链",
            createBaseContext(roomId, {
                languageInstruction: getLanguageInstruction(),
                recentMessagesData: [favoriteMemory],
                lastFiveMessagesData: [favoriteMemory],
            }),
            []
        );

        const firstCall = vi.mocked(generateText).mock.calls[0]?.[0];
        expect(firstCall?.prompt).toContain("RESPONSE LANGUAGE");
        expect(firstCall?.prompt).toContain("SAME language");
        expect(firstCall?.prompt).toContain("Saved Task Chain");
    });
});
