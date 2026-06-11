import type {
    AdkAmendOrderInput,
    AdkCancelOrderInput,
    AdkCreateOrderInput,
    AdkGetBalanceInput,
    AdkGetFillsInput,
    AdkGetOrdersInput,
    AdkPreviewOrderInput,
    AdkToolName,
} from "./types";

const SYMBOL_PATTERNS: Array<{ rx: RegExp; symbolFromMatch: (m: RegExpExecArray) => string }> = [
    // BTC-USD, ETH-USD, etc. (Coinbase canonical)
    {
        rx: /\b([A-Z]{2,6})[-\/]([A-Z]{2,6})\b/,
        symbolFromMatch: (m) => `${m[1]}-${m[2]}`,
    },
    // BTCUSD, BTCUSDT (Binance canonical)
    {
        rx: /\b(BTC|ETH|SOL|XRP|ADA|DOGE|MATIC|LINK|DOT|AVAX|BNB|LTC|TRX|UNI|ATOM)(USDT|USDC|USD|BUSD)\b/i,
        symbolFromMatch: (m) => `${m[1].toUpperCase()}${m[2].toUpperCase()}`,
    },
    // bare "BTC", "ETH" (used by balance queries where no pair is implied)
    {
        rx: /\b(BTC|ETH|SOL|XRP|ADA|DOGE|MATIC|LINK|DOT|AVAX|BNB|LTC|USDT|USDC)\b/i,
        symbolFromMatch: (m) => m[1].toUpperCase(),
    },
];

function extractSymbol(text: string): string | undefined {
    for (const pat of SYMBOL_PATTERNS) {
        const m = pat.rx.exec(text);
        if (m) return pat.symbolFromMatch(m);
    }
    return undefined;
}

function extractSide(text: string): "BUY" | "SELL" | undefined {
    if (/\b(sell|short)\b/i.test(text) || /(卖|做空)/u.test(text)) return "SELL";
    if (/\b(buy|long)\b/i.test(text) || /(买|做多)/u.test(text)) return "BUY";
    return undefined;
}

function extractNumeric(text: string, label: RegExp): string | undefined {
    const m = label.exec(text);
    if (!m) return undefined;
    const num = /([0-9]+(?:\.[0-9]+)?)/.exec(m[0]);
    return num?.[1];
}

/** Generic number extraction near a keyword like "buy 0.001 btc". */
function extractFirstNumberAdjacentTo(
    text: string,
    keyword: RegExp,
): string | undefined {
    const m = keyword.exec(text);
    if (!m) return undefined;
    const after = text.slice(m.index);
    const num = /([0-9]+(?:\.[0-9]+)?)/.exec(after);
    return num?.[1];
}

function extractBaseSize(text: string): string | undefined {
    return (
        extractFirstNumberAdjacentTo(text, /\b(buy|sell|long|short)\b/i) ??
        extractFirstNumberAdjacentTo(text, /(买|卖|做多|做空)/u) ??
        extractNumeric(text, /\b(?:size|amount|quantity|qty)\s*[:=]?\s*[0-9]/i)
    );
}

function extractQuoteSize(text: string): string | undefined {
    // Patterns like "$50 BTC" or "spend 100 USDT"
    const dollarMatch = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
    if (dollarMatch) return dollarMatch[1];
    const m = /\b(?:spend|worth|of)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:USD|USDT|USDC|BUSD)?\b/i.exec(
        text,
    );
    return m?.[1];
}

function extractLimitPrice(text: string): string | undefined {
    const m = /\b(?:at|@|limit|price)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
    if (m && !/market/i.test(text)) return m[1];
    return undefined;
}

function extractStopPrice(text: string): string | undefined {
    const m = /\bstop\s*(?:price|loss|sl)?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text);
    return m?.[1];
}

