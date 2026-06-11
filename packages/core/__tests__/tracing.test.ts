import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    type ReadableSpan,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
    initTracing,
    isTracingEnabled,
    setDecisionOutcome,
    spanFromProcessingStep,
    traceNode,
    withSpan,
} from "../src/utils/tracing.ts";

// §4 GEAP Observability. tracing.ts is default-OFF (gated on OTEL_TRACING_ENABLED)
// so merging it cannot change the AWS deployment's behavior. These tests exercise
// BOTH the disabled no-op contract (the load-bearing isolation guarantee) and the
// enabled span behavior against a REAL in-memory OTel exporter (not a mock of our
// code) — proving spans actually carry the `decision.outcome` attribute and the
// `Trading: …` step events the Optimizer (§5) and Cloud Trace filters depend on.

const exporter = new InMemorySpanExporter();

beforeAll(() => {
    const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
    exporter.reset();
    delete process.env.OTEL_TRACING_ENABLED;
});

afterAll(() => {
    delete process.env.OTEL_TRACING_ENABLED;
});

function enable(): void {
    process.env.OTEL_TRACING_ENABLED = "true";
}

function parentIdOf(span: ReadableSpan): string | undefined {
    // OTel JS 2.x exposes parentSpanContext; older exposed parentSpanId.
    return (
        (span as unknown as { parentSpanContext?: { spanId: string } })
            .parentSpanContext?.spanId ??
        (span as unknown as { parentSpanId?: string }).parentSpanId
    );
}

describe("tracing — default-off contract (AWS isolation)", () => {
    it("isTracingEnabled reflects OTEL_TRACING_ENABLED", () => {
        expect(isTracingEnabled()).toBe(false);
        enable();
        expect(isTracingEnabled()).toBe(true);
    });

    it("withSpan runs fn (no span) and returns its value when disabled, emitting NO spans", async () => {
        const result = await withSpan("handler:routeMessage", { a: 1 }, async (span) => {
            expect(span).toBeUndefined();
            return 42;
        });
        expect(result).toBe(42);
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it("spanFromProcessingStep / setDecisionOutcome / traceNode are safe no-ops when disabled", async () => {
        expect(() =>
            spanFromProcessingStep({ name: "Trading: risk check", status: "completed" }),
        ).not.toThrow();
        expect(() => setDecisionOutcome("risk_block")).not.toThrow();
        const node = traceNode("initialize", async (s: { n: number }) => ({ n: s.n + 1 }));
        expect(await node({ n: 1 })).toEqual({ n: 2 });
        expect(exporter.getFinishedSpans()).toHaveLength(0);
    });

    it("initTracing resolves and starts no SDK when disabled", async () => {
        await expect(initTracing()).resolves.toBeUndefined();
    });

    it("traceNode forwards all arguments (e.g. LangGraph's config) to the wrapped node", async () => {
        const node = traceNode(
            "n",
            async (state: { x: number }, config?: { tag: string }) => ({
                x: state.x,
                tag: config?.tag,
            }),
        );
        expect(await node({ x: 1 }, { tag: "cfg" })).toEqual({ x: 1, tag: "cfg" });
    });
});

describe("tracing — enabled span behavior (real in-memory exporter)", () => {
    it("withSpan creates a named span carrying its attributes and returns the fn value", async () => {
        enable();
        const result = await withSpan("handler:routeMessage", { "message.id": "m1" }, async () => "ok");
        expect(result).toBe("ok");
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].name).toBe("handler:routeMessage");
        expect(spans[0].attributes["message.id"]).toBe("m1");
    });

    it("withSpan records the exception + ERROR status and rethrows", async () => {
        enable();
        await expect(
            withSpan("executeAction", undefined, async () => {
                throw new Error("kaboom");
            }),
        ).rejects.toThrow("kaboom");
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(1);
        expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
        expect(spans[0].events.some((e) => e.name === "exception")).toBe(true);
    });

    it("spanFromProcessingStep adds the step name as an event with status + decision verdict", async () => {
        enable();
        await withSpan("node:requestParameterReview", undefined, async () => {
            spanFromProcessingStep({
                name: "Trading: risk check",
                status: "completed",
                message: "Risk gate blocked the request",
                data: { decision: "block" },
            });
        });
        const span = exporter.getFinishedSpans()[0];
        const evt = span.events.find((e) => e.name === "Trading: risk check");
        expect(evt).toBeTruthy();
        expect(evt?.attributes?.["step.status"]).toBe("completed");
        expect(evt?.attributes?.["step.message"]).toBe("Risk gate blocked the request");
        expect(evt?.attributes?.["decision.verdict"]).toBe("block");
    });

    it("setDecisionOutcome sets the decision.outcome attribute on the active span", async () => {
        enable();
        await withSpan("node:requestParameterReview", undefined, async () => {
            setDecisionOutcome("risk_block");
        });
        expect(exporter.getFinishedSpans()[0].attributes["decision.outcome"]).toBe("risk_block");
    });

    it("traceNode produces a child span nested under the active parent span", async () => {
        enable();
        let parentId: string | undefined;
        await withSpan("handler:cexWorkflow", undefined, async (span) => {
            parentId = span?.spanContext().spanId;
            const node = traceNode("requestParameterReview", async (s: { x: number }) => ({
                x: s.x + 1,
            }));
            expect(await node({ x: 1 })).toEqual({ x: 2 });
        });
        const spans = exporter.getFinishedSpans();
        const child = spans.find((s) => s.name === "node:requestParameterReview");
        const parent = spans.find((s) => s.name === "handler:cexWorkflow");
        expect(child).toBeTruthy();
        expect(parent).toBeTruthy();
        expect(parentIdOf(child as ReadableSpan)).toBe(parent?.spanContext().spanId);
        expect(parentIdOf(child as ReadableSpan)).toBe(parentId);
    });
});
