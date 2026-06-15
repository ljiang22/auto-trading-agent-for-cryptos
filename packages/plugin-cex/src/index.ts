import type {
    CEXAccountSnapshotInput,
    CEXAccountSnapshotOutput,
    CEXAnaphoricOrderIdInput,
    CEXAnaphoricOrderIdOutput,
    CEXMemoryRouterInput,
    CEXMemoryRouterOutput,
    CEXRerankKnowledgeInput,
    CEXRerankKnowledgeOutput,
    CEXRiskDecision,
    CEXRiskPrecheckInput,
    CEXSymbolForOrderIdInput,
    CEXSymbolForOrderIdOutput,
    CEXTradableProductsInput,
    CEXTradableProductsOutput,
    CEXTradingEventInput,
    CEXTradingSubAgentInput,
    CEXTradingSubAgentResult,
    CEXUserOpenOrder,
    CEXUserOpenOrdersInput,
    IAgentRuntime,
    Plugin,
} from "@elizaos/core";
import { tradeActions } from "./actions";
import {
    createPaperVenueForRuntime,
    getUserTradingMode,
    resolveExchangeCredentials,
    validateApprovedActionParams,
} from "./actions/shared";
import { createExchangeService } from "./exchanges/registry";
import {
    formatCEXActionForLLM,
    getCEXActionSchema,
    getCEXActionSchemaForApproval,
    getCEXCanonicalSpec,
} from "./spec/canonical";
import { buildCanonicalIntent } from "./intent/intentBuilder";
import {
    formatApprovalInterruptTitle,
    formatOrderNlFromParams,
    formatOrderSummaryShort,
} from "./nl/orderNl";
import {
    crossCheckUserIntent,
    extractAssetMentions,
} from "./intent/promptNumericExtractor";
import {
    fetch24hStats,
    fetchBookTicker,
    fetchDepth,
} from "./exchanges/services/binancePricing";
import {
    fetch24hStatsForVenue,
    fetchBookTickerForVenue,
    fetchDepthForVenue,
} from "./marketdata/venuePricingDispatcher";
import { evaluate as evaluateRisk } from "./risk/riskEngine";
import { buildRiskDecisionRecord } from "./risk/auditLog";
import { getRiskAuditSink } from "./safety/auditSinkRegistry";
import {
    checkTradingHealth as checkTradingHealthImpl,
    renderFailClosedMessage as renderFailClosedMessageImpl,
} from "./safety/dependencyHealth";
import { checkExistingOrder as checkExistingOrderImpl } from "./idempotency/preSubmitDedup";
import { getApprovalDecisionSink } from "./safety/approvalSinkRegistry";
import {
    DEFAULT_USER_TRADING_PREFERENCES,
    type RiskDecisionRecord,
    type UserTradingPreferences,
} from "./risk/types";
import { elizaLogger } from "@elizaos/core";
import {
    resolveAllOrdersFromContext,
    resolveAnaphoricOrderId,
    resolveSymbolForOrderId,
} from "./orderContext/anaphoricResolver";
import { runTradingSubAgent, runTradingSubAgentSafe } from "./adk/langGraphBridge";
import { emitRiskCheck } from "./observability/tradingEvents";
import { routeMemory } from "./memory/memoryRouter";
import { hybridRetrieve } from "./ranking/hybridRetriever";
import type { KbDocument } from "./ranking/types";
import type { ExchangeName } from "./types";
import { runWithVenueCallContext } from "./observability/venueCallContext";
import {
    getMarketDataAgeMs as getMarketDataAgeMsImpl,
    recordMarketDataSample,
} from "./reconciliation/marketDataAge";
import {
    fetchPublicMidPrice,
    fetchPublicTradableProducts,
} from "./marketdata/publicMarketData";
import { fetchBinanceSymbolFilters } from "./exchanges/services/binanceSymbolInfo";

/**
 * Best-effort notional estimate from the canonical intent so `maxOrderSize`
 * / `exposureCap` rules don't silently skip when the handler didn't pre-compute.
 * - `quote_size` (e.g. "spend $50 USDT") is taken directly.
 * - `base_size * limit_price` (limit orders) is the deterministic fallback.
 * - Market orders without a caller-supplied mid-price return undefined, which
 *   leaves the rule in "skipped" mode with its explanatory note (covered by
 *   balance checks downstream). The handler should still pass
 *   `estimated_notional_usd` when a ticker price is available.
 */
function deriveEstimatedNotionalUsd(
    intent: ReturnType<typeof buildCanonicalIntent>,
): number | undefined {
    if (intent.action !== "create_order" && intent.action !== "preview_order") {
        return undefined;
    }
    const quoteRaw = intent.size?.quote_size;
    if (typeof quoteRaw === "string" && quoteRaw.trim().length > 0) {
        const q = Number.parseFloat(quoteRaw);
        if (Number.isFinite(q) && q > 0) return q;
    }
    const baseRaw = intent.size?.base_size;
    const priceRaw = intent.price_params?.limit_price;
    if (
        typeof baseRaw === "string" &&
        typeof priceRaw === "string" &&
        baseRaw.trim().length > 0 &&
        priceRaw.trim().length > 0
    ) {
        const b = Number.parseFloat(baseRaw);
        const p = Number.parseFloat(priceRaw);
        if (Number.isFinite(b) && Number.isFinite(p) && b > 0 && p > 0) return b * p;
    }
    return undefined;
}

