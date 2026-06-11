/**
 * Fix 15 — `get_orderbook` action.
 *
 * Instant order-book lookup for a single symbol. Reuses Fix 14a's
 * `fetchDepth` helper, which calls Binance's public `/api/v3/depth`
 * endpoint, caches per `(symbol, limit)` for 5 s, and single-flights
 * cold callers. No user credentials required.
 *
 * Param shape:
 *   { userId: UUID, product_id: string, depth?: number }
 *
 * `product_id` is required — order books are large and a fan-out across
 * the user's holdings would burn the per-symbol caches and the modal
 * footprint. `depth` defaults to 10 and is clamped to [1, 100] (the
 * helper enforces the upper bound).
 *
 * Output: a side-by-side markdown table with top-N bids and top-N asks
 * for the requested symbol, plus a trailing source line.
 *
 * Symbol-correctness guard (Fix 14c parity) — same as `get_ticker`:
 *  - Pulls `extractAssetMentions` for the user's prompt text.
 *  - Refuses with a clarification when the LLM-extracted base asset
 *    doesn't match the user's mentions.
 *
 * READ-ONLY. Registered in `READ_ONLY_ACTIONS` (both classifier files)
 * and `tradeActions`.
 */

import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    createActionErrorResponse,
    createActionResponse,
    elizaLogger,
} from "@elizaos/core";

import { fetchDepth } from "../exchanges/services/binancePricing";
import { completeProductId, isExplicitOverride, symbolGuard } from "./getTicker";

const DEFAULT_DEPTH = 10;
const MAX_DEPTH = 100;

/**
 * Pull a single `product_id` value from LLM-supplied params. Accepts a
 * string OR a single-element array (the LLM occasionally upgrades the
 * field to an array when it sees `product_ids` in nearby context).
 */
function parseProductId(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === "string") {
        const t = raw.trim();
        return t.length > 0 ? t : null;
    }
    if (Array.isArray(raw) && raw.length > 0) {
        const first = raw[0];
        if (typeof first === "string" && first.trim().length > 0) {
            return first.trim();
        }
    }
    return null;
}

/**
 * Parse and clamp the `depth` param. Default 10, max 100, min 1. Any
 * non-finite value falls back to the default.
 */
export function parseDepth(raw: unknown): number {
    if (raw == null) return DEFAULT_DEPTH;
    let n: number;
    if (typeof raw === "number") {
        n = raw;
    } else if (typeof raw === "string") {
        n = Number.parseFloat(raw);
    } else {
        return DEFAULT_DEPTH;
    }
    if (!Number.isFinite(n)) return DEFAULT_DEPTH;
    const truncated = Math.trunc(n);
    if (truncated <= 0) return DEFAULT_DEPTH;
    return Math.min(truncated, MAX_DEPTH);
}

interface OrderbookResult {
    symbol: string;
    depth: number;
    /** [price, qty] tuples; highest-bid first. */
    bids: Array<[string, string]>;
    /** [price, qty] tuples; lowest-ask first. */
    asks: Array<[string, string]>;
    /** ISO timestamp for the source-line footer. */
    asOf: string;
    /** Binance's monotonically increasing snapshot id (debug aid). */
    lastUpdateId: number;
}

function fmtRawNumber(s: string, opts: { fractionDigits?: number } = {}): string {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return s;
    return n.toLocaleString(undefined, {
        maximumFractionDigits: opts.fractionDigits ?? 8,
        minimumFractionDigits: 0,
    });
}

/**
 * Render the side-by-side bid/ask table + the source-line footer.
 * Exported for unit tests. The table has exactly `depth` rows; missing
 * levels are padded with em-dash placeholders so the columns stay
 * aligned for partial books.
 */
export function renderOrderbookTable(result: OrderbookResult): string {
    const header = `| # | Bid price | Bid qty | Ask price | Ask qty |`;
    const sep = `|--:|----------:|--------:|----------:|--------:|`;

    const rows: string[] = [];
    for (let i = 0; i < result.depth; i++) {
        const bid = result.bids[i];
        const ask = result.asks[i];
        const bidPrice = bid ? fmtRawNumber(bid[0]) : "—";
        const bidQty = bid ? fmtRawNumber(bid[1]) : "—";
        const askPrice = ask ? fmtRawNumber(ask[0]) : "—";
        const askQty = ask ? fmtRawNumber(ask[1]) : "—";
        rows.push(`| ${i + 1} | ${bidPrice} | ${bidQty} | ${askPrice} | ${askQty} |`);
    }

    return [
        `**Order book — ${result.symbol} (top ${result.depth})**`,
        "",
        header,
        sep,
        ...rows,
        "",
        `_Source: Binance order book @ ${result.asOf}, freshness: <5s_`,
    ].join("\n");
}

