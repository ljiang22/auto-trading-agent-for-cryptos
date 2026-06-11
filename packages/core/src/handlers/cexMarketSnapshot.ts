/**
 * Fix 14 — modal-enrichment payload builder.
 *
 * Given a write-action call (`create_order` / `amend_order` /
 * `cancel_order` / `preview_order`) and the CEXSpecProvider hooks that
 * land it from `plugin-cex`, this module:
 *
 *  1. Resolves the symbol from `actionCall.userParams.product_id`
 *     (canonical `BASE-QUOTE`) or `actionCall.userParams.symbol`
 *     (pre-canonical, falls back to Binance-pair concatenation).
 *  2. Runs `fetchBookTicker(symbol)`, `fetchDepth(symbol, 5)`, and
 *     `fetch24hStats(symbol)` concurrently with `Promise.allSettled`
 *     under a 600 ms total budget. Any timeout/error returns no
 *     `market_snapshot`; the modal renders without the live data
 *     rather than blocking.
 *  3. Computes the symbol-verification guard via
 *     `extractAssetMentions(promptText)`:
 *     - `matches: false` — extractor returned no asset mentions, OR
 *       the LLM-extracted symbol contains none of them. Treated as a
 *       hard stop on the client (disable Confirm + red banner).
 *     - `matches: true` + `quote_currency_mismatch: true` — soft
 *       warning when the user typed `BTC-USDC` but the extractor sent
 *       `BTCUSDT`. Confirm still allowed.
 *  4. Computes `est_fill_price` and `slippage_vs_limit_bps` from the
 *     bookTicker + the action's `limit_price` (when present).
 *
 * Fail-soft contract: this module NEVER throws. Any internal error
 * (provider hook unregistered, network 5xx, JSON parse fail) returns a
 * `MarketSnapshotResult` with `market_snapshot: undefined`. The
 * `symbol_verification` block is always populated when at least the
 * symbol is resolvable.
 */

import type { CEXSpecProvider } from "../core/types.ts";

/** Total wall-clock budget for the three concurrent network fetches. */
export const MARKET_SNAPSHOT_LATENCY_BUDGET_MS = 600;

export interface MarketSnapshotInput {
    /** Pulled from the provider via `getCEXSpecProvider(state.runtime)`. */
    provider: CEXSpecProvider | undefined;
    /** Resolved canonical symbol (`BASE-QUOTE` or Binance-concat). */
    symbol: string;
    /** The user's raw prompt text (for the asset-mention extractor). */
    promptText: string;
    /** LLM-extracted action params (carries `side`, `limit_price`, ...). */
    actionParams: Record<string, unknown> | undefined;
    /** Action name (`create_order` etc.) — gates est_fill / slippage. */
    actionName: string;
    /**
     * CEX post-PR237 Commit 11 — active venue (`binance` / `coinbase`).
     * Threaded through to the provider's `fetchBookTicker / fetchDepth
     * / fetch24hStats` hooks so a Coinbase user gets Coinbase data and
     * a Binance user gets Binance data. When omitted, falls through to
     * the legacy single-arg hook signature which defaults to Binance.
     */
    venue?: string;
    /** Override the latency budget (test-only). */
    latencyBudgetMs?: number;
}

export interface MarketDepthRow {
    price: string;
    qty: string;
}

export interface MarketSnapshot {
    /** Resolved Binance-style symbol the snapshot was fetched for. */
    symbol: string;
    /** Best bid (USD-quoted, string to preserve precision). */
    bid?: string;
    bid_qty?: string;
    ask?: string;
    ask_qty?: string;
    /** Spread in basis points. `undefined` when book is unavailable. */
    spread_bps?: number;
    /** 24-hour % change (e.g. "1.234"). */
    price_change_pct?: string;
    high_24h?: string;
    low_24h?: string;
    volume_24h?: string;
    quote_volume_24h?: string;
    /** Top-5 (or N) depth ladder. */
    depth_bids?: MarketDepthRow[];
    depth_asks?: MarketDepthRow[];
    /** Estimated fill price: `side === "BUY" ? ask : bid`. */
    est_fill_price?: number;
    /**
     * `(est_fill_price - limit_price) / limit_price * 10000`. Undefined
     * for non-limit orders or when bookTicker is unavailable.
     */
    slippage_vs_limit_bps?: number;
    /** Epoch-ms when the snapshot finished (for staleness UX). */
    fetched_at_ms: number;
}