async function runRiskPrecheck(
    input: CEXRiskPrecheckInput,
): Promise<CEXRiskDecision | null> {
    const riskCheckStartedAt = Date.now();
    try {
        const intent = buildCanonicalIntent({
            action: input.action as never,
            venue: input.venue as ExchangeName,
            userId: input.userId,
            locale: input.locale,
            mode: input.mode,
            params: input.params as never,
        });
        // F4 — stamp the pre-execution USD estimate onto the intent BEFORE
        // calling the risk engine or any emit*() that surfaces intentFields.
        // The risk engine still receives it through its own input shape; this
        // duplicate write is what gets serialized into `[Trading]` events.
        const estimatedNotionalUsd =
            input.estimated_notional_usd ?? deriveEstimatedNotionalUsd(intent);
        intent.notional_usd_estimated = estimatedNotionalUsd;
        const preferences: UserTradingPreferences = {
            userId: input.userId,
            ...DEFAULT_USER_TRADING_PREFERENCES,
            ...(input.preferences ?? {}),
            updatedAt: new Date().toISOString(),
        } as UserTradingPreferences;
        // Fix 11 — when the caller passes a `market_data_age_ms` override
        // (Confirm-time re-check), surface it to the rule ctx so the
        // `marketDataFreshness` rule doesn't fire on a stale review-time
        // value. Untouched on the normal review-time path.
        const decision = evaluateRisk(
            intent,
            {
                preferences,
                unknown_state_orders_on_pair: input.unknown_state_orders_on_pair ?? 0,
                estimated_notional_usd: estimatedNotionalUsd,
                market_mid_usd: input.market_mid_usd,
                ...(input.market_data_age_ms !== undefined
                    ? { market_data_age_ms: input.market_data_age_ms }
                    : {}),
            },
            input.rules_to_run,
        );

        // §6.1 — persist the verdict before returning. Audit-write failure
        // is structurally observable: `audit_wrote_ok=false` propagates to
        // the handler's dep-health gate, which fail-closes live writes.
        let auditWroteOk: boolean | null = null;
        const sink = getRiskAuditSink();
        if (sink) {
            try {
                const record: RiskDecisionRecord = buildRiskDecisionRecord(
                    intent,
                    decision,
                );
                await sink.writeDecision(record);
                auditWroteOk = true;
            } catch (err) {
                elizaLogger.error(
                    `[plugin-cex] risk_decisions write failed — fail-closed gate will engage for live mode: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
                auditWroteOk = false;
            }
        }
        // F4 — explicit `risk_check` emit with full 12-field envelope +
        // latency_ms. emitRiskCheck consumes intentFields(intent) which
        // now carries stake + notional_usd.
        try {
            emitRiskCheck(intent, decision, Date.now() - riskCheckStartedAt);
        } catch (err) {
            elizaLogger.warn(
                `[plugin-cex] emitRiskCheck failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        return {
            verdict: decision.verdict,
            rules_fired: decision.rules_fired,
            explanations: decision.explanations,
            audit_wrote_ok: auditWroteOk,
            request_id: intent.request_id,
            intent_hash: intent.idempotency.intent_hash,
        };
    } catch {
        return null;
    }
}

function readResubmitNonce(params: Record<string, unknown>): string | undefined {
    const raw = params._idempotency_resubmit_nonce;
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function deriveClientOrderIdFromInput(
    input: Omit<CEXRiskPrecheckInput, "preferences">,
): string | null {
    try {
        const intent = buildCanonicalIntent({
            action: input.action as never,
            venue: input.venue as ExchangeName,
            userId: input.userId,
            locale: input.locale,
            params: input.params as never,
            resubmitNonce: readResubmitNonce(input.params as Record<string, unknown>),
        });
        return intent.idempotency.client_order_id;
    } catch {
        return null;
    }
}

function deriveIdempotencyFromInput(
    input: Omit<CEXRiskPrecheckInput, "preferences">,
): { client_order_id: string; intent_hash: string } | null {
    try {
        const intent = buildCanonicalIntent({
            action: input.action as never,
            venue: input.venue as ExchangeName,
            userId: input.userId,
            locale: input.locale,
            params: input.params as never,
            resubmitNonce: readResubmitNonce(input.params as Record<string, unknown>),
        });
        return {
            client_order_id: intent.idempotency.client_order_id,
            intent_hash: intent.idempotency.intent_hash,
        };
    } catch {
        return null;
    }
}

/**
 * Fix 7 — plan-time canonical-intent validator. Wraps `buildCanonicalIntent`
 * which parses through `canonicalIntentSchema`. Schema rejections (e.g.
 * `base_size: "0"` failing `positiveDecimalString`) surface as a one-line
 * zod-style error so the planner can mark the step `failed` BEFORE the
 * plan is persisted.
 */
function validateCanonicalIntentFromCore(input: {
    action: string;
    venue: string;
    userId: string;
    locale: "en" | "zh-CN" | "mixed-en";
    params: Record<string, unknown>;
    mode?: "live" | "paper" | "shadow";
}): { ok: true } | { ok: false; error: string } {
    try {
        buildCanonicalIntent({
            action: input.action as never,
            venue: input.venue as ExchangeName,
            userId: input.userId,
            locale: input.locale,
            mode: input.mode,
            params: input.params as never,
        });
        return { ok: true };
    } catch (err) {
        // ZodError carries an `issues` array; pluck the first message so the
        // planner can attach a one-liner to the step's error column.
        const zodIssues = (err as { issues?: Array<{ message?: string; path?: Array<string | number> }> })
            .issues;
        if (Array.isArray(zodIssues) && zodIssues.length > 0) {
            const issue = zodIssues[0];
            const path =
                Array.isArray(issue.path) && issue.path.length > 0
                    ? `${issue.path.join(".")}: `
                    : "";
            return {
                ok: false,
                error: `${path}${issue.message ?? "schema validation failed"}`,
            };
        }
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Fix 7 — fetch per-symbol filters via the public exchangeInfo endpoint.
 * Currently Binance-only; Coinbase has no equivalent server-side
 * min-notional / status surface (every product is "online" or absent).
 * Returns null for unsupported venues so the planner can degrade
 * gracefully — the execute-time path remains authoritative.
 */
async function fetchSymbolFiltersFromCore(input: {
    venue: string;
    symbol: string;
}): Promise<
    | {
          status?: string;
          minNotional?: string;
          minQty?: string;
          stepSize?: string;
          tickSize?: string;
      }
    | null
> {
    const venue = (input.venue ?? "").toLowerCase();
    if (venue !== "binance") return null;
    const filters = await fetchBinanceSymbolFilters(input.symbol);
    if (!filters) return null;
    return {
        status: filters.status,
        minNotional: filters.minNotional,
        minQty: filters.minQty,
        stepSize: filters.stepSize,
        tickSize: filters.tickSize,
    };
}

/**
 * Structured trading-lifecycle emitter exposed to core. Writes a single
 * `[Trading]` log line per call, suitable for CloudWatch metric filters
 * (autotrading-uplift §1.6 / §Cross-cutting #3).
 */
function emitTradingEventFromCore(event: CEXTradingEventInput): void {
    try {
        const payload = { ...event, timestamp: new Date().toISOString() };
        const line = `[Trading] ${JSON.stringify(payload)}`;
        const stage = event.stage;
        if (stage === "order_error") elizaLogger.error(line);
        else elizaLogger.info(line);
    } catch {
        // Never throw from observability hooks.
    }
}

function buildAdkBridgeInput(input: CEXTradingSubAgentInput) {
    return {
        message: input.message,
        forcedTool: input.forcedTool as never,
        parameterHints: input.parameterHints,
        requestId: input.requestId,
        context: {
            userId: input.userId,
            locale: input.locale,
            stake: input.stake,
            venue: input.venue as ExchangeName,
            mode: input.mode ?? "live",
            killSwitchActive: input.killSwitchActive ?? false,
            // F7-r3 — pass the IAgentRuntime through to the ADK so the
            // async `runTradingSubAgentSafe` can run the LLM extractor
            // and enrich the canonical intent. Stays `unknown`-typed
            // here per the AdkRuntimeContext declaration.
            runtime: input.runtime,
        },
    };
}

function projectAdkResult(
    result: Awaited<ReturnType<typeof runTradingSubAgentSafe>>,
): CEXTradingSubAgentResult | null {
    if (!result) return null;
    if (result.kind === "clarification_question") {
        return {
            kind: "clarification_question",
            text: result.text,
            locale: result.locale,
            tool: result.tool,
        };
    }
    const { intent, tool, extractedInput } = result;
    const params: Record<string, unknown> = {
        userId: intent.user_id,
        exchange: intent.venue,
        product_id: intent.symbol,
        symbol: intent.symbol,
        side: intent.side,
        order_configuration: intent.raw_order_configuration,
        client_order_id: intent.idempotency.client_order_id,
        intent_hash: intent.idempotency.intent_hash,
        request_id: intent.request_id,
    };
    if (intent.action === "get_balance") {
        // Issue 4 (post-PR237 hotfix) — surface the ADK-extracted
        // wallet_type to the venue service. Without this the read-only
        // fast path always fanned out across all four wallets, even
        // when the user explicitly asked for one (e.g. "show my spot
        // balance"). The decomposer LLM already emits this for
        // multi-step plans; here we plumb the synchronous fast path
        // through the same canonical field.
        const walletType = extractedInput.wallet_type;
        if (
            walletType === "spot" ||
            walletType === "funding" ||
            walletType === "margin_cross" ||
            walletType === "margin_isolated" ||
            walletType === "all"
        ) {
            params.wallet_type = walletType;
        }
    }
    if (intent.action === "cancel_order") {
        // Read the full list the regex extractor surfaced so
        // "cancel order N1, N2" makes BOTH ids land in the
        // approval modal, not just the first. Falls back to the
        // legacy singular field for older ADK call sites.
        const ids = Array.isArray(extractedInput.order_ids)
            ? (extractedInput.order_ids as unknown[]).filter(
                  (v): v is string => typeof v === "string" && v.length > 0,
              )
            : typeof extractedInput.order_id === "string"
              ? [extractedInput.order_id]
              : [];
        if (ids.length > 0) {
            params.order_ids = ids;
            params.cancel_order_id = ids[0];
        }
    }
    if (intent.action === "amend_order") {
        const orderId =
            typeof extractedInput.order_id === "string"
                ? extractedInput.order_id
                : undefined;
        if (orderId) params.orderId = orderId;
        if (typeof extractedInput.new_limit_price === "string") {
            params.price = extractedInput.new_limit_price;
        }
        if (typeof extractedInput.new_base_size === "string") {
            params.size = extractedInput.new_base_size;
        }
    }
    return {
        kind: "canonical_intent",
        tool,
        action: intent.action,
        params,
        locale: intent.locale,
    };
}

function runTradingSubAgentFromCore(
    input: CEXTradingSubAgentInput,
): CEXTradingSubAgentResult | null {
    try {
        return projectAdkResult(runTradingSubAgent(buildAdkBridgeInput(input)));
    } catch {
        return null;
    }
}

async function runTradingSubAgentSafeFromCore(
    input: CEXTradingSubAgentInput,
): Promise<CEXTradingSubAgentResult | null> {
    try {
        const result = await runTradingSubAgentSafe(buildAdkBridgeInput(input));
        return projectAdkResult(result);
    } catch {
        return null;
    }
}

function resolveAnaphoricOrderIdFromCore(
    input: CEXAnaphoricOrderIdInput,
): CEXAnaphoricOrderIdOutput | null {
    try {
        return resolveAnaphoricOrderId({
            messageText: input.messageText,
            locale: input.locale,
            recentAssistantMemories: input.recentAssistantMemories,
            venue: input.venue ?? null,
        });
    } catch {
        return null;
    }
}

function resolveAllOrdersFromContextFromCore(
    input: CEXAnaphoricOrderIdInput,
): { orders: Array<{ order_id: string; symbol?: string }>; sourceMemoryId: string } | null {
    try {
        return resolveAllOrdersFromContext({
            messageText: input.messageText,
            locale: input.locale,
            recentAssistantMemories: input.recentAssistantMemories,
            venue: input.venue ?? null,
        });
    } catch {
        return null;
    }
}

function resolveSymbolForOrderIdFromCore(
    input: CEXSymbolForOrderIdInput,
): CEXSymbolForOrderIdOutput | null {
    try {
        return resolveSymbolForOrderId({
            orderId: input.orderId,
            recentAssistantMemories: input.recentAssistantMemories,
            venue: input.venue ?? null,
        });
    } catch {
        return null;
    }
}

function rerankKnowledgeCandidatesFromCore(
    input: CEXRerankKnowledgeInput,
): CEXRerankKnowledgeOutput {
    try {
        const docs: KbDocument[] = input.candidates.map((c) => ({
            id: c.id,
            text: c.text,
            embedding: c.embedding,
            trust_tier: c.trustTier ?? "B",
            publishedAt: c.publishedAt ?? new Date().toISOString(),
            symbols: c.symbols,
        }));
        const ranked = hybridRetrieve(docs, {
            text: input.query,
            embedding: input.queryEmbedding,
            portfolio_symbols: input.portfolioSymbols,
            topK: input.topK,
        });
        return {
            rankedIds: ranked.map((r) => r.doc.id),
            scores: Object.fromEntries(ranked.map((r) => [r.doc.id, r.score])),
        };
    } catch {
        return { rankedIds: input.candidates.slice(0, input.topK).map((c) => c.id) };
    }
}

/**
 * 2026-05-25 hardening (QA L-2 / L-3) — paper-mode account snapshot.
 * Mirrors `fetchAccountSnapshotFromCore`'s output shape but reads from
 * the user's paper venue (initial $10k USD ledger) instead of the live
 * exchange. USD / USDT / USDC are treated equivalently when looking
 * up the quote balance, matching how the chat-balance renderer treats
 * the paper Spot wallet.
 *
 * Returns `null` on any failure; the caller falls back to the live
 * path.
 */
async function fetchPaperAccountSnapshot(
    input: CEXAccountSnapshotInput,
    base: string,
    quote: string,
): Promise<CEXAccountSnapshotOutput | null> {
    const realVenue = (input.venue || "binance").toLowerCase();
    try {
        const paperVenue = await createPaperVenueForRuntime(input.runtime, realVenue);
        const balanceRaw = (await paperVenue.accounts.getBalance({
            userId: input.userId,
            limit: undefined,
            cursor: undefined,
            retail_portfolio_id: undefined,
        } as never)) as
            | { accounts?: Array<{ asset?: string; available?: string; locked?: string }> }
            | undefined;
        const rows = Array.isArray(balanceRaw?.accounts) ? balanceRaw!.accounts! : [];

        const lookup = (asset: string): string => {
            const STABLE_USD_EQUIVALENTS = new Set(["USD", "USDT", "USDC"]);
            const wanted = STABLE_USD_EQUIVALENTS.has(asset)
                ? STABLE_USD_EQUIVALENTS
                : new Set([asset]);
            for (const row of rows) {
                const rowAsset = String(row?.asset ?? "").toUpperCase();
                if (wanted.has(rowAsset) && typeof row?.available === "string") return row.available;
            }
            return "0";
        };

        const baseAvailable = lookup(base);
        const quoteAvailable = lookup(quote);

        elizaLogger.info(
            `[plugin-cex] fetchPaperAccountSnapshot RESULT venue=paper base=${base}:${baseAvailable} quote=${quote}:${quoteAvailable} rows=${rows.length}`,
        );

        return {
            baseAvailable,
            quoteAvailable,
            baseAsset: base,
            quoteAsset: quote,
            feeBps: 10,
        };
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] fetchPaperAccountSnapshot FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        );
        return null;
    }
}

/**
 * Fetch a Binance/Coinbase-shape account balance snapshot for the
 * approval-modal Avbl / Max Buy / Est Fee block. Re-uses the
 * existing `ExchangeService.accounts.getBalance` so the wire format
 * matches what the rest of the plugin already understands. Returns
 * `null` on any failure (no credentials, rate-limited, parse error)
 * — the modal renders the order without these fields rather than
 * blocking the approval flow.
 */
async function fetchAccountSnapshotFromCore(
    input: CEXAccountSnapshotInput,
): Promise<CEXAccountSnapshotOutput | null> {
    try {
        const base = (input.baseAsset || "").trim().toUpperCase();
        const quote = (input.quoteAsset || "").trim().toUpperCase();
        if (!base || !quote) return null;

        // 2026-05-25 hardening (QA L-2 / L-3) — route paper-mode users to
        // the paper venue's balance instead of the real exchange. The
        // approval modal's "Avbl" / "Max Buy" / "Est Fee" strip is what
        // shipped before this fix; it was reading real-exchange spot
        // balances under PAPER mode (the QA repro: identical 582.4 USDT
        // across BTC-USDT and LUNA-USDT previews).
        const mode = await getUserTradingMode(input.runtime, input.userId).catch(() => "live");
        if (mode === "paper") {
            const paperSnapshot = await fetchPaperAccountSnapshot(input, base, quote);
            if (paperSnapshot) return paperSnapshot;
            // Defensive: if the paper-venue lookup fails for any reason,
            // fall through to the existing live-credentials path rather
            // than blanking the modal. The modal renders without balance
            // when both fail, which is the previous behaviour.
        }

        const preferExchangeId = input.venue
            ? (input.venue.toLowerCase() as never)
            : undefined;
        const creds = await resolveExchangeCredentials(input.runtime, input.userId, {
            preferExchangeId,
        });
        const service = createExchangeService({
            exchange: creds.exchange,
            authType: creds.authType,
            auth: creds.auth,
        });

        // The 2.5 s ceiling keeps a slow venue from blocking the modal —
        // Binance is typically <300 ms; Coinbase <600 ms.
        const balancePromise = service.accounts.getBalance({
            userId: input.userId,
            limit: undefined,
            cursor: undefined,
            retail_portfolio_id: undefined,
        } as never);
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("balance-fetch-timeout")), 2_500),
        );
        const balanceRaw = (await Promise.race([balancePromise, timeout])) as
            | { accounts?: Array<Record<string, unknown>> }
            | undefined;

        let baseAvailable = "0";
        let quoteAvailable = "0";

        const accounts = balanceRaw?.accounts;
        if (Array.isArray(accounts)) {
            // Spot wallet wins over funding for the available-balance read.
            const pickValue = (asset: string): string | null => {
                const spot = accounts.find(
                    (a) =>
                        String(a.currency).toUpperCase() === asset &&
                        String(a.wallet_type ?? "spot") === "spot",
                );
                if (spot) {
                    const v = (spot.available_balance as { value?: unknown } | undefined)
                        ?.value;
                    if (typeof v === "string" || typeof v === "number") return String(v);
                }
                const fallback = accounts.find(
                    (a) => String(a.currency).toUpperCase() === asset,
                );
                if (fallback) {
                    const v = (fallback.available_balance as { value?: unknown } | undefined)
                        ?.value;
                    if (typeof v === "string" || typeof v === "number") return String(v);
                }
                return null;
            };
            baseAvailable = pickValue(base) ?? "0";
            quoteAvailable = pickValue(quote) ?? "0";
        }

        // INFO-level diagnostic — surfaces in CloudWatch so we can tell
        // whether the snapshot was actually built and what values it
        // carried into the SSE payload.
        elizaLogger.info(
            `[plugin-cex] fetchAccountSnapshot RESULT venue=${creds.exchange} base=${base}:${baseAvailable} quote=${quote}:${quoteAvailable} accounts=${Array.isArray(accounts) ? accounts.length : "n/a"}`,
        );

        return {
            baseAvailable,
            quoteAvailable,
            baseAsset: base,
            quoteAsset: quote,
            feeBps: 10,
        };
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] fetchAccountSnapshot FAILED: ${
                err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            }`,
        );
        return null;
    }
}

/**
 * List the user's currently-open orders on `venue` (defaults to their
 * resolved default exchange). Used to pre-populate the cancel_order
 * approval modal when the user said "cancel all" — the memory-based
 * resolver only sees ids the agent has recently rendered, which is
 * often a subset of what's actually open.
 *
 * Re-uses the existing `ExchangeService.getOrders` so the response
 * matches what the rest of the plugin already understands. 2.5s
 * timeout (same ceiling as `fetchAccountSnapshot`) keeps a slow venue
 * from stalling the modal-open path. Returns `null` on any failure
 * — the caller falls back to `all_open=true` fan-out behavior.
 */
async function fetchUserOpenOrdersFromCore(
    input: CEXUserOpenOrdersInput,
): Promise<CEXUserOpenOrder[] | null> {
    try {
        // Paper-mode users' OPEN orders live in the paper ledger, not the
        // live exchange. Querying the real venue with the user's (often
        // dummy) paper creds fails and forces callers to fall back to a
        // memory snapshot that can't distinguish a filled leg from an open
        // one — so "cancel all" wrongly includes already-filled orders (they
        // then surface as "Not Found"). Read the paper ledger's OPEN orders
        // directly. `getUserTradingMode` resolves the public-demo paper
        // default, so anonymous PUBLIC_ACCESS users hit this branch too.
        const mode = await getUserTradingMode(input.runtime, input.userId).catch(
            () => "live",
        );
        if (mode === "paper") {
            const realVenue = (input.venue || "binance").toLowerCase();
            const paperVenue = await createPaperVenueForRuntime(
                input.runtime,
                realVenue,
            );
            const rawPaper = (await paperVenue.orders.getOrders({
                userId: input.userId,
                order_status: ["open"],
            } as never)) as { orders?: Array<Record<string, unknown>> } | undefined;
            const paperRows = Array.isArray(rawPaper?.orders) ? rawPaper.orders : [];
            const paperOut: CEXUserOpenOrder[] = [];
            for (const row of paperRows) {
                const orderIdRaw =
                    row.order_id ?? row.orderId ?? row.id ?? row.client_order_id;
                const symbolRaw = row.product_id ?? row.symbol;
                if (orderIdRaw == null || symbolRaw == null) continue;
                const orderId = String(orderIdRaw).trim();
                const symbol = normalizeVenueSymbol(String(symbolRaw).trim());
                if (orderId && symbol) paperOut.push({ order_id: orderId, symbol });
            }
            elizaLogger.info(
                `[plugin-cex] fetchUserOpenOrders venue=paper(${realVenue}) count=${paperOut.length}`,
            );
            return paperOut;
        }

        const preferExchangeId = input.venue
            ? (input.venue.toLowerCase() as never)
            : undefined;
        const creds = await resolveExchangeCredentials(input.runtime, input.userId, {
            preferExchangeId,
        });
        const service = createExchangeService({
            exchange: creds.exchange,
            authType: creds.authType,
            auth: creds.auth,
        });

        const ordersPromise = service.orders.getOrders({
            userId: input.userId,
        });
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("open-orders-fetch-timeout")), 2_500),
        );
        const raw = (await Promise.race([ordersPromise, timeout])) as
            | { orders?: Array<Record<string, unknown>> }
            | undefined;

        const rows = Array.isArray(raw?.orders) ? raw.orders : [];
        const out: CEXUserOpenOrder[] = [];
        for (const row of rows) {
            // Binance returns `orderId`/`symbol`; Coinbase normalizes to
            // `order_id`/`product_id`. Accept both shapes.
            const orderIdRaw =
                row.order_id ?? row.orderId ?? row.id ?? row.client_order_id;
            const symbolRaw = row.product_id ?? row.symbol;
            if (orderIdRaw == null || symbolRaw == null) continue;
            const orderId = String(orderIdRaw).trim();
            const symbol = normalizeVenueSymbol(String(symbolRaw).trim());
            if (orderId && symbol) {
                out.push({ order_id: orderId, symbol });
            }
        }
        elizaLogger.info(
            `[plugin-cex] fetchUserOpenOrders venue=${creds.exchange} count=${out.length}`,
        );
        return out;
    } catch (err) {
        elizaLogger.warn(
            `[plugin-cex] fetchUserOpenOrders failed: ${
                err instanceof Error ? `${err.name}: ${err.message}` : String(err)
            }`,
        );
        return null;
    }
}

/**
 * Normalize Binance's concatenated symbol form (`BTCUSDT`) to the
 * canonical dashed pair (`BTC-USDT`) so downstream consumers (the
 * approval modal's Product id field, the venue-cancel call) see a
 * uniform shape. Already-dashed symbols pass through unchanged.
 */
function normalizeVenueSymbol(sym: string): string {
    if (!sym) return sym;
    if (sym.includes("-") || sym.includes("/")) return sym.replace("/", "-");
    const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USD"];
    for (const q of KNOWN_QUOTES) {
        if (sym.endsWith(q) && sym.length > q.length) {
            return `${sym.slice(0, -q.length)}-${q}`;
        }
    }
    return sym;
}

async function fetchTradableProductsFromCore(
    input: CEXTradableProductsInput,
): Promise<CEXTradableProductsOutput | null> {
    const res = await fetchPublicTradableProducts({
        venue: input.venue,
        marginType: input.marginType,
    });
    if (!res) return null;
    return {
        venue: res.venue,
        products: res.products,
        fetched_at_ms: res.fetched_at_ms,
    };
}

async function fetchMarketMidUsdFromCore(input: {
    runtime: IAgentRuntime;
    venue: string;
    symbol: string;
    signal?: AbortSignal;
    bypassCache?: boolean;
}): Promise<number | null> {
    return fetchPublicMidPrice({
        venue: input.venue,
        symbol: input.symbol,
        signal: input.signal,
        bypassCache: input.bypassCache,
    });
}

function routeMemoryFromCore(input: CEXMemoryRouterInput): CEXMemoryRouterOutput {
    try {
        const out = routeMemory({
            messageText: input.messageText,
            locale: input.locale === "mixed-en" ? "en" : input.locale,
            recentTrades: input.recentTrades,
        });
        return { summary: out.summary, snippets: out.snippets };
    } catch {
        return { summary: "", snippets: [] };
    }
}

export const cexPlugin: Plugin = {
    name: "cex",
    description: "Plugin to interacts with the user's accounts on crypto exchanges. Gets balance, and gets, creates, and cancels orders given user params for actions.",
    actions: tradeActions,
    services: [],
    cexSpecProvider: {
        getCanonicalSpec: getCEXCanonicalSpec,
        getActionSchema: getCEXActionSchema,
        getActionSchemaForApproval: getCEXActionSchemaForApproval,
        formatActionForLLM: (actionName: string, runtimeDescription?: string) =>
            formatCEXActionForLLM(actionName, getCEXCanonicalSpec().schemas, runtimeDescription),
        validateApprovedActionParams,
        runRiskPrecheck,
        deriveClientOrderId: deriveClientOrderIdFromInput,
        deriveIdempotency: deriveIdempotencyFromInput,
        emitTradingEvent: emitTradingEventFromCore,
        runTradingSubAgent: runTradingSubAgentFromCore,
        runTradingSubAgentSafe: runTradingSubAgentSafeFromCore,
        resolveAnaphoricOrderId: resolveAnaphoricOrderIdFromCore,
        resolveAllOrdersFromContext: resolveAllOrdersFromContextFromCore,
        resolveSymbolForOrderId: resolveSymbolForOrderIdFromCore,
        routeMemory: routeMemoryFromCore,
        rerankKnowledgeCandidates: rerankKnowledgeCandidatesFromCore,
        fetchAccountSnapshot: fetchAccountSnapshotFromCore,
        fetchUserOpenOrders: fetchUserOpenOrdersFromCore,
        fetchTradableProducts: fetchTradableProductsFromCore,
        fetchMarketMidUsd: fetchMarketMidUsdFromCore,
        // §6.0.1 / §6.0.2 / §6.2
        checkTradingHealth: checkTradingHealthImpl,
        renderFailClosedMessage: renderFailClosedMessageImpl,
        checkExistingOrder: checkExistingOrderImpl,
        async writeApprovalDecision(record) {
            const sink = getApprovalDecisionSink();
            if (!sink) return;
            try {
                await sink.writeApprovalDecision(record);
            } catch (err) {
                // Best-effort — approval audit failure must not abort the
                // approval itself. The dep-health gate is the explicit
                // fail-closed surface; this row is for the replay tool.
                // eslint-disable-next-line no-console
                console.warn(
                    `[plugin-cex] approval_decisions write failed: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        },
        runWithVenueCallContext: <T>(
            ctx: {
                request_id?: string;
                intent_hash?: string;
                userId?: string;
                client_order_id?: string;
            },
            work: () => Promise<T>,
        ) => runWithVenueCallContext(ctx, work),
        getMarketDataAgeMs: (venue: string, symbol: string) =>
            getMarketDataAgeMsImpl(venue, symbol),
        // Fix 7 — plan-time validators.
        validateCanonicalIntent: validateCanonicalIntentFromCore,
        fetchSymbolFilters: fetchSymbolFiltersFromCore,
        // Fix 10 — deterministic intent cross-check (pure function;
        // pulled from `intent/promptNumericExtractor`).
        crossCheckUserIntent,
        // Fix 14c — asset-name extractor for the symbol-verification guard.
        extractAssetMentions,
        // Fix 14a + CEX post-PR237 Commit 11 — venue-aware
        // modal-enrichment helpers (5 s cache, single-flight). Each
        // helper takes an optional `venue` arg so a Coinbase user gets
        // Coinbase data and a Binance user gets Binance data. Symbol
        // form is normalized per venue inside the dispatcher. When the
        // legacy single-arg signature is called (no venue), defaults
        // to Binance for backward-compat. All return null on failure
        // so the approval modal renders without the live snapshot
        // rather than blocking.
        fetchBookTicker: async (symbol: string, venue?: string) =>
            venue
                ? fetchBookTickerForVenue({ venue, symbol })
                : fetchBookTicker(symbol),
        fetchDepth: async (symbol: string, limit?: number, venue?: string) =>
            venue
                ? fetchDepthForVenue({ venue, symbol, limit })
                : fetchDepth(symbol, limit),
        fetch24hStats: async (symbol: string, venue?: string) =>
            venue
                ? fetch24hStatsForVenue({ venue, symbol })
                : fetch24hStats(symbol),
        formatOrderNl: (action: string, params: Record<string, unknown>) =>
            formatOrderNlFromParams({ action, params }),
        formatOrderSummary: (params: Record<string, unknown>, action: string) =>
            formatOrderSummaryShort(params, action),
        formatApprovalInterruptTitle: (
            params: Record<string, unknown>,
            action: string,
        ) => formatApprovalInterruptTitle(params, action),
    },
};