/**
 * Extract a venue order id from free-form text.
 *
 * Recognised shapes (English + Chinese, case-insensitive):
 *   - "order 61914026151" / "order id 61914026151" / "order id: 61914026151"
 *   - "cancel 61914026151" / "amend 61914026151"
 *   - "订单 61914026151" / "订单号 61914026151"
 *   - "取消 61914026151" / "撤销 61914026151"
 *   - bare long numeric id (≥9 digits) as a last resort
 *
 * Returns the longest plausible match. Two false-positive guards apply:
 *   1. Bare verb forms ("cancel <token>", "amend <token>", "modify
 *      <token>") additionally require the captured token to contain a
 *      digit or a hyphen — otherwise English phrases like "cancel
 *      everything" or "amend portfolio settings" would be treated as
 *      order ids and fast-pathed straight to the venue.
 *   2. The naked long-numeric fallback is gated to ≥9 digits, so a
 *      price like "60000" or a size like "0.01" can never slip through.
 *
 * The "order <token>" branch stays loose — the literal word "order"
 * is itself a strong intent signal, and Binance/Coinbase ids in
 * documented UX never look like English words after that keyword.
 */
function extractOrderId(text: string): string | undefined {
    const all = extractOrderIds(text);
    return all.length === 0 ? undefined : all[0];
}

/**
 * Extract every plausible order id from the user message. Used by the
 * cancel_order fast path so "cancel order 62172026003, 62172209444"
 * surfaces both ids in the approval modal (and not just the first).
 *
 * Strategy:
 *   1. Find an anchored first id via the same shapes `extractOrderId`
 *      already covers (the `order`/`cancel`/Chinese forms).
 *   2. Scan FORWARD from the end of the anchored match for additional
 *      ids that are joined by list separators only (`,` `&` `and` `、`
 *      `和` `与`, whitespace). Stop at the first non-separator word so
 *      "nonce 999999999" never gets pulled into the list.
 *   3. If no anchored match exists, fall back to a single naked
 *      long-numeric scan (≥9 digits) — preserves the original
 *      `extractOrderId` fallback shape.
 *
 * De-duplicates while preserving first-seen order so the modal renders
 * ids in the order the user typed them.
 */
export function extractOrderIds(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (value: string | undefined): boolean => {
        if (!value || value.length < 6) return false;
        if (seen.has(value)) return false;
        seen.add(value);
        out.push(value);
        return true;
    };

    type Anchor = { id: string; endIndex: number; needsDigitGuard: boolean };
    const anchors: Anchor[] = [];

    const enOrderRe =
        /\border(?:\s+id)?s?\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/gi;
    for (const m of text.matchAll(enOrderRe)) {
        if (m.index === undefined) continue;
        anchors.push({
            id: m[1],
            endIndex: m.index + m[0].length,
            needsDigitGuard: false,
        });
    }

    const enVerbRe = /\b(?:cancel|amend|modify)\s+([A-Za-z0-9_-]{6,})\b/gi;
    for (const m of text.matchAll(enVerbRe)) {
        if (m.index === undefined) continue;
        if (!/[\d-]/.test(m[1])) continue;
        anchors.push({
            id: m[1],
            endIndex: m.index + m[0].length,
            needsDigitGuard: true,
        });
    }

    const zhRe =
        /(?:订单(?:号|ID|id)?|取消|撤销|撤单|修改|更改)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/gu;
    for (const m of text.matchAll(zhRe)) {
        if (m.index === undefined) continue;
        anchors.push({
            id: m[1],
            endIndex: m.index + m[0].length,
            needsDigitGuard: false,
        });
    }

    anchors.sort((a, b) => a.endIndex - b.endIndex);
    for (const anchor of anchors) {
        push(anchor.id);
        // Walk the comma/conjunction-separated tail. Each iteration
        // consumes one optional separator (`,` `;` `&` `、` `and` `和`
        // `与`) plus whitespace, then one id token. Stop as soon as
        // we hit anything else — that's how "nonce 999999999" is
        // excluded from "cancel order 61914026151 nonce 999999999".
        const tailRe = /^[\s,;]*(?:(?:and|or|&|和|与|、)[\s,;]*)?([A-Za-z0-9][A-Za-z0-9_-]{5,})/i;
        let cursor = anchor.endIndex;
        for (;;) {
            const slice = text.slice(cursor);
            const m = tailRe.exec(slice);
            if (!m) break;
            const candidate = m[1];
            // Skip continuation tokens that are clearly English words
            // (no digit, no hyphen) — protects against "cancel <verb>
            // <english-noun>" turning into a 2-id list.
            if (!/[\d-]/.test(candidate)) break;
            push(candidate); // dedupes; continue walking the list either way
            cursor += m.index + m[0].length;
        }
    }

    if (out.length === 0) {
        // Single naked long-numeric fallback (Binance ids are 11+ digits).
        // Mirrors the original extractOrderId fallback so prompts like
        // "61914026151" alone still resolve.
        const longNumeric = /(?<![.\d])(\d{9,})(?!\.\d)/.exec(text);
        if (longNumeric) push(longNumeric[1]);
    }

    return out;
}

