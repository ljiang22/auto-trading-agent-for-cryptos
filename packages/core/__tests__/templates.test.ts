import { describe, expect, it } from "vitest";
import { composeContextSplit } from "../src/core/context.ts";
import type { State, Template } from "../src/core/types.ts";

// Template-type imports (system/prompt split)
import { getMessageClassificationTemplate } from "../src/templates/messageClassificationTemplate.ts";
import {
    getRegularMessageTemplate,
    getFinalResponseTemplate,
} from "../src/templates/regularMessageTemplate.ts";
import {
    getTradingMessageTemplate,
    getTradingFinalResponseTemplate,
    getTradingResultFormattingTemplate,
} from "../src/templates/tradingMessageTemplate.ts";
import { comprehensive_analysis } from "../src/templates/comprehensive_analysis_prompt_template.ts";
import { getComprehensiveAnalysisActionsTemplate } from "../src/templates/comprehensive_analysis_actions.ts";
import {
    getTaskChainPlanningTemplate,
    getFavoriteChainUpdateTemplate,
} from "../src/templates/taskChainPlanningTemplates.ts";
import {
    getTaskChainActionTemplate,
    LLM_TASK_FORMATTING_REQUIREMENTS,
    getLLMTaskTemplateGenerationPrompt,
} from "../src/templates/taskChainExecutorTemplate.ts";
import { getTaskChainSupervisorTemplate } from "../src/templates/taskChainSupervisorTemplate.ts";
import { getCryptoContentAnalysisTemplate } from "../../plugin-content-analysis/src/templates/cryptoContentAnalysisTemplate.ts";
import { getGeneralContentAnalysisTemplate } from "../../plugin-content-analysis/src/templates/generalContentAnalysisTemplate.ts";

// String-type imports
import {
    getChainRuleLearningTemplate,
    getRuleConsolidationTemplate,
} from "../src/templates/ruleLearningTemplate.ts";

// --- helpers ---

const baseState: State = {
    actors: "",
    recentMessages: "",
    recentMessagesData: [],
    roomId: "-----",
    bio: "",
    lore: "",
    messageDirections: "",
    postDirections: "",
    userName: "",
};