export default cexPlugin;

// --- Autotrading-uplift surface (per plan §1.3–§1.6) ----------------------
// Re-exported from the main barrel so `@elizaos/core` can dynamic-import
// these without depending on submodule export paths.

export {
    canonicalIntentSchema,
    parseCanonicalIntent,
    projectHashableSubset,
    LOCALE_VALUES,
    type CanonicalAction,
    type CanonicalIntent,
    type CanonicalOrderType,
    type HashableIntentSubset,
    type IntentMode,
    type Locale as CanonicalLocale,
    type OrderSide,
    type Stake as CanonicalStake,
} from "./intent/canonicalIntent";
export {
    buildCanonicalIntent,
    type ApprovalPayloadShape,
    type BuildCanonicalIntentInput,
} from "./intent/intentBuilder";
export {
    ORDER_VARIANT_LABELS,
    detectOrderVariant,
    formatApprovalInterruptTitle,
    formatOrderNlFromParams,
    formatOrderSummaryShort,
    type FormatOrderNlInput,
    type FormatOrderNlOptions,
    type OrderNlVenueMode,
} from "./nl/orderNl";
// Fix 10 — deterministic intent cross-check before approval modal.
// Fix 14c adds `extractAssetMentions` (asset-name lookup for the
// symbol-verification guard).
export {
    crossCheckUserIntent,
    extractAssetMentions,
    extractQuantitiesFromPrompt,
    hasAnchoredQuantity,
    MAX_VALUE_DIVERGENCE_PCT,
    type CrossCheckInput,
    type CrossCheckResult,
    type ExtractedQuantity,
} from "./intent/promptNumericExtractor";
// Fix 14 — modal-enrichment helpers (public Binance endpoints, 5 s cache,
// single-flight). Re-exported so core's `cexWorkflowMessageHandler` can
// register them on the CEXSpecProvider.
export {
    fetch24hStats,
    fetchBookTicker,
    fetchDepth,
    type BookTickerSnapshot,
    type DepthSnapshot,
    type Stats24hSnapshot,
} from "./exchanges/services/binancePricing";
export {
    canonicalJSON,
    computeIntentHash,
    deriveClientOrderId,
} from "./idempotency/intentHash";
export { evaluate as evaluateRisk } from "./risk/riskEngine";
export {
    buildRiskDecisionRecord,
    type RiskAuditSink,
} from "./risk/auditLog";
// Expose the audit-sink setter so `agent/src/index.ts` can wire the MongoDB
// adapter's `writeRiskDecision` at startup. The plugin reuses this sink for
// every subsequent precheck. See plan §6.1.
export { setRiskAuditSink, getRiskAuditSink } from "./safety/auditSinkRegistry";
export {
    setApprovalDecisionSink,
    getApprovalDecisionSink,
    type ApprovalDecisionSink,
    type ApprovalDecisionRecord,
} from "./safety/approvalSinkRegistry";
export {
    setVenueCallSink,
    getVenueCallSink,
    recordVenueCall,
    sanitizeVenueRequest,
    sanitizeVenueResponse,
    type VenueCallRecord,
    type VenueCallSink,
    type VenueCallOutcome,
} from "./observability/venueCallLog";
export {
    checkExistingOrder,
    isInFlightState,
    isTerminalState,
    type PreSubmitDedupResult,
} from "./idempotency/preSubmitDedup";
/** F5 — exported so the agent's ReconciliationService config can wrap
 *  it into a per-(userId, venue) resolver passed to the REST fallback
 *  poller. Without this export the agent had to re-implement cred
 *  lookup from scratch.
 */