function isMarket(text: string): boolean {
    return /\bmarket\b/i.test(text) || /市价/i.test(text);
}

function isLimit(text: string): boolean {
    return /\blimit\b/i.test(text) || /限价/i.test(text);
}

/**
 * Issue 4 (post-PR237 hotfix) — wallet scope detection for the
 * synchronous fast path. Mirrors the decomposer LLM rules in
 * `cexDecomposeTemplate.ts` so a single-action prompt ("show my spot
 * balance") and a multi-step plan produce the same canonical
 * `wallet_type` value.
 *
 * The matching is intentionally narrow: only fires when the user names
 * a specific wallet. A bare "show my balance" / "what's my margin
 * balance" stays ambiguous and falls through to the multi-wallet
 * fan-out — same behaviour the decomposer enforces with its "omit
 * `wallet_type`" rule.
 */
export function extractWalletTypeFilter(
    text: string,
): AdkGetBalanceInput["wallet_type"] {
    if (!text) return undefined;
    const lower = text.toLowerCase();
    if (/\bisolated\s*(margin|wallet|balance|account)?\b/i.test(lower)) {
        return "margin_isolated";
    }
    if (/\bcross\s*(margin|wallet|balance|account)?\b/i.test(lower)) {
        return "margin_cross";
    }
    if (/\bfunding\s*(wallet|balance|account)?\b/i.test(lower)) {
        return "funding";
    }
    if (/\bspot\s*(wallet|balance|account|only)?\b/i.test(lower)) {
        return "spot";
    }
    return undefined;
}

export function extractGetBalanceInput(text: string): AdkGetBalanceInput {
    const symbol = extractSymbol(text);
    const wallet_type = extractWalletTypeFilter(text);
    const out: AdkGetBalanceInput = {};
    if (symbol) {
        out.symbol = symbol;
        out.asset = symbol;
    }
    if (wallet_type) out.wallet_type = wallet_type;
    return out;
}

export function extractGetOrdersInput(text: string): AdkGetOrdersInput {
    const symbol = extractSymbol(text);
    const status: AdkGetOrdersInput["status"] = /\bopen\b/i.test(text)
        ? "open"
        : /\bfilled\b/i.test(text)
          ? "filled"
          : /\bcancelled?\b/i.test(text)
            ? "cancelled"
            : undefined;
    return { symbol, status };
}

export function extractGetFillsInput(text: string): AdkGetFillsInput {
    const symbol = extractSymbol(text);
    const order_id = extractOrderId(text);
    return { symbol, order_id };
}

export function extractCancelOrderInput(
    text: string,
): AdkCancelOrderInput | { needsClarification: true; reason: string } {
    const order_ids = extractOrderIds(text);
    if (order_ids.length === 0) {
        return {
            needsClarification: true,
            reason: "missing_order_id",
        };
    }
    return { order_ids, symbol: extractSymbol(text) };
}

