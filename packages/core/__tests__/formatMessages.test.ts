import { describe, expect, it } from "vitest";
import { formatMessages } from "../src/core/messages";
import type { Actor, Memory, UUID } from "../src/core/types";

const userId = "11111111-1111-1111-1111-111111111111" as UUID;
const agentId = "22222222-2222-2222-2222-222222222222" as UUID;
const roomId = "33333333-3333-3333-3333-333333333333" as UUID;

const actors: Actor[] = [
    {
        id: userId,
        name: "Alice",
        username: "alice",
        details: { tagline: "", summary: "", quote: "" },
    },
    {
        id: agentId,
        name: "Eliza",
        username: "eliza",
        details: { tagline: "", summary: "", quote: "" },
    },
];

const makeMemory = (params: {
    fromAgent: boolean;
    text: string;
    summary?: string;
    createdAt: number;
}): Memory => ({
    id: undefined,
    userId: params.fromAgent ? agentId : userId,
    agentId,
    roomId,
    createdAt: params.createdAt,
    content: {
        text: params.text,
        metadata: params.summary !== undefined ? { summary: params.summary } : {},
    },
});

describe("formatMessages", () => {
    it("default behavior renders full text for both user and agent turns", () => {
        const now = Date.now();
        const messages: Memory[] = [
            makeMemory({ fromAgent: false, text: "user question", createdAt: now - 2000 }),
            makeMemory({
                fromAgent: true,
                text: "long agent answer body",
                summary: "- short summary",
                createdAt: now - 1000,
            }),
        ];
        const formatted = formatMessages({ messages, actors });
        expect(formatted).toContain("user question");
        expect(formatted).toContain("long agent answer body");
        expect(formatted).not.toContain("short summary");
    });

    it("with preferSummaryForAgentTurns=true, agent turns render the summary", () => {
        const now = Date.now();
        const messages: Memory[] = [
            makeMemory({ fromAgent: false, text: "user question", createdAt: now - 2000 }),
            makeMemory({
                fromAgent: true,
                text: "long agent answer body that should not appear",
                summary: "- short summary",
                createdAt: now - 1000,
            }),
        ];
        const formatted = formatMessages({
            messages,
            actors,
            agentId,
            preferSummaryForAgentTurns: true,
        });
        expect(formatted).toContain("user question");
        expect(formatted).toContain("short summary");
        expect(formatted).not.toContain("long agent answer body that should not appear");
    });

    it("user turns always render full text, never the summary key", () => {
        const now = Date.now();
        // A user turn that — for whatever reason — has a summary set in
        // metadata. The summary path is agent-only.
        const messages: Memory[] = [
            makeMemory({
                fromAgent: false,
                text: "user question with full body",
                summary: "- not used",
                createdAt: now - 1000,
            }),
        ];
        const formatted = formatMessages({
            messages,
            actors,
            agentId,
            preferSummaryForAgentTurns: true,
        });
        expect(formatted).toContain("user question with full body");
        expect(formatted).not.toContain("not used");
    });

    it("falls back to full agent text when the summary is empty", () => {
        const now = Date.now();
        const messages: Memory[] = [
            makeMemory({
                fromAgent: true,
                text: "agent body fallback",
                summary: "",
                createdAt: now - 1000,
            }),
        ];
        const formatted = formatMessages({
            messages,
            actors,
            agentId,
            preferSummaryForAgentTurns: true,
        });
        expect(formatted).toContain("agent body fallback");
    });

    it("ignores summary when preferSummaryForAgentTurns is omitted (default false)", () => {
        const now = Date.now();
        const messages: Memory[] = [
            makeMemory({
                fromAgent: true,
                text: "agent body present",
                summary: "- compact",
                createdAt: now - 1000,
            }),
        ];
        const formatted = formatMessages({ messages, actors, agentId });
        expect(formatted).toContain("agent body present");
        expect(formatted).not.toContain("compact");
    });
});