/** Regex that matches {{word}} placeholders (not Handlebars block helpers like {{#if}}) */
const PLACEHOLDER_RE = /\{\{(?!#|\/|\^)(\w+)\}\}/g;

function extractPlaceholders(text: string): string[] {
    return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

// --- All Template-type templates ---

interface TemplateEntry {
    name: string;
    get: () => Template;
    expectedPromptPlaceholders: string[];
    emptyPrompt: boolean;
}

const templateEntries: TemplateEntry[] = [
    {
        name: "getMessageClassificationTemplate",
        get: getMessageClassificationTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userMessage",
            "recentMessages",
            "availableActions",
        ],
        emptyPrompt: false,
    },
    {
        name: "getRegularMessageTemplate",
        get: getRegularMessageTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userTraits",
            "recentMessages",
            "userMessage",
            "dataRetentionInfo",
            "availableActions",
            "actionResults",
        ],
        emptyPrompt: false,
    },
    {
        name: "getFinalResponseTemplate",
        get: getFinalResponseTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userTraits",
            "recentMessages",
            "userMessage",
            "actionResults",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTradingMessageTemplate",
        get: getTradingMessageTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userTraits",
            "recentMessages",
            "userMessage",
            "availableActions",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTradingFinalResponseTemplate",
        get: getTradingFinalResponseTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userTraits",
            "recentMessages",
            "userMessage",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTradingResultFormattingTemplate",
        get: getTradingResultFormattingTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userMessage",
            "actionName",
            "actionParameters",
            "actionOutput",
        ],
        emptyPrompt: false,
    },
    {
        name: "comprehensive_analysis",
        get: () => comprehensive_analysis,
        expectedPromptPlaceholders: [],
        emptyPrompt: true,
    },
    {
        name: "getComprehensiveAnalysisActionsTemplate",
        get: getComprehensiveAnalysisActionsTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "currentTimestamp",
            "latestQuery",
            "dataRetentionInfo",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTaskChainPlanningTemplate",
        get: getTaskChainPlanningTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userRequest",
            "availableActions",
            "lastFiveQueries",
            "learnedRules",
        ],
        emptyPrompt: false,
    },
    {
        name: "getFavoriteChainUpdateTemplate",
        get: getFavoriteChainUpdateTemplate,
        expectedPromptPlaceholders: [
            "currentDate",
            "userRequest",
            "favoriteChainJson",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTaskChainActionTemplate",
        get: getTaskChainActionTemplate,
        expectedPromptPlaceholders: [
            "taskName",
            "currentTime",
            "taskDescription",
            "dependencyTasks",
            "dataRetentionInfo",
            "availableActions",
        ],
        emptyPrompt: false,
    },
    {
        name: "getTaskChainSupervisorTemplate",
        get: getTaskChainSupervisorTemplate,
        expectedPromptPlaceholders: [
            "currentTime",
            "userRequest",
            "completedLevel",
            "executedActionsSummary",
            "fullChainSummary",
        ],
        emptyPrompt: false,
    },
    {
        name: "getCryptoContentAnalysisTemplate",
        get: getCryptoContentAnalysisTemplate,
        expectedPromptPlaceholders: [],
        emptyPrompt: true,
    },
    {
        name: "getGeneralContentAnalysisTemplate",
        get: getGeneralContentAnalysisTemplate,
        expectedPromptPlaceholders: [],
        emptyPrompt: true,
    },
];

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe("Template System Tests", () => {
    // ---------------------------------------------------------------
    // 1. Structure validation
    // ---------------------------------------------------------------
    describe("Structure validation", () => {
        it.each(templateEntries)(
            "$name returns { system: string, prompt: string }",
            ({ get }) => {
                const tpl = get();
                expect(tpl).toHaveProperty("system");
                expect(tpl).toHaveProperty("prompt");
                expect(typeof tpl.system).toBe("string");
                expect(typeof tpl.prompt).toBe("string");
            },
        );

        it.each(templateEntries)(
            "$name has non-empty system part",
            ({ get }) => {
                const tpl = get();
                expect(tpl.system.trim().length).toBeGreaterThan(0);
            },
        );
    });

    // ---------------------------------------------------------------
    // 2. System static check — no dynamic placeholders
    // ---------------------------------------------------------------
    describe("System static check — no dynamic placeholders", () => {
        it.each(templateEntries)(
            "$name system contains no {{...}} placeholders",
            ({ get }) => {
                const { system } = get();
                const found = extractPlaceholders(system);
                expect(found).toEqual([]);
            },
        );
    });

    // ---------------------------------------------------------------
    // 3. Prompt placeholder check
    // ---------------------------------------------------------------
    describe("Prompt placeholder check", () => {
        const withPrompt = templateEntries.filter((e) => !e.emptyPrompt);
        const withEmpty = templateEntries.filter((e) => e.emptyPrompt);

        it.each(withPrompt)(
            "$name prompt contains expected placeholders",
            ({ get, expectedPromptPlaceholders }) => {
                const { prompt } = get();
                const found = extractPlaceholders(prompt);
                for (const ph of expectedPromptPlaceholders) {
                    expect(found).toContain(ph);
                }
            },
        );

        it.each(withEmpty)(
            "$name has empty prompt string",
            ({ get }) => {
                const { prompt } = get();
                expect(prompt.trim()).toBe("");
            },
        );
    });

    // ---------------------------------------------------------------
    // 4. composeContextSplit integration
    // ---------------------------------------------------------------
    describe("composeContextSplit integration", () => {
        const stateA: State = {
            ...baseState,
            currentDate: "2026-03-19",
            currentTimestamp: "1742342400",
            userMessage: "Analyze BTC",
            recentMessages: "msg1\nmsg2",
            availableActions: "ACTION_A, ACTION_B",
            actionResults: "result data",
            userTraits: "crypto enthusiast",
            dataRetentionInfo: "Pro plan (24 months)",
            latestQuery: "BTC analysis",
            userRequest: "Compare BTC and ETH",
            lastFiveQueries: "q1\nq2",
            learnedRules: "rule1\nrule2",
            favoriteChainJson: '{"chain":"test"}',
            taskName: "Get BTC Data",
            currentTime: "2026-03-19T10:00",
            taskDescription: "Collect Bitcoin market data",
            dependencyTasks: "none",
            chainContext: "chain overview",
            actionSummary: "summary data",
            completedLevel: "1",
            executedActionsSummary: "task-1 done",
            fullChainSummary: "3 tasks total",
            actionName: "GET_PRICE",
            actionParameters: '{"symbol":"BTC"}',
            actionOutput: '{"price":65000}',
        };

        it.each(templateEntries.filter((e) => !e.emptyPrompt))(
            "$name — all prompt placeholders are replaced",
            ({ get }) => {
                const tpl = get();
                const { prompt } = composeContextSplit({
                    state: stateA,
                    template: tpl,
                });
                // No remaining simple {{word}} placeholders
                const remaining = extractPlaceholders(prompt);
                expect(remaining).toEqual([]);
            },
        );

        it.each(templateEntries)(
            "$name — system is unchanged after compose",
            ({ get }) => {
                const tpl = get();
                const { system } = composeContextSplit({
                    state: stateA,
                    template: tpl,
                });
                // System should be identical to the raw template system (no placeholders to replace)
                expect(system).toBe(tpl.system);
            },
        );
    });

    // ---------------------------------------------------------------
    // 5. System caching invariant — different states produce same system
    // ---------------------------------------------------------------
    describe("System caching invariant", () => {
        const stateX: State = {
            ...baseState,
            currentDate: "2026-01-01",
            userMessage: "Hello",
            recentMessages: "old msgs",
        };
        const stateY: State = {
            ...baseState,
            currentDate: "2026-12-31",
            userMessage: "Goodbye",
            recentMessages: "new msgs",
        };

        it.each(templateEntries)(
            "$name — system output identical for different states",
            ({ get }) => {
                const tpl = get();
                const resultX = composeContextSplit({
                    state: stateX,
                    template: tpl,
                });
                const resultY = composeContextSplit({
                    state: stateY,
                    template: tpl,
                });
                expect(resultX.system).toBe(resultY.system);
            },
        );
    });

    // ---------------------------------------------------------------
    // 6. Handlebars error recovery — malformed input falls back to regex
    // ---------------------------------------------------------------
    describe("Handlebars error recovery", () => {
        it("composeContextSplit does not throw on malformed Handlebars in state value", () => {
            const badState: State = {
                ...baseState,
                currentDate: "2026-03-19",
                userMessage: "{{#each broken",
                recentMessages: "{{#if unclosed",
                availableActions: "ACTION_A",
            };

            // Use a template that references these fields
            const tpl = getMessageClassificationTemplate();

            expect(() => {
                composeContextSplit({ state: badState, template: tpl });
            }).not.toThrow();
        });

        it("composeContextSplit still replaces placeholders when Handlebars fails", () => {
            const tpl: Template = {
                system: "Static system",
                prompt: "Date: {{currentDate}}, User: {{userMessage}}",
            };
            const badState: State = {
                ...baseState,
                currentDate: "2026-03-19",
                userMessage: "{{#each broken",
            };

            const result = composeContextSplit({ state: badState, template: tpl });
            expect(result.prompt).toContain("2026-03-19");
            expect(result.system).toBe("Static system");
        });
    });

    // ---------------------------------------------------------------
    // 7. String templates
    // ---------------------------------------------------------------
    describe("String templates", () => {
        it("LLM_TASK_FORMATTING_REQUIREMENTS is a non-empty string", () => {
            expect(typeof LLM_TASK_FORMATTING_REQUIREMENTS).toBe("string");
            expect(LLM_TASK_FORMATTING_REQUIREMENTS.trim().length).toBeGreaterThan(0);
        });

        it("getLLMTaskTemplateGenerationPrompt returns non-empty string", () => {
            const result = getLLMTaskTemplateGenerationPrompt(
                "Test Task",
                "Test description",
            );
            expect(typeof result).toBe("string");
            expect(result.trim().length).toBeGreaterThan(0);
            // Should contain the passed parameters
            expect(result).toContain("Test Task");
            expect(result).toContain("Test description");
        });

        it("getLLMTaskTemplateGenerationPrompt includes language instructions when provided", () => {
            const languageInstruction =
                "**RESPONSE LANGUAGE**: You MUST write your ENTIRE response in Simplified Chinese (简体中文).";
            const result = getLLMTaskTemplateGenerationPrompt(
                "Test Task",
                "Test description",
                languageInstruction,
            );

            expect(result).toContain(languageInstruction);
            expect(result).toContain("must itself be written in the required response language");
        });

        it("getChainRuleLearningTemplate returns string with expected placeholders", () => {
            const result = getChainRuleLearningTemplate();
            expect(typeof result).toBe("string");
            expect(result.trim().length).toBeGreaterThan(0);

            const placeholders = extractPlaceholders(result);
            expect(placeholders).toContain("originalRequest");
            expect(placeholders).toContain("rejectedChainJson");
            expect(placeholders).toContain("userFeedback");
            expect(placeholders).toContain("approvedChainJson");
        });

        it("getRuleConsolidationTemplate returns string with expected placeholders", () => {
            const result = getRuleConsolidationTemplate();
            expect(typeof result).toBe("string");
            expect(result.trim().length).toBeGreaterThan(0);

            const placeholders = extractPlaceholders(result);
            expect(placeholders).toContain("existingRules");
        });
    });
});