export function extractAmendOrderInput(
    text: string,
): AdkAmendOrderInput | { needsClarification: true; reason: string } {
    const order_id = extractOrderId(text);
    if (!order_id) {
        return {
            needsClarification: true,
            reason: "missing_order_id",
        };
    }
    return {
        order_id,
        symbol: extractSymbol(text),
        new_limit_price: extractLimitPrice(text),
        new_base_size: extractBaseSize(text),
    };
}

export function extractCreateOrderInput(
    text: string,
):
    | AdkCreateOrderInput
    | { needsClarification: true; reason: string } {
    // F10.6 — defaults over clarifications. Only `side` and `size` are
    // mandatory for the deterministic-classifier path; missing pair or
    // missing limit price flow through with sentinels and the
    // server's `applyComposeDefaults` (cexWorkflowMessageHandler) fills
    // the canonical defaults — BTC-USDT for symbol, 80 %-of-mid for
    // limit_price — which the user then sees + can edit in the
    // approval modal. The modal IS the editable confirmation, so
    // re-asking for these two fields is a redundant round-trip.
    const side = extractSide(text);
    if (!side) {
        return { needsClarification: true, reason: "missing_side" };
    }
    const symbol = extractSymbol(text) ?? "BTC-USDT";
    const base_size = extractBaseSize(text);
    const quote_size = extractQuoteSize(text);
    if (!base_size && !quote_size) {
        return { needsClarification: true, reason: "missing_size" };
    }
    const order_type: AdkCreateOrderInput["order_type"] = isMarket(text)
        ? "market"
        : isLimit(text) || extractLimitPrice(text)
          ? "limit"
          : "market";
    // For limit orders without an explicit price: leave `limit_price`
    // undefined and let the server fill the 80 %-of-mid placeholder
    // via `applyComposeDefaults`. The approval modal renders the
    // editable price field so the user can adjust before confirming.
    const limit_price = order_type === "limit" ? extractLimitPrice(text) : undefined;
    return {
        side,
        symbol,
        order_type,
        base_size,
        quote_size,
        limit_price,
        stop_price: extractStopPrice(text),
    };
}

export function extractPreviewOrderInput(
    text: string,
):
    | AdkPreviewOrderInput
    | { needsClarification: true; reason: string } {
    return extractCreateOrderInput(text);
}

export type ExtractionResult<T> =
    | { kind: "ok"; input: T }
    | { kind: "needs_clarification"; reason: string };

// F7 — re-export the confidence gate + LLM extractor so the orchestrator
// (`tradingSubAgent.ts` / `runTradingSubAgent`) can decide on a per-call
// basis whether to upgrade the regex result with an LLM pass.
export {
    assessRegexConfidence,
    llmExtractCreateOrderFields,
    mergeCreateOrderExtraction,
} from "./llmParameterExtractor";

export function extractForTool(
    tool: AdkToolName,
    text: string,
): ExtractionResult<unknown> {
    let result:
        | AdkCreateOrderInput
        | AdkPreviewOrderInput
        | AdkCancelOrderInput
        | AdkAmendOrderInput
        | AdkGetBalanceInput
        | AdkGetOrdersInput
        | AdkGetFillsInput
        | { needsClarification: true; reason: string };

    switch (tool) {
        case "get_balance":
            result = extractGetBalanceInput(text);
            break;
        case "get_orders":
            result = extractGetOrdersInput(text);
            break;
        case "get_fills":
            result = extractGetFillsInput(text);
            break;
        case "create_order":
            result = extractCreateOrderInput(text);
            break;
        case "cancel_order":
            result = extractCancelOrderInput(text);
            break;
        case "amend_order":
            result = extractAmendOrderInput(text);
            break;
        case "preview_order":
            result = extractPreviewOrderInput(text);
            break;
    }
    if (typeof result === "object" && result && "needsClarification" in result) {
        return { kind: "needs_clarification", reason: result.reason };
    }
    return { kind: "ok", input: result };
}