export const getOrderbookAction: Action = {
    name: "get_orderbook",
    description:
        "Show top-N bids and top-N asks from the Binance public order book for a single symbol. Read-only. `product_id` is required; `depth` defaults to 10 and is clamped to 1..100.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "show me BTC order book" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Pulling the BTCUSDT order book.",
                    action: "get_orderbook",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "ETH orderbook depth 20" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Fetching ETHUSDT order book depth 20.",
                    action: "get_orderbook",
                },
            },
        ],
    ],
    handler: async (
        runtime: IAgentRuntime,
        memory: Memory,
        _state: State | undefined,
        options: Record<string, unknown> | undefined,
        callback?: HandlerCallback,
    ): Promise<unknown> => {
        const opts = (options ?? {}) as Record<string, unknown>;
        const params = (opts.parameters && typeof opts.parameters === "object"
            ? (opts.parameters as Record<string, unknown>)
            : opts) as Record<string, unknown>;
        // Touch `runtime` so the unused-arg lint passes — we don't yet
        // need it for this read-only action but the framework signature
        // is fixed.
        void runtime;

        const userId =
            (typeof params.userId === "string" && params.userId) ||
            (memory.userId ? String(memory.userId) : null);
        if (!userId) {
            const text = '"userId" is required';
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_orderbook",
                        type: "get_orderbook_error",
                        text,
                        error: new Error(text),
                    }),
                );
            }
            return false;
        }

        const rawProductId = parseProductId(params.product_id);
        if (!rawProductId) {
            const text =
                '"product_id" is required (e.g. "BTCUSDT"). Order books are not fanned out across holdings.';
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_orderbook",
                        type: "get_orderbook_error",
                        text,
                        error: new Error(text),
                    }),
                );
            }
            return false;
        }

        // CEX post-PR237 Commit 3 — symbol completion. The LLM
        // sometimes emits a bare base asset (e.g. `BTC` because the
        // user said "show me BTC order book"). completeProductId
        // appends the venue-appropriate USDT quote so the Binance
        // depth endpoint actually returns data instead of null.
        const productId =
            completeProductId(rawProductId, { venue: "binance" }) ?? rawProductId;

        const depth = parseDepth(params.depth);

        // Symbol-correctness guard. Refuses with a clarification when the
        // LLM-extracted product_id's base asset isn't in the user's
        // prompt. Override-detector accepts `yes, {extracted_symbol}` so
        // a follow-up can confirm a mismatch without round-tripping the
        // LLM.
        const userText =
            (typeof memory.content?.text === "string" && memory.content.text) || "";
        if (userText && !isExplicitOverride(userText, productId)) {
            const guard = symbolGuard(userText, productId);
            if (guard) {
                elizaLogger.info(
                    `[plugin-cex] get_orderbook symbol guard REFUSED: user_asset=${guard.user_asset} extracted=${guard.extracted_symbol}`,
                );
                if (callback) {
                    await callback(
                        createActionResponse({
                            actionName: "get_orderbook",
                            type: "get_orderbook_clarification",
                            text: guard.clarification,
                            content: {
                                refused: true,
                                reason: "symbol_correctness_guard",
                                user_asset: guard.user_asset,
                                extracted_symbol: guard.extracted_symbol,
                            },
                            actionData: {
                                refused: true,
                                user_asset: guard.user_asset,
                                extracted_symbol: guard.extracted_symbol,
                            },
                        }),
                    );
                }
                return true;
            }
        }

        const snapshot = await fetchDepth(productId, depth);
        const asOf = new Date().toISOString();

        if (!snapshot) {
            const text =
                `Couldn't fetch the order book for ${productId} (venue returned no data).\n\n` +
                `_Source: Binance order book @ ${asOf}, freshness: <5s_`;
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_orderbook",
                        type: "get_orderbook",
                        text,
                        content: {
                            symbol: productId,
                            depth,
                            bids: [],
                            asks: [],
                            asOf,
                            lastUpdateId: 0,
                            error: "venue returned no data",
                        },
                        actionData: {
                            symbol: productId,
                            depth,
                            bids: [],
                            asks: [],
                            asOf,
                        },
                    }),
                );
            }
            return true;
        }

        const trimmedBids = snapshot.bids.slice(0, depth);
        const trimmedAsks = snapshot.asks.slice(0, depth);

        const result: OrderbookResult = {
            symbol: productId,
            depth,
            bids: trimmedBids,
            asks: trimmedAsks,
            asOf,
            lastUpdateId: snapshot.lastUpdateId,
        };

        const text = renderOrderbookTable(result);

        elizaLogger.info(
            `[Trading] ${JSON.stringify({
                stage: "get_orderbook",
                symbol: productId,
                depth,
                rows_returned: trimmedBids.length + trimmedAsks.length,
            })}`,
        );

        if (callback) {
            await callback(
                createActionResponse({
                    actionName: "get_orderbook",
                    type: "get_orderbook",
                    text,
                    content: {
                        symbol: productId,
                        depth,
                        bids: trimmedBids,
                        asks: trimmedAsks,
                        asOf,
                        lastUpdateId: snapshot.lastUpdateId,
                    },
                    actionData: {
                        symbol: productId,
                        depth,
                        bids: trimmedBids,
                        asks: trimmedAsks,
                        asOf,
                    },
                }),
            );
        }
        return true;
    },
    validate: async () => true,
};

// Internal exports for tests.
export { parseProductId };
export type { OrderbookResult };
