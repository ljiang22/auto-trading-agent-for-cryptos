/**
 * §4 GEAP Agent Observability — OpenTelemetry tracing for the SentiEdge agent.
 *
 * DEFAULT-OFF. Everything here is gated on `OTEL_TRACING_ENABLED === "true"`. When the
 * env var is unset (the AWS production/staging default) every export is a hard no-op:
 * `withSpan` calls its callback directly, the span helpers return immediately, and
 * `initTracing` never imports the heavy OpenTelemetry SDK. So merging this module cannot
 * change the behavior of the AWS deployment — mirroring the env-gating pattern used by
 * `langsmith.ts` (`isLangSmithTracingEnabled`).
 *
 * Only the lightweight `@opentelemetry/api` package is imported at module load. It is inert
 * without a registered TracerProvider (returns no-op spans), so the static import is safe.
 * The SDK + Cloud Trace exporter + auto-instrumentations are loaded lazily inside
 * `initTracing()` so they cost nothing when tracing is disabled.
 *
 * Goal: turn the existing `ProcessingStep` instrumentation into a queryable trace/DAG in
 * Cloud Trace, so the "execute vs. block/await" oscillation at the CEX conflict node
 * (cexWorkflowMessageHandler.ts) becomes a filterable `decision.outcome` dimension.
 */

import {
    type Attributes,
    type AttributeValue,
    type Span,
    SpanStatusCode,
    trace,
} from "@opentelemetry/api";
import { elizaLogger } from "./logger.ts";

const TRACER_NAME = "sentiedge-agent";

/** Whether OTel tracing is active. Cf. `isLangSmithTracingEnabled()` in langsmith.ts. */
export function isTracingEnabled(): boolean {
    return process.env.OTEL_TRACING_ENABLED === "true";
}

// SDK handle + once-only guard (mirrors langsmith.ts's cached singleton + envInitialized flag).
let sdk: { shutdown: () => Promise<void> } | undefined;
let initialized = false;

/**
 * Start the OpenTelemetry Node SDK with the Cloud Trace exporter (ADC auth) and Node
 * auto-instrumentations. No-op when disabled or already initialized. Heavy deps are
 * imported lazily here so the disabled path never loads them. Never throws — a failed
 * init logs a warning and leaves the process untraced rather than crashing startup.
 */
export async function initTracing(): Promise<void> {
    if (!isTracingEnabled() || initialized) return;
    initialized = true;
    try {
        const { NodeSDK } = await import("@opentelemetry/sdk-node");
        const { getNodeAutoInstrumentations } = await import(
            "@opentelemetry/auto-instrumentations-node"
        );
        const { TraceExporter } = await import(
            "@google-cloud/opentelemetry-cloud-trace-exporter"
        );
        const instance = new NodeSDK({
            traceExporter: new TraceExporter(),
            instrumentations: [getNodeAutoInstrumentations()],
        });
        instance.start();
        sdk = instance;
        elizaLogger.info(
            `OpenTelemetry tracing enabled (service="${TRACER_NAME}", exporter=Cloud Trace)`,
        );
    } catch (err) {
        initialized = false;
        elizaLogger.warn(
            `OpenTelemetry tracing failed to initialize; continuing untraced: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
    }
}

/** Flush + stop the SDK (best-effort; for graceful shutdown / tests). */
export async function shutdownTracing(): Promise<void> {
    if (sdk) {
        try {
            await sdk.shutdown();
        } catch {
            /* ignore shutdown errors */
        }
    }
    sdk = undefined;
    initialized = false;
}

function tracer() {
    return trace.getTracer(TRACER_NAME);
}

function applyAttributes(span: Span, attrs?: Attributes): void {
    if (!attrs) return;
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        span.setAttribute(key, value);
    }
}

/**
 * Run `fn` inside an active span named `name` carrying `attrs`. When tracing is disabled
 * this is transparent: `fn(undefined)` is called directly with no span allocated. Exceptions
 * are recorded on the span (status ERROR) and rethrown; the span is always ended.
 */
export async function withSpan<T>(
    name: string,
    attrs: Attributes | undefined,
    fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
    if (!isTracingEnabled()) return fn(undefined);
    return tracer().startActiveSpan(name, async (span) => {
        applyAttributes(span, attrs);
        try {
            return await fn(span);
        } catch (err) {
            span.recordException(err as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
            });
            throw err;
        } finally {
            span.end();
        }
    });
}

/** Set an attribute on the current active span (no-op when disabled / no active span). */
export function setSpanAttribute(key: string, value: AttributeValue): void {
    if (!isTracingEnabled()) return;
    trace.getActiveSpan()?.setAttribute(key, value);
}

/**
 * Set the `decision.outcome` attribute on the active span — the filterable dimension that
 * makes the decisive-signal-vs-risk-control conflict queryable in Cloud Trace
 * (e.g. `decision.outcome="risk_block"`). Values map to the CEX handler's terminal phases
 * (see CEX_PHASE_OUTCOME in cexWorkflowMessageHandler.ts — keep these two lists in sync):
 * `allow` | `approved` | `awaiting_approval` | `risk_block` | `freshness_block` | `rejected` |
 * `refused` | `executed` | `failed`.
 */
export function setDecisionOutcome(outcome: string): void {
    setSpanAttribute("decision.outcome", outcome);
}

/**
 * Bridge a `ProcessingStep` onto the current active span as a span event. Because every
 * CEX step funnels through `emitStep`, a single call there converts all `Trading: …` steps
 * into span events for free. No-op when disabled or when there is no active span.
 */
export function spanFromProcessingStep(step: {
    name: string;
    status: string;
    message?: string;
    data?: { decision?: unknown } & Record<string, unknown>;
}): void {
    if (!isTracingEnabled()) return;
    const span = trace.getActiveSpan();
    if (!span) return;
    const attrs: Attributes = { "step.status": step.status };
    if (step.message) attrs["step.message"] = step.message;
    const decision = step.data?.decision;
    if (decision !== undefined && decision !== null) {
        attrs["decision.verdict"] = String(decision);
    }
    span.addEvent(step.name, attrs);
}

/**
 * Wrap a LangGraph node function so each invocation becomes a child span `node:<name>`
 * nested under the active handler-root span. Transparent when tracing is disabled. Applied
 * at the `.addNode(name, fn)` registration sites of the CEX + Comprehensive workflows.
 */
export function traceNode<S, R>(
    name: string,
    fn: (state: S, ...rest: unknown[]) => Promise<R>,
): (state: S, ...rest: unknown[]) => Promise<R> {
    // Forward every argument (LangGraph invokes nodes as `node(state, config)`) so wrapping
    // never drops a `config` a node might use.
    return (state: S, ...rest: unknown[]) =>
        withSpan(`node:${name}`, undefined, () => fn(state, ...rest));
}
