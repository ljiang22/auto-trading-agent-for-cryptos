import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "../src/ai/generation.ts";
import type {
    IAgentRuntime,
    Memory,
    State,
    TaskChain,
    TaskExecutionContext,
    TaskNode,
    UUID,
} from "../src/core/types.ts";
import { DefaultTaskExecutor } from "../src/tasks/taskExecutor.ts";
import { getLanguageInstruction } from "../src/utils/languageUtils.ts";

vi.mock("../src/ai/generation.ts", () => ({
    generateText: vi.fn(),
}));

const AGENT_ID = "00000000-0000-0000-0000-000000000021" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000022" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-000000000023" as UUID;
const TASK_ID = "00000000-0000-0000-0000-000000000024" as UUID;
const CHAIN_ID = "00000000-0000-0000-0000-000000000025" as UUID;

function createRuntime(): IAgentRuntime {
    return {
        agentId: AGENT_ID,
        actions: [],
        plugins: [],
        character: {
            settings: {},
        },
        shouldStop: () => false,
    } as IAgentRuntime;
}

function createTask(): TaskNode {
    return {
        id: TASK_ID,
        name: "Analyze BTC trend",
        description: "Analyze BTC market trend based on the available inputs",
        dependencies: [],
        status: "pending",
        type: undefined as any,
        inputs: [],
        outputs: [],
        config: {} as any,
    };
}

function createChain(task: TaskNode): TaskChain {
    return {
        id: CHAIN_ID,
        name: "BTC Trend Chain",
        description: "Analyze BTC market trend",
        originalRequest: "Analyze BTC trend",
        tasks: [task],
        metadata: {
            createdAt: Date.now(),
            status: "pending",
        },
        config: {
            maxParallel: 1,
            timeout: 300000,
            continueOnFailure: false,
        },
    } as TaskChain;
}

function createContext(runtime: IAgentRuntime, chain: TaskChain): TaskExecutionContext {
    return {
        runtime,
        state: {
            roomId: ROOM_ID,
            actors: "",
            bio: "",
            lore: "",
            messageDirections: "",
            postDirections: "",
            recentMessages: "",
            recentMessagesData: [],
            languageInstruction: getLanguageInstruction(),
        } as State,
        originalMessage: {
            id: MESSAGE_ID,
            userId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            createdAt: Date.now(),
            content: {
                text: "Analyze BTC trend",
                language: "zh-CN",
            },
        } as Memory,
        chain,
    };
}

describe("DefaultTaskExecutor language handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("passes language instructions through action selection, meta prompt generation, and final LLM execution", async () => {
        vi.mocked(generateText)
            .mockResolvedValueOnce(`\`\`\`json
{
  "task_type": "llm",
  "selected_actions": [],
  "description": "Use an LLM to analyze BTC trend"
}
\`\`\``)
            .mockResolvedValueOnce("Please analyze the market context.\n{{languageInstruction}}")
            .mockResolvedValueOnce(`{
  "results": "# BTC 趋势分析\\n\\n市场偏多。",
  "summary": "BTC 当前偏多。"
}`);

        const runtime = createRuntime();
        const task = createTask();
        const chain = createChain(task);
        const context = createContext(runtime, chain);
        const executor = new DefaultTaskExecutor(runtime);

        const result = await executor.executeTask(task, {}, context);

        expect(result.status).toBe("completed");
        expect(vi.mocked(generateText)).toHaveBeenCalledTimes(3);

        const [selectionCall, metaPromptCall, finalExecutionCall] = vi.mocked(generateText).mock.calls.map(call => call[0]);

        expect(selectionCall.prompt).toContain("RESPONSE LANGUAGE");
        expect(selectionCall.prompt).toContain("SAME language");
        expect(selectionCall.prompt).toContain("Select the optimal approach");

        expect(metaPromptCall.prompt).toContain("RESPONSE LANGUAGE");
        expect(metaPromptCall.prompt).toContain("SAME language");
        expect(metaPromptCall.prompt).toContain("must itself be written in the required response language");

        expect(finalExecutionCall.prompt).toContain("RESPONSE LANGUAGE");
        expect(finalExecutionCall.prompt).toContain("SAME language");
        expect(finalExecutionCall.prompt).toContain("Please analyze the market context.");
    });
});