export interface SymbolVerification {
    /** False = client should disable Confirm and show the red banner. */
    matches: boolean;
    /** The LLM-extracted symbol the workflow is about to use. */
    extracted_symbol: string;
    /** De-duped, upper-case asset mentions found in the user prompt. */
    user_text_asset_mentions: string[];
    /**
     * Soft-warning flag — true when the user typed a different
     * QUOTE currency (e.g. `BTC-USDC`) than the extractor produced
     * (`BTCUSDT`). The base still matches so Confirm stays enabled.
     */
    quote_currency_mismatch?: boolean;
    /** Optional zh-CN/EN-aware reason hint for client logging/UX. */
    reason?:
        | "no_user_assets_mentioned"
        | "extractor_symbol_missing_user_assets"
        | "matches_with_quote_mismatch"
        | "matches";
}

export interface MarketSnapshotResult {
    market_snapshot?: MarketSnapshot;
    symbol_verification: SymbolVerification;
}

/**
 * Resolve a Binance-style symbol from any of the action's symbol-bearing
 * fields. Canonical input is `BASE-QUOTE`; Binance API requires the
 * concatenated form (`BASE+QUOTE`). Returns null if no shape matches.
 */
export function resolveBinanceSymbol(
    productId: string | undefined,
    symbolHint: string | undefined,
): string | null {
    const candidate =
        (typeof productId === "string" && productId.trim()) ||
        (typeof symbolHint === "string" && symbolHint.trim()) ||
        "";
    if (!candidate) return null;
    const upper = candidate.toUpperCase().trim();
    // Canonical `BASE-QUOTE` → strip the dash.
    if (upper.includes("-")) {
        const [base, quote] = upper.split("-", 2);
        if (base && quote) return `${base}${quote}`;
        return null;
    }
    // `BASE/QUOTE` → strip the slash.
    if (upper.includes("/")) {
        const [base, quote] = upper.split("/", 2);
        if (base && quote) return `${base}${quote}`;
        return null;
    }
    // Already concatenated (e.g. `BTCUSDT`).
    return upper;
}

/**
 * Render the symbol for UI display in the form the active venue's UI uses.
 * Binance keeps concat form (`BTCUSDT`). Coinbase shows dash form
 * (`BTC-USD`, `BTC-USDT`). Fix-T17 post-PR238: prior to this, Coinbase
 * snapshots displayed as `BTCUSD` (no dash) because the snapshot stored
 * the Binance-shape input symbol verbatim. The venue dispatcher already
 * normalizes for the actual API call; this only affects rendered text.
 */
function formatVenueDisplaySymbol(symbol: string, venue?: string): string {
    const v = (venue ?? "binance").toLowerCase().trim();
    if (v !== "coinbase") return symbol;
    if (symbol.includes("-")) return symbol.toUpperCase();
    const upper = symbol.toUpperCase();
    const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USD", "EUR", "BTC", "ETH"];
    for (const q of KNOWN_QUOTES) {
        if (upper.endsWith(q) && upper.length > q.length) {
            return `${upper.slice(0, -q.length)}-${q}`;
        }
    }
    return upper;
}

/** Pull the user's typed quote-currency (e.g. `USDC`) from `product_id`. */
function extractUserQuoteCurrency(productId: string | undefined): string | null {
    if (!productId || typeof productId !== "string") return null;
    const upper = productId.toUpperCase().trim();
    if (upper.includes("-")) {
        const parts = upper.split("-");
        return parts.length === 2 && parts[1] ? parts[1] : null;
    }
    if (upper.includes("/")) {
        const parts = upper.split("/");
        return parts.length === 2 && parts[1] ? parts[1] : null;
    }
    // Concatenated forms — guess the trailing quote by suffix.
    for (const quote of ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USD"]) {
        if (upper.endsWith(quote) && upper.length > quote.length) return quote;
    }
    return null;
}

