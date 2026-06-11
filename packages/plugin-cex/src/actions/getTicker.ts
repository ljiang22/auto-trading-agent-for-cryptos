/**
 * Fix 15 — `get_ticker` action.
 *
 * Instant ticker lookup with no LLM in the hot path: best bid/ask, mid
 * (Last (mid) = (bid + ask) / 2), spread, and 24h rollup statistics
 * sourced from Binance's PUBLIC endpoints (no user credentials
 * required). Fix 14a's `fetchBookTicker` + `fetch24hStats` are reused
 * verbatim; both helpers share a 5 s per-process cache and single-flight
 * dedupe, so the table is consistent across rapid follow-up queries.
 *
 * Param shape:
 *   { userId: UUID, product_ids?: string[] }
 *
 * Default `product_ids` resolution:
 *   1. If the user is authenticated AND `getCandidateHoldingsSymbols`
 *      returns ≥1 symbol, use the user's current holdings (cap 8).
 *   2. Otherwise fall back to the static defaults
 *      `["BTCUSDT", "ETHUSDT", "SOLUSDT"]`.
 *
 * Output: a markdown table with one row per symbol —
 *
 *   | Symbol | Last (mid) | Bid | Ask | Spread bps | 24h % | 24h High | 24h Low | 24h Vol (USDT) |
 *
 * followed by a trailing source line
 *
 *   _Source: Binance ticker @ {ISO timestamp}, freshness: <5s_
 *
 * Symbol-correctness guard (Fix 14c parity, but BEFORE execution):
 *   - Run Fix 10's `extractAssetMentions` on the user's chat text.
 *   - If the LLM's `product_ids[0]` base asset does not appear in the
 *     user's mentions AND the user replied without an explicit
 *     "yes, {extracted_symbol}" override, refuse with a clarification.
 *   - Pure-text guard; never reaches the venue when it refuses.
 *
 * Coinbase support is OUT OF SCOPE for the ticker fetch itself
 * (Binance's public ticker covers cross-venue spot semantics), but
 * authenticated Coinbase users still get the default `BTCUSDT` /
 * `ETHUSDT` / `SOLUSDT` set since the static defaults don't require
 * the holdings enumeration.
 *
 * All return paths are READ-ONLY — no order placement, no balance
 * mutation. The action lives under `READ_ONLY_ACTIONS` in both
 * classifier files (`cexWorkflowStakeClassifier.ts` + `cexPlanSchema.ts`).
 */

import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    type UUID,
    createActionErrorResponse,
    createActionResponse,
    elizaLogger,
} from "@elizaos/core";

import { resolveExchangeCredentials } from "./shared";
import {
    fetch24hStats,
    fetchBookTicker,
} from "../exchanges/services/binancePricing";
import { extractAssetMentions } from "../intent/promptNumericExtractor";
import { getCandidateHoldingsSymbols } from "../exchanges/services/binance";

const STATIC_DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;

/**
 * Cap on the number of symbols the action will fan out across when the
 * defaults come from the user's holdings. Matches Fix 4's cap so the
 * ticker view is consistent with `get_orders` / `get_fills` fan-out.
 */
const HOLDINGS_FAN_OUT_CAP = 8;

interface TickerRow {
    symbol: string;
    /** `last_mid` = (bid + ask) / 2 — null when either side is missing. */
    last_mid: number | null;
    bid: string | null;
    ask: string | null;
    spread_bps: number | null;
    /** 24h price change percent (signed, basis: 1.0 = +1%). */
    change_pct_24h: number | null;
    high_24h: string | null;
    low_24h: string | null;
    /** 24h quote volume in USDT (already in quote terms via `quoteVolume`). */
    volume_quote_24h: number | null;
    /** When set, the venue returned an empty / malformed response for this symbol. */
    note?: string;
}

interface TickerResult {
    rows: TickerRow[];
    /** ISO timestamp for the source line (set once at render time). */
    asOf: string;
    /** Echoes the resolution path so the caller can debug holdings vs. static. */
    defaultSource: "holdings" | "static" | "explicit";
}

