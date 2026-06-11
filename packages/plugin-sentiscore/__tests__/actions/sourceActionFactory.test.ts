import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSourceAction } from "../../src/actions/_sourceActionFactory.ts";
import type { FetchFn } from "../../src/actions/_sourceActionFactory.ts";

// ── module mocks ───────────────────────────────────────────────────────────────

vi.mock("../../src/utils/cryptocurrencies.ts", () => ({
    identifyAsset: vi.fn(() => "BTC"),
}));

vi.mock("../../src/actions/combine.ts", () => ({
    getDateRangeFromRequest: vi.fn(() => ({
        startDate: "2026-04-01",
        endDate: "2026-04-30",
    })),
    SENTIMENT_ANALYSIS_SYSTEM: "mock system",
    computeSourceMetrics: vi.fn(() => ({
        total: 2,
        avg: 0.3,
        positive: 0.4,
        negative: 0.1,
        trend: "up",
        change: 0.05,
        volatility: 0.05,
    })),
    getCryptoData: vi.fn(async () => []),
    generateSentimentPNG: vi.fn(async () => Buffer.from("png")),
    generateChartHTML: vi.fn(() => "<html/>"),
    saveChartToFile: vi.fn(async () => "Charts/chart.png"),
}));

vi.mock("@elizaos/core", () => ({
    generateText: vi.fn(async () => "Mock LLM analysis result."),
    ModelClass: { MEDIUM: "medium" },
    createActionResponse: vi.fn((opts) => ({ ...opts, _type: "response" })),
    createActionErrorResponse: vi.fn((opts) => ({ ...opts, _type: "error" })),
    generateActionSummary: vi.fn(() => "Mock summary"),
    buildChartProxyUrl: vi.fn((p, _id) => `/proxy/${p}`),
    elizaLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("fs", async (importOriginal) => {
    const actual = (await importOriginal()) as typeof import("fs");
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        mkdirSync: vi.fn(),
        promises: {
            ...actual.promises,
            writeFile: vi.fn(async () => undefined),
        },
    };
});

// ── helpers ────────────────────────────────────────────────────────────────────

function makeRuntime(overrides: Record<string, unknown> = {}) {
    return {
        agentId: "agent-1",
        shouldStop: vi.fn(() => false),
        ...overrides,
    } as any;
}

function makeMessage(text = "BTC sentiment") {
    return { content: { text } } as any;
}

// Scores that fall within 2026-04-01 .. 2026-04-30
const APRIL_TS = Math.floor(new Date("2026-04-15T12:00:00Z").getTime() / 1000);
const VALID_SCORES = [
    { time: APRIL_TS, value: 0.3, total: 10 },
    { time: APRIL_TS + 3600, value: 0.2, total: 5 },
];

function makeFetch(sentiScores: object[]): FetchFn {
    return vi.fn(async () =>
        new Response(JSON.stringify({ sentiScores }), {
            headers: { "content-type": "application/json" },
        })
    ) as unknown as FetchFn;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("makeSourceAction — happy path", () => {
    it("calls callback with response containing text and (empty) chartPath when getCryptoData returns []", async () => {
        const fetchFn = makeFetch(VALID_SCORES);
        const action = makeSourceAction({
            name: "Test_Sentiment",
            description: "test",
            sourceLabel: "Test",
            sourceType: "test",
            color: "rgb(0, 0, 255)",
            fetchFn,
            examples: [],
        });

        const callback = vi.fn(async () => []);
        const result = await action.handler!(
            makeRuntime(),
            makeMessage(),
            {} as any,
            {},
            callback
        );

        expect(result).toBe(true);
        expect(callback).toHaveBeenCalledOnce();
        const arg = callback.mock.calls[0][0] as any;
        // should be a success response (not error)
        expect(arg._type).toBe("response");
        expect(arg.text).toContain("Test Sentiment Analysis");
        expect(arg.text).toContain("Mock LLM analysis result.");
    });

    it("includes chartPath in callback when saveChartToFile succeeds", async () => {
        const { getCryptoData, saveChartToFile } = await import(
            "../../src/actions/combine.ts"
        );
        vi.mocked(getCryptoData).mockResolvedValueOnce([{ time: APRIL_TS, price: 50000 }] as any);
        vi.mocked(saveChartToFile).mockResolvedValueOnce("Charts/chart.png");

        const { buildChartProxyUrl } = await import("@elizaos/core");
        vi.mocked(buildChartProxyUrl).mockReturnValueOnce("/proxy/Charts/chart.png");

        const fetchFn = makeFetch(VALID_SCORES);
        const action = makeSourceAction({
            name: "Test_Sentiment",
            description: "test",
            sourceLabel: "Test",
            sourceType: "test",
            color: "rgb(0,0,0)",
            fetchFn,
            examples: [],
        });

        const callback = vi.fn(async () => []);
        await action.handler!(makeRuntime(), makeMessage(), {} as any, {}, callback);

        const arg = callback.mock.calls[0][0] as any;
        expect(arg._type).toBe("response");
        expect(arg.chartPath).toBe("/proxy/Charts/chart.png");
    });
});

describe("makeSourceAction — error paths", () => {
    it("calls error callback when fetchFn response contains data.error", async () => {
        const fetchFn: FetchFn = vi.fn(async () =>
            new Response(JSON.stringify({ error: "S3 fetch failed" }), {
                headers: { "content-type": "application/json" },
            })
        ) as unknown as FetchFn;

        const action = makeSourceAction({
            name: "Test_Sentiment",
            description: "test",
            sourceLabel: "Test",
            sourceType: "test",
            color: "rgb(0,0,0)",
            fetchFn,
            examples: [],
        });

        const callback = vi.fn(async () => []);
        const result = await action.handler!(
            makeRuntime(),
            makeMessage(),
            {} as any,
            {},
            callback
        );

        expect(result).toBe(true);
        const arg = callback.mock.calls[0][0] as any;
        expect(arg._type).toBe("error");
    });

    it("calls error callback when no scores fall in the date range", async () => {
        // Scores from year 2020 — well outside 2026-04-01..30
        const oldTs = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
        const fetchFn = makeFetch([{ time: oldTs, value: 0.5, total: 1 }]);

        const action = makeSourceAction({
            name: "Test_Sentiment",
            description: "test",
            sourceLabel: "Test",
            sourceType: "test",
            color: "rgb(0,0,0)",
            fetchFn,
            examples: [],
        });

        const callback = vi.fn(async () => []);
        const result = await action.handler!(
            makeRuntime(),
            makeMessage(),
            {} as any,
            {},
            callback
        );

        expect(result).toBe(true);
        const arg = callback.mock.calls[0][0] as any;
        expect(arg._type).toBe("error");
        expect(arg.text).toMatch(/No Test sentiment data found/i);
    });

    it("calls error callback when fetchFn throws", async () => {
        const fetchFn: FetchFn = vi.fn(async () => {
            throw new Error("network error");
        }) as unknown as FetchFn;

        const action = makeSourceAction({
            name: "Test_Sentiment",
            description: "test",
            sourceLabel: "Test",
            sourceType: "test",
            color: "rgb(0,0,0)",
            fetchFn,
            examples: [],
        });

        const callback = vi.fn(async () => []);
        const result = await action.handler!(
            makeRuntime(),
            makeMessage(),
            {} as any,
            {},
            callback
        );

        expect(result).toBe(false);
        const arg = callback.mock.calls[0][0] as any;
        expect(arg._type).toBe("error");
    });
});