/** Pull the LLM-extracted limit price out of nested `order_configuration`. */
export function extractLimitPriceFromAction(
    params: Record<string, unknown> | undefined,
): number | null {
    if (!params) return null;
    // Direct (legacy ADK fast-path).
    const direct = params.limit_price;
    if (typeof direct === "string") {
        const n = Number.parseFloat(direct);
        if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
        return direct;
    }
    const orderConfig = params.order_configuration as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
    if (!orderConfig) return null;
    for (const inner of Object.values(orderConfig)) {
        if (!inner) continue;
        const lp = inner.limit_price;
        if (typeof lp === "string") {
            const n = Number.parseFloat(lp);
            if (Number.isFinite(n) && n > 0) return n;
        }
        if (typeof lp === "number" && Number.isFinite(lp) && lp > 0) return lp;
    }
    return null;
}

/** Pull the order side (`BUY` / `SELL`) from action params. */
function extractSide(
    params: Record<string, unknown> | undefined,
): "BUY" | "SELL" | null {
    if (!params) return null;
    const raw = params.side;
    if (typeof raw !== "string") return null;
    const upper = raw.toUpperCase().trim();
    if (upper === "BUY" || upper === "SELL") return upper;
    return null;
}

/**
 * Race a promise against a timeout. Returns null when the timeout fires
 * before the promise settles. Used to enforce the 600 ms latency budget
 * on each of the three concurrent fetches.
 */
async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
): Promise<T | null> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(null);
        }, ms);
        p.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

/**
 * Build the symbol-verification block. Always populated; the
 * `market_snapshot` block is the optional-and-fail-soft piece.
 */
export function buildSymbolVerification(
    promptText: string,
    extractedSymbol: string,
    userProductId: string | undefined,
    extractAssetMentions: (text: string) => string[],
): SymbolVerification {
    const mentions = extractAssetMentions(promptText);
    const extractedUpper = (extractedSymbol ?? "").toUpperCase();

    if (mentions.length === 0) {
        // No asset mentioned in the prompt — we have nothing to verify
        // against. Treat as a non-match so the modal client surfaces
        // the safety banner (better a false-positive on a vague prompt
        // than a silent BTC→ETH bait-and-switch).
        return {
            matches: false,
            extracted_symbol: extractedUpper,
            user_text_asset_mentions: [],
            reason: "no_user_assets_mentioned",
        };
    }

    const hasMatchingMention = mentions.some((asset) =>
        extractedUpper.includes(asset),
    );
    if (!hasMatchingMention) {
        return {
            matches: false,
            extracted_symbol: extractedUpper,
            user_text_asset_mentions: mentions,
            reason: "extractor_symbol_missing_user_assets",
        };
    }

    // Soft warning: user typed a quote different from what the extractor
    // produced (e.g. user `BTC-USDC` → extractor `BTCUSDT`).
    const userQuote = extractUserQuoteCurrency(userProductId);
    let quoteMismatch = false;
    if (userQuote) {
        // Find the extracted symbol's quote by suffix.
        const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USD"];
        let extractedQuote: string | null = null;
        for (const q of KNOWN_QUOTES) {
            if (extractedUpper.endsWith(q) && extractedUpper.length > q.length) {
                extractedQuote = q;
                break;
            }
        }
        if (extractedQuote && extractedQuote !== userQuote) {
            quoteMismatch = true;
        }
    }

    return {
        matches: true,
        extracted_symbol: extractedUpper,
        user_text_asset_mentions: mentions,
        ...(quoteMismatch ? { quote_currency_mismatch: true } : {}),
        reason: quoteMismatch ? "matches_with_quote_mismatch" : "matches",
    };
}

/**
 * Build the full market snapshot + verification result for the
 * approval modal. NEVER throws. The `market_snapshot` field is
 * undefined on any timeout / fetch failure / missing-provider-hook.
 */