/**
 * Tighten the BASE asset for a `product_ids[0]` value. Accepts both
 * pair-concatenated (`BTCUSDT`) and pair-separated (`BTC-USDT` / `BTC/USDT`)
 * forms. Returns the upper-cased base or null when no canonical base can
 * be derived.
 */
function extractBaseAsset(productId: string): string | null {
    if (!productId) return null;
    const upper = productId.toUpperCase().trim();
    if (!upper) return null;
    if (/^[A-Z0-9]{2,12}-USDT?$/.test(upper)) return upper.split("-")[0];
    if (/^[A-Z0-9]{2,12}\/USDT?$/.test(upper)) return upper.split("/")[0];
    // Concatenated: strip a trailing USDT / USDC / USD / EUR / BTC / ETH.
    const stripped = upper.replace(/(USDT|USDC|USD|EUR|BTC|ETH)$/u, "");
    if (stripped && stripped !== upper) return stripped;
    // Bare base token without quote suffix (unusual but tolerated).
    if (/^[A-Z0-9]{2,12}$/.test(upper)) return upper;
    return null;
}

/** Known quote currencies recognized as already-complete suffixes. */
const KNOWN_QUOTE_SUFFIXES = [
    "USDT",
    "USDC",
    "BUSD",
    "FDUSD",
    "TUSD",
    "USD",
    "EUR",
    "BTC",
    "ETH",
];

/**
 * CEX post-PR237 Commit 3 — symbol completion helper (Fix 15 + Issue 2/3
 * follow-up). When the LLM emits a bare base asset (e.g. `BTC` because
 * the user typed "show BTC ticker"), append a default quote currency so
 * downstream `fetchBookTicker` / `fetchDepth` hit a real Binance /
 * Coinbase symbol. Heuristic:
 *
 *  - If the input already contains a separator (`-` / `/`) or ends in
 *    a known quote suffix, return it untouched (canonical form).
 *  - If the input is bare base (`BTC`, `ETH`, `SOL`), append the
 *    venue-appropriate USDT pair: `BTCUSDT` for Binance, `BTC-USDT`
 *    for Coinbase. USDT is the staging-cluster default because it's
 *    the most liquid quote on both venues for our test set; if the
 *    user wanted USDC they can be explicit.
 *  - If the input doesn't look like a tradeable base at all (random
 *    text), return null so the caller can refuse cleanly.
 *
 * Exposed so the get_orderbook action + LLM template extractor can
 * reuse the same rule and never disagree.
 */
export function completeProductId(
    raw: string,
    opts?: { venue?: "binance" | "coinbase"; defaultQuote?: string },
): string | null {
    if (!raw || typeof raw !== "string") return null;
    const upper = raw.trim().toUpperCase();
    if (!upper) return null;
    const venue = opts?.venue ?? "binance";
    const defaultQuote = (opts?.defaultQuote ?? "USDT").toUpperCase();

    // Canonical with separator — accept verbatim (but re-normalize the
    // separator for the venue if necessary).
    if (upper.includes("-")) {
        return venue === "binance" ? upper.replace("-", "") : upper;
    }
    if (upper.includes("/")) {
        return venue === "binance"
            ? upper.replace("/", "")
            : upper.replace("/", "-");
    }

    // Concat form already ending in a known quote — accept verbatim
    // (Binance) or split + dash (Coinbase).
    for (const q of KNOWN_QUOTE_SUFFIXES) {
        if (upper.endsWith(q) && upper.length > q.length) {
            return venue === "binance"
                ? upper
                : `${upper.slice(0, -q.length)}-${q}`;
        }
    }

    // Bare base asset — append the venue-appropriate USDT pair.
    if (/^[A-Z0-9]{2,12}$/.test(upper)) {
        return venue === "binance"
            ? `${upper}${defaultQuote}`
            : `${upper}-${defaultQuote}`;
    }
    return null;
}

/**
 * Pull a string array of `product_ids` from the LLM-supplied params.
 * Defensive: tolerates a single string or a JSON-encoded string blob.
 */