export { resolveExchangeCredentials } from "./actions/shared";
export {
    writeReconciliationRuntimeLock,
    type RuntimeLockWriterArgs,
    type UserTradingPreferencesAdapter,
} from "./reconciliation/runtimeLockWriter";
export {
    checkTradingHealth,
    renderFailClosedMessage,
    type DependencyHealthInput,
    type DependencyHealthResult,
    type HealthIssue,
} from "./safety/dependencyHealth";
export {
    DEFAULT_USER_TRADING_PREFERENCES,
    type RiskDecision,
    type RiskDecisionRecord,
    type RiskEvaluationContext,
    type RiskRuleId,
    type RiskRuleResult,
    type RiskVerdict,
    type UserTradingPreferences,
} from "./risk/types";
export {
    emitApprovalDecision,
    emitApprovalRequest,
    emitClarificationRequest,
    emitFailClosed,
    emitIdempotency,
    emitIdempotencyHit,
    emitIntentClassified,
    emitKillSwitchActivation,
    emitLockAcquire,
    emitLockRelease,
    emitOrderAck,
    emitOrderError,
    emitOrderSubmit,
    emitPreprocess,
    emitPromptInjectionDetected,
    emitReconciliationEvent,
    emitRiskCheck,
    emitStakeCheck,
    emitTimeout,
    emitUnknownState,
    emitStrategyStatusChange,
    emitVenueCall,
    onTradingEvent,
    type TradingEvent,
    type TradingEventEnvelope,
    type TradingEventStage,
} from "./observability/tradingEvents";
export {
    findExchangeMentionInText,
    matchExchangeToken,
    EXCHANGE_REGISTRY,
    isExchangeId,
    getSupportedExchangeNames,
} from "./exchanges/registry";
export type {
    CoinbaseUserDataStreamConfig,
    LedgerOperations,
    PendingOrderLedgerRow,
    PendingOrderState,
    PendingOrderStateTransition,
    ReconciliationEvent,
    VenueUserDataStreamConfig,
} from "./reconciliation/types";
export {
    acquireTradingLock,
    activeLockCount,
    waitingRequestCount,
} from "./concurrency/tradingLock";
export {
    ReconciliationService,
    type ReconciliationServiceConfig,
} from "./reconciliation/reconciliationService";
export {
    createMongoLedger,
    ensurePendingOrdersLedgerIndexes,
} from "./reconciliation/pendingOrdersLedger";
export {
    resolveAnaphoricOrderId,
    type AnaphoricResolverInput,
    type AnaphoricResolverOutput,
} from "./orderContext/anaphoricResolver";
export {
    ADK_TOOL_BY_NAME,
    ALL_ADK_TOOLS,
    classifyTool,
    createTradingSubAgent,
    extractCancelOrderInput,
    extractCreateOrderInput,
    extractForTool,
    extractGetBalanceInput,
    extractGetFillsInput,
    extractGetOrdersInput,
    extractAmendOrderInput,
    extractPreviewOrderInput,
    rankToolCandidates,
    runTradingSubAgent,
    runTradingSubAgentForKnownAction,
    visibleTools,
    type AdkAgentInput,
    type AdkAgentResult,
    type AdkClarificationOutput,
    type AdkClassifiedOutput,
    type AdkRuntimeContext,
    type AdkStake,
    type AdkTool,
    type AdkToolName,
    type TradingSubAgent,
} from "./adk";
export {
    buildShadowDecisionRecord,
    compileNlToDsl,
    computeDivergenceRatio,
    createInMemoryShadowDecisionWriter,
    createMongoShadowDecisionWriter,
    getShadowDecisionWriter,
    setShadowDecisionWriter,
    listSignalIds,
    parseStrategyDSL,
    runStrategyOnce,
    strategyDSLSchema,
    summarizeStrategy,
    tryParseStrategyDSL,
    type BuildShadowDecisionInput,
    type NlToDslClarification,
    type NlToDslOptions,
    type NlToDslResult,
    type NlToDslSuccess,
    type RunStrategyArgs,
    type ShadowDecisionPersistenceAdapter,
    type ShadowDecisionRecord,
    type ShadowDecisionWriter,
    type SignalSnapshot,
    type StrategyDSL,
    type StrategyEntry,
    type StrategyEvaluationContext,
    type StrategyExit,
    type StrategyMode,
    type StrategyOrderSpec,
    type StrategyRule,
    type StrategyRuntimeStatus,
    type StrategySignal,
    type StrategyStatus,
    type StrategyTrigger,
} from "./strategy";
export {
    PaperVenueExchangeService,
    createPaperVenue,
    type PaperBalance,
    type PaperFill,
    type PaperOrder,
    type PaperVenueConfig,
    type SlippageModel,
} from "./exchanges/services/paperVenue";
// Fix 7 — plan-time validators import these from the plugin barrel.
export {
    fetchBinanceSymbolFilters,
    __resetBinanceSymbolInfoCacheForTests,
} from "./exchanges/services/binanceSymbolInfo";
export type { BinanceSymbolFilters } from "./exchanges/services/binanceQuantization";
export {
    InMemoryOhlcvSource,
    atr,
    ema,
    rsi,
    sma,
    computeMetrics,
    evaluatorFromStrategy,
    generateSyntheticBars,
    parseOhlcvCsv,
    runBacktest,
    type BacktestFeeModel,
    type BacktestFill,
    type BacktestMetrics,
    type BacktestPosition,
    type BacktestReport,
    type BacktestRunConfig,
    type BacktestSlippageModel,
    type BacktestStrategyEvaluator,
    type ComputeMetricsArgs,
    type OhlcvBar,
    type OhlcvDataSource,
    type RegimeTag,
    type RegimeWindow,
} from "./backtest";
export {
    routeMemory,
    type MemoryRouterInput,
    type MemoryRouterOutput,
    type RoutedMemorySnippet,
} from "./memory";
export {
    hybridRetrieve,
    type HybridRetrieverOptions,
    type KbDocument,
    type RankedDocument,
    type RetrieveQuery,
    type TrustTier,
} from "./ranking";

// StrategyEngineService — paper-only auto-execution background service.
export { StrategyEngineService, haltUserInstances } from "./strategy/engine/strategyEngineService";
export type { StrategyInstance } from "./strategy/engine/strategyInstance";