export async function buildMarketSnapshot(
    input: MarketSnapshotInput,
): Promise<MarketSnapshotResult> {
    const {
        provider,
        symbol,
        promptText,
        actionParams,
        actionName,
        venue,
        latencyBudgetMs = MARKET_SNAPSHOT_LATENCY_BUDGET_MS,
    } = input;

    // Verification is always built — it doesn't require the network.
    const userProductId =
        typeof actionParams?.product_id === "string"
            ? (actionParams.product_id as string)
            : typeof actionParams?.symbol === "string"
              ? (actionParams.symbol as string)
              : undefined;

    const extractor =
        provider?.extractAssetMentions ?? (() => [] as string[]);

    const symbol_verification = buildSymbolVerification(
        promptText,
        symbol,
        userProductId,
        extractor,
    );

    // Snapshot fetches require the plugin hooks.
    if (
        !provider?.fetchBookTicker ||
        !provider?.fetchDepth ||
        !provider?.fetch24hStats
    ) {
        return { symbol_verification };
    }

    // Race the three calls against the shared 600 ms budget. CEX
    // post-PR237 Commit 11 — pass `venue` so the dispatcher routes to
    // Binance vs Coinbase. Hook signature is overloaded: when `venue`
    // is undefined the legacy single-arg path runs (defaults Binance).
    const bookP = withTimeout(
        provider.fetchBookTicker(symbol, venue),
        latencyBudgetMs,
    );
    const depthP = withTimeout(
        provider.fetchDepth(symbol, 5, venue),
        latencyBudgetMs,
    );
    const statsP = withTimeout(
        provider.fetch24hStats(symbol, venue),
        latencyBudgetMs,
    );

    // `Promise.allSettled` here so a single timeout doesn't reject the
    // whole `Promise.all`. Each leg is already `withTimeout`-wrapped,
    // so a partial snapshot (e.g. book OK, depth slow) is possible.
    const [bookSettled, depthSettled, statsSettled] = await Promise.allSettled([
        bookP,
        depthP,
        statsP,
    ]);

    const book =
        bookSettled.status === "fulfilled" ? bookSettled.value : null;
    const depth =
        depthSettled.status === "fulfilled" ? depthSettled.value : null;
    const stats =
        statsSettled.status === "fulfilled" ? statsSettled.value : null;

    // If ALL three failed/timed-out, omit `market_snapshot` entirely
    // — the modal collapses the panel rather than rendering empty rows.
    if (!book && !depth && !stats) {
        return { symbol_verification };
    }

    const displaySymbol = formatVenueDisplaySymbol(symbol, venue);
    const snapshot: MarketSnapshot = {
        symbol: displaySymbol,
        fetched_at_ms: Date.now(),
    };

    if (book) {
        snapshot.bid = book.bid;
        snapshot.bid_qty = book.bidQty;
        snapshot.ask = book.ask;
        snapshot.ask_qty = book.askQty;
        snapshot.spread_bps = book.spread_bps;

        // est_fill_price + slippage_vs_limit_bps require both a side
        // and (for slippage) a limit price. Defensive: anything we
        // can't compute is simply omitted.
        if (actionName === "create_order" || actionName === "amend_order" || actionName === "preview_order") {
            const side = extractSide(actionParams);
            const bidNum = Number.parseFloat(book.bid);
            const askNum = Number.parseFloat(book.ask);
            if (side && Number.isFinite(bidNum) && Number.isFinite(askNum)) {
                const est = side === "BUY" ? askNum : bidNum;
                if (Number.isFinite(est) && est > 0) {
                    snapshot.est_fill_price = est;
                    const limit = extractLimitPriceFromAction(actionParams);
                    if (limit !== null && limit > 0) {
                        snapshot.slippage_vs_limit_bps =
                            ((est - limit) / limit) * 10_000;
                    }
                }
            }
        }
    }
    if (depth) {
        snapshot.depth_bids = depth.bids.map(([price, qty]) => ({ price, qty }));
        snapshot.depth_asks = depth.asks.map(([price, qty]) => ({ price, qty }));
    }
    if (stats) {
        snapshot.price_change_pct = stats.priceChangePercent;
        snapshot.high_24h = stats.highPrice;
        snapshot.low_24h = stats.lowPrice;
        snapshot.volume_24h = stats.volume;
        snapshot.quote_volume_24h = stats.quoteVolume;
    }

    return { market_snapshot: snapshot, symbol_verification };
}