function parseProductIds(raw: unknown): string[] | null {
    if (raw == null) return null;
    if (Array.isArray(raw)) {
        const arr = raw
            .map((v) => (typeof v === "string" ? v.trim() : ""))
            .filter((v) => v.length > 0);
        return arr.length > 0 ? arr : null;
    }
    if (typeof raw === "string") {
        const t = raw.trim();
        if (!t) return null;
        if (t.startsWith("[")) {
            try {
                const parsed = JSON.parse(t);
                if (Array.isArray(parsed)) return parseProductIds(parsed);
            } catch {
                /* fall through to single-value path */
            }
        }
        return [t];
    }
    return null;
}

/**
 * Symbol-correctness guard (Fix 14c parity). Runs BEFORE execution so we
 * never spend a Binance round-trip on a symbol the user didn't intend.
 *
 * Returns null when the guard PASSES (caller continues normally), or a
 * `{ user_asset, extracted_symbol, clarification }` shape when the guard
 * REFUSES (caller surfaces the clarification text to the user).
 */
export function symbolGuard(
    userText: string,
    extractedProductId: string | null,
): { user_asset: string; extracted_symbol: string; clarification: string } | null {
    if (!extractedProductId) return null;

    const userAssets = extractAssetMentions(userText);
    if (userAssets.length === 0) {
        // No identifiable assets in the user's text — pass through. This
        // covers the "use my holdings" / "default symbols" path, where
        // the action has no LLM-extracted symbol to verify against.
        return null;
    }

    const extractedBase = extractBaseAsset(extractedProductId);
    if (!extractedBase) return null;

    if (userAssets.includes(extractedBase)) return null;

    // Build the clarification message. Spec text format:
    //   "You asked about {user_asset} but I extracted {extracted_symbol}.
    //    Did you mean {user_asset}USDT?"
    const userAsset = userAssets[0];
    return {
        user_asset: userAsset,
        extracted_symbol: extractedProductId,
        clarification:
            `You asked about ${userAsset} but I extracted ${extractedProductId}. ` +
            `Did you mean ${userAsset}USDT?`,
    };
}

/**
 * Override-detector: the spec allows the user to confirm an extractor
 * mismatch by replying `yes, {extracted_symbol}`. Returns true when the
 * user's text matches that override shape for the given extracted id.
 */
export function isExplicitOverride(text: string, extractedProductId: string): boolean {
    if (!text || !extractedProductId) return false;
    const upper = text.trim().toUpperCase();
    const sym = extractedProductId.toUpperCase();
    const re = new RegExp(`^YES[,!. ]\\s*${sym}\\b`, "i");
    return re.test(upper);
}

/**
 * Resolve the symbol set to display. Pure data-flow:
 *   1. Explicit `product_ids` from params (Fix 14c symbol guard runs
 *      BEFORE this point).
 *   2. User's current holdings via Fix 4's enumerator.
 *   3. Static `["BTCUSDT", "ETHUSDT", "SOLUSDT"]`.
 */
async function resolveSymbols(
    runtime: IAgentRuntime,
    userId: string,
    explicitProductIds: string[] | null,
): Promise<{ symbols: string[]; defaultSource: TickerResult["defaultSource"] }> {
    if (explicitProductIds && explicitProductIds.length > 0) {
        // CEX post-PR237 Commit 3 — symbol completion. Without this a
        // bare `BTC` (LLM emits this when the user says "show BTC
        // ticker") hits Binance's /ticker/bookTicker?symbol=BTC and
        // returns null, so the table renders only the placeholder row
        // ("venue returned no data"). Completing to `BTCUSDT` here
        // gives the user real data without forcing them to re-type
        // the full pair.
        const completed = explicitProductIds
            .map((p) => completeProductId(p, { venue: "binance" }))
            .filter((p): p is string => p !== null);
        if (completed.length > 0) {
            return { symbols: completed, defaultSource: "explicit" };
        }
        // Fall through to defaults rather than fail — preserves UX for
        // users whose LLM output was garbage; the static defaults are
        // a reasonable best-effort response.
        elizaLogger.warn(
            `[plugin-cex] get_ticker: could not complete any product_ids from ${JSON.stringify(explicitProductIds)} — falling back to defaults`,
        );
    }

    // Best-effort holdings lookup — never throws. Failures fall through to static defaults.
    try {
        const creds = await resolveExchangeCredentials(runtime, userId as UUID);
        if (creds.exchange === "binance") {
            const holdings = await getCandidateHoldingsSymbols(creds, {
                quote: "USDT",
                cap: HOLDINGS_FAN_OUT_CAP,
                userId,
            });
            if (holdings.length > 0) {
                return { symbols: holdings, defaultSource: "holdings" };
            }
        }
    } catch (err) {
        elizaLogger.debug(
            `[plugin-cex] get_ticker holdings enumeration unavailable, falling back to static defaults: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    return {
        symbols: [...STATIC_DEFAULT_SYMBOLS],
        defaultSource: "static",
    };
}

/**
 * Fetch a single ticker row. Returns a row even when both endpoints
 * fail (with `note: "venue returned no data"`) so the caller can
 * include the symbol in the table with placeholders.
 */
async function fetchTickerRow(symbol: string): Promise<TickerRow> {
    const [book, stats] = await Promise.all([
        fetchBookTicker(symbol),
        fetch24hStats(symbol),
    ]);

    if (book === null && stats === null) {
        return {
            symbol,
            last_mid: null,
            bid: null,
            ask: null,
            spread_bps: null,
            change_pct_24h: null,
            high_24h: null,
            low_24h: null,
            volume_quote_24h: null,
            note: "venue returned no data",
        };
    }

    let lastMid: number | null = null;
    if (book) {
        const b = Number.parseFloat(book.bid);
        const a = Number.parseFloat(book.ask);
        if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) {
            lastMid = (b + a) / 2;
        }
    }

    let changePct: number | null = null;
    if (stats) {
        const p = Number.parseFloat(stats.priceChangePercent);
        if (Number.isFinite(p)) changePct = p;
    }

    let volQuote: number | null = null;
    if (stats) {
        const v = Number.parseFloat(stats.quoteVolume);
        if (Number.isFinite(v)) volQuote = v;
    }

    return {
        symbol,
        last_mid: lastMid,
        bid: book?.bid ?? null,
        ask: book?.ask ?? null,
        spread_bps: book?.spread_bps ?? null,
        change_pct_24h: changePct,
        high_24h: stats?.highPrice ?? null,
        low_24h: stats?.lowPrice ?? null,
        volume_quote_24h: volQuote,
    };
}

function fmtNumber(n: number | null, opts: { fractionDigits?: number } = {}): string {
    if (n === null || !Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, {
        maximumFractionDigits: opts.fractionDigits ?? 6,
        minimumFractionDigits: 0,
    });
}

function fmtRawNumber(s: string | null, opts: { fractionDigits?: number } = {}): string {
    if (s == null) return "—";
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, {
        maximumFractionDigits: opts.fractionDigits ?? 6,
        minimumFractionDigits: 0,
    });
}

function fmtSignedPct(p: number | null): string {
    if (p === null || !Number.isFinite(p)) return "—";
    const sign = p > 0 ? "+" : "";
    return `${sign}${p.toFixed(2)}%`;
}

function fmtCompactUsdt(n: number | null): string {
    if (n === null || !Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/**
 * Render the per-symbol table + the source-line footer. Exported for
 * unit tests.
 */
export function renderTickerTable(result: TickerResult): string {
    if (result.rows.length === 0) {
        return [
            "_No tickers to display._",
            "",
            `_Source: Binance ticker @ ${result.asOf}, freshness: <5s_`,
        ].join("\n");
    }

    const header =
        "| Symbol | Last (mid) | Bid | Ask | Spread bps | 24h % | 24h High | 24h Low | 24h Vol (USDT) |";
    const sep =
        "|--------|-----------:|----:|----:|-----------:|------:|---------:|--------:|---------------:|";

    const body = result.rows.map((r) => {
        const noteSuffix = r.note ? ` _(${r.note})_` : "";
        return `| ${r.symbol}${noteSuffix} | ${fmtNumber(r.last_mid)} | ${fmtRawNumber(r.bid)} | ${fmtRawNumber(r.ask)} | ${
            r.spread_bps === null ? "—" : r.spread_bps.toFixed(2)
        } | ${fmtSignedPct(r.change_pct_24h)} | ${fmtRawNumber(r.high_24h)} | ${fmtRawNumber(r.low_24h)} | ${fmtCompactUsdt(r.volume_quote_24h)} |`;
    });

    return [
        header,
        sep,
        ...body,
        "",
        `_Source: Binance ticker @ ${result.asOf}, freshness: <5s_`,
    ].join("\n");
}

export const getTickerAction: Action = {
    name: "get_ticker",
    description:
        "Get the live mid-price, bid/ask spread, and 24-hour statistics for one or more crypto symbols. Defaults to the user's current holdings (cap 8) when authenticated, else BTC/ETH/SOL. Read-only; uses Binance's public ticker endpoint.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "what is BTC's price right now?" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Pulling the live BTC ticker.",
                    action: "get_ticker",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "show me ticker for BTC, ETH, SOL" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Fetching tickers for BTC, ETH, and SOL.",
                    action: "get_ticker",
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
        const userId =
            (typeof params.userId === "string" && params.userId) ||
            (memory.userId ? String(memory.userId) : null);
        if (!userId) {
            const text = '"userId" is required';
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_ticker",
                        type: "get_ticker_error",
                        text,
                        error: new Error(text),
                    }),
                );
            }
            return false;
        }

        const explicitProductIds = parseProductIds(params.product_ids);

        // Symbol-correctness guard (Fix 14c parity). Runs BEFORE
        // execution so we never spend a Binance round-trip on a symbol
        // the user didn't intend.
        if (explicitProductIds && explicitProductIds.length > 0) {
            const userText =
                (typeof memory.content?.text === "string" && memory.content.text) || "";
            const firstProductId = explicitProductIds[0];

            if (userText && !isExplicitOverride(userText, firstProductId)) {
                const guard = symbolGuard(userText, firstProductId);
                if (guard) {
                    elizaLogger.info(
                        `[plugin-cex] get_ticker symbol guard REFUSED: user_asset=${guard.user_asset} extracted=${guard.extracted_symbol}`,
                    );
                    if (callback) {
                        await callback(
                            createActionResponse({
                                actionName: "get_ticker",
                                type: "get_ticker_clarification",
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
        }

        const { symbols, defaultSource } = await resolveSymbols(
            runtime,
            userId,
            explicitProductIds,
        );

        if (symbols.length === 0) {
            // Defensive — the resolver always returns at least the static
            // defaults, so this branch is effectively dead. Surface a
            // friendly note instead of a misleading empty table.
            const asOf = new Date().toISOString();
            const text = renderTickerTable({ rows: [], asOf, defaultSource });
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_ticker",
                        type: "get_ticker",
                        text,
                        content: { rows: [], asOf, defaultSource },
                        actionData: { rows: [], asOf, defaultSource },
                    }),
                );
            }
            return true;
        }

        // Fan out in parallel — each helper has its own 5 s cache so
        // back-to-back calls coalesce naturally; the parallel issue here
        // is just to minimize wall-clock when the cache is cold.
        const rows = await Promise.all(symbols.map(fetchTickerRow));
        const asOf = new Date().toISOString();
        const result: TickerResult = { rows, asOf, defaultSource };
        const text = renderTickerTable(result);

        elizaLogger.info(
            `[Trading] ${JSON.stringify({
                stage: "get_ticker",
                symbols,
                default_source: defaultSource,
                rows_with_data: rows.filter((r) => r.last_mid !== null).length,
            })}`,
        );

        if (callback) {
            await callback(
                createActionResponse({
                    actionName: "get_ticker",
                    type: "get_ticker",
                    text,
                    content: {
                        rows,
                        asOf,
                        defaultSource,
                        symbols,
                    },
                    actionData: {
                        rows,
                        asOf,
                        defaultSource,
                        symbols,
                    },
                }),
            );
        }
        return true;
    },
    validate: async () => true,
};

// Internal exports for tests.
export { extractBaseAsset, parseProductIds, fetchTickerRow, resolveSymbols };
export type { TickerRow, TickerResult };
