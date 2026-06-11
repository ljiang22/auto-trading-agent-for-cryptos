/**
 * Fix 10 — deterministic numeric extractor for the user's prompt.
 *
 * Regex-driven pre-LLM layer that pulls (value, unit, asset?) tuples
 * out of an EN or zh-CN message. Used by `cexWorkflowMessageHandler`
 * before the risk engine: the handler cross-checks the biggest user-typed
 * value against the LLM-extracted `base_size` / `quote_size` after unit
 * normalization. Divergence > MAX_VALUE_DIVERGENCE_PCT surfaces a
 * clarification before the approval modal renders.
 *
 * Design notes:
 *  - This is the FIRST step of Fix 14c, which will additionally extract
 *    asset names (not just numbers paired with assets). For now: paired
 *    only, plus bare numbers as `unit: "unknown"` (ranked last).
 *  - Thousands separators (`5,000`) are stripped. Decimals (`5.5`) keep.
 *  - Ordering: paired matches first (ranked by value desc), then bare
 *    numbers last. This lets the caller pick `result[0]` as the
 *    "biggest user-detected value" with the safe assumption that any
 *    asset-paired number outranks an unanchored "5".
 *  - Zero-value matches are dropped — the LLM almost never emits a
 *    literal `0` and matching them would just create false positives
 *    on contextual digits like "level 0".
 */

/** Divergence (LLM vs user) above which the cross-check fires. */
export const MAX_VALUE_DIVERGENCE_PCT = 0.05;

/**
 * Common spot-trading asset codes. Top-30 by symbol with the obvious
 * extras (stablecoins handled separately as `unit: "quote"`).
 */
const BASE_ASSET_TOKENS = [
    "BTC",
    "ETH",
    "SOL",
    "BNB",
    "XRP",
    "ADA",
    "DOGE",
    "MATIC",
    "DOT",
    "LTC",
    "AVAX",
    "LINK",
    "TRX",
    "BCH",
    "ATOM",
    "UNI",
    "ETC",
    "FIL",
    "XLM",
    "NEAR",
    "APT",
    "ARB",
    "OP",
    "SUI",
    "ICP",
    "TON",
    "HBAR",
    "INJ",
    "TIA",
    "SHIB",
    "PEPE",
] as const;

/**
 * Stablecoin / fiat-quote tokens. The cross-check treats any of these
 * as "quote" units; the asset code is preserved so a future
 * multi-stablecoin pricing layer can disambiguate (e.g. depeg).
 */
const QUOTE_ASSET_TOKENS = [
    "USDT",
    "USDC",
    "BUSD",
    "FDUSD",
    "TUSD",
    "DAI",
    "USD",
] as const;

/**
 * Simplified-Chinese aliases for the most common base assets. Sized to
 * cover the practical zh-CN-mode usage; deliberately small — the EN
 * codes are still preferred and most users mix them.
 */
const ZH_CN_BASE_ALIASES: Record<string, string> = {
    比特币: "BTC",
    以太坊: "ETH",
    以太币: "ETH",
    索拉纳: "SOL",
    索拉那: "SOL",
    币安币: "BNB",
    瑞波币: "XRP",
    狗狗币: "DOGE",
};

/**
 * Simplified-Chinese fiat-dollar tokens. `美元` is the literal "US
 * dollar"; `刀` is informal Chinese internet slang for the same.
 * Treated as `unit: "quote"` with no specific stablecoin (the
 * cross-check uses ticker price for normalization).
 */
const ZH_CN_QUOTE_DOLLAR_TOKENS = ["美元", "刀"] as const;

/**
 * A quantity matched out of the user's prompt.
 *
 * `unit` indicates how to interpret `value`:
 *  - `"base"` — value is in units of the asset (e.g. 5 BTC → 5 BTC).
 *  - `"quote"` — value is in the quote currency (USDT/USD/...).
 *  - `"unknown"` — bare number with no asset anchor.
 */
export interface ExtractedQuantity {
    value: number;
    unit: "base" | "quote" | "unknown";
    asset?: string;
}

/**
 * Strip thousands separators (`5,000` → `5000`) before `parseFloat`.
 * Decimal-comma locales (`5,5` → "5.5") are NOT supported; English
 * decimal points are the canonical form in chat input.
 */
function parseNumber(raw: string): number | null {
    const cleaned = raw.replace(/,/g, "");
    const n = Number.parseFloat(cleaned);
    if (!Number.isFinite(n)) return null;
    if (n === 0) return null;
    return n;
}

/**
 * Escape a string for safe embedding in a `RegExp`. The asset
 * vocabularies above are all alphanumeric/CJK, so this is mostly
 * defensive — but cheap and worth doing.
 */
function reEscape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The numeric literal pattern, shared across all builders:
 *  - optional sign omitted (orders are positive)
 *  - digits with optional thousands separators (`5,000.5`)
 *  - optional decimal portion
 *
 * The longer "plain integer" branch is first so `3000` doesn't lose its
 * trailing `00` to the thousands-separator branch (which matches `300`
 * before the next `,000` group can apply). Regex alternation is
 * left-to-right; the longer fixed branch must win for plain integers.
 */
const NUMBER_RE = "(\\d+(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

function buildBaseAssetRegex(): RegExp {
    const alternation = BASE_ASSET_TOKENS.map(reEscape).join("|");
    // Word-boundary on the EN side; case-insensitive.
    return new RegExp(`${NUMBER_RE}\\s*(${alternation})\\b`, "gi");
}

function buildQuoteAssetRegex(): RegExp {
    const alternation = QUOTE_ASSET_TOKENS.map(reEscape).join("|");
    return new RegExp(`${NUMBER_RE}\\s*(${alternation})\\b`, "gi");
}

function buildZhCnBaseRegex(): RegExp {
    const alternation = Object.keys(ZH_CN_BASE_ALIASES).map(reEscape).join("|");
    // CJK has no `\b` semantics; rely on the alternation list being a
    // closed vocabulary.
    return new RegExp(`${NUMBER_RE}\\s*(${alternation})`, "g");
}

function buildZhCnDollarRegex(): RegExp {
    const alternation = ZH_CN_QUOTE_DOLLAR_TOKENS.map(reEscape).join("|");
    return new RegExp(`${NUMBER_RE}\\s*(${alternation})`, "g");
}

/**
 * `$3000` / `$ 3000` — USD prefix form. Common in EN limit-price
 * phrasing ("Sell 0.5 ETH at $3000").
 */
const USD_PREFIX_RE = new RegExp(`\\$\\s*${NUMBER_RE}`, "g");

/**
 * Bare numeric literals — used to populate the `unknown` unit tail of
 * the result. The cross-check should not rely on these alone, but they
 * exist so callers can detect "the user definitely typed a number but
 * we can't tell which side of the trade".
 */
const BARE_NUMBER_RE = new RegExp(NUMBER_RE, "g");

/**
 * Marker for positions consumed by an earlier (anchored) match so the
 * bare-number sweep doesn't double-count them.
 */
interface MatchSpan {
    start: number;
    end: number;
}

function overlaps(span: MatchSpan, claimed: MatchSpan[]): boolean {
    for (const c of claimed) {
        if (span.start < c.end && span.end > c.start) return true;
    }
    return false;
}

/**
 * Main entry point.
 *
 * Returns paired (`base` / `quote`) matches first, ordered by value
 * descending so `result[0]` is the "biggest user-typed value" for the
 * cross-check. Bare numbers (unit `"unknown"`) follow, also descending.
 */
export function extractQuantitiesFromPrompt(text: string): ExtractedQuantity[] {
    if (!text || typeof text !== "string") return [];

    const paired: ExtractedQuantity[] = [];
    const claimed: MatchSpan[] = [];

    const sweep = (
        re: RegExp,
        unit: "base" | "quote",
        assetMapper: (raw: string) => string | undefined,
    ) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const value = parseNumber(m[1]!);
            const assetRaw = m[2]!;
            const asset = assetMapper(assetRaw);
            if (value === null) continue;
            paired.push({
                value,
                unit,
                ...(asset ? { asset } : {}),
            });
            claimed.push({ start: m.index, end: m.index + m[0].length });
        }
    };

    sweep(buildBaseAssetRegex(), "base", (raw) => raw.toUpperCase());
    sweep(buildQuoteAssetRegex(), "quote", (raw) => raw.toUpperCase());
    sweep(buildZhCnBaseRegex(), "base", (raw) => ZH_CN_BASE_ALIASES[raw]);
    sweep(buildZhCnDollarRegex(), "quote", () => "USD");

    // `$3000` style — USD prefix with no asset token after.
    USD_PREFIX_RE.lastIndex = 0;
    {
        let m: RegExpExecArray | null;
        while ((m = USD_PREFIX_RE.exec(text)) !== null) {
            const value = parseNumber(m[1]!);
            if (value === null) continue;
            paired.push({ value, unit: "quote", asset: "USD" });
            claimed.push({ start: m.index, end: m.index + m[0].length });
        }
    }

    // Bare numbers — only the ones NOT already claimed by an
    // anchored match above. These get `unit: "unknown"` and are
    // ranked last.
    const bare: ExtractedQuantity[] = [];
    BARE_NUMBER_RE.lastIndex = 0;
    {
        let m: RegExpExecArray | null;
        while ((m = BARE_NUMBER_RE.exec(text)) !== null) {
            const span: MatchSpan = {
                start: m.index,
                end: m.index + m[0].length,
            };
            if (overlaps(span, claimed)) continue;
            const value = parseNumber(m[1]!);
            if (value === null) continue;
            bare.push({ value, unit: "unknown" });
        }
    }

    paired.sort((a, b) => b.value - a.value);
    bare.sort((a, b) => b.value - a.value);
    return [...paired, ...bare];
}

/**
 * Convenience predicate — true iff the extractor surfaced at least one
 * paired (`base` or `quote`) quantity. The cross-check uses this to
 * stay conservative: bare numbers alone do not trigger a divergence
 * warning.
 */
export function hasAnchoredQuantity(qs: ExtractedQuantity[]): boolean {
    return qs.some((q) => q.unit === "base" || q.unit === "quote");
}

/**
 * Cross-check input. The handler builds this from the LLM-extracted
 * params (`base_size` or `quote_size`) and optionally the current
 * ticker price; the function returns whether the two diverge and the
 * normalized values it compared.
 */
export interface CrossCheckInput {
    promptText: string;
    /** LLM-extracted base size (string from order_configuration). */
    llmBaseSize?: number | string | null;
    /** LLM-extracted quote size (string from order_configuration). */
    llmQuoteSize?: number | string | null;
    /**
     * Best-effort mid-price in QUOTE per BASE (e.g. 60000 for BTC/USDT).
     * When present, the comparator can normalize across units; when
     * omitted, the comparator only fires on a direct base-vs-base or
     * quote-vs-quote match.
     */
    tickerPrice?: number | null;
    /**
     * CEX post-PR237 Commit 10 (Issue 14) — Executable price. When the
     * user typed an explicit limit price (e.g. "buy 10 usdt of btc at
     * 71000"), this is the price the order will land at. Cross-unit
     * normalization PREFERS this over `tickerPrice` because the LLM
     * uses the executable price for its own base↔quote conversion. If
     * we normalize with a stale ticker we double-count the lag and the
     * cross-check fires on a non-bug. Falls back to `tickerPrice` when
     * absent (market orders, no limit price typed).
     */
    executablePrice?: number | null;
    /**
     * CEX post-PR237 Commit 10 (Issue 14) — Base asset step size from
     * the exchange's LOT_SIZE / step_size filter (e.g. 0.00001 for
     * Binance BTCUSDT). When the LLM emits `base_size`, it is forced
     * to a multiple of `stepSize` by the venue or by client-side
     * quantization; the resulting quote-side error is bounded by
     * `stepSize * executablePrice / 2`. The comparator widens its
     * tolerance by that amount so an explainable rounding error does
     * not produce a clarification.
     */
    baseStepSize?: number | null;
}

export interface CrossCheckResult {
    divergent: boolean;
    /** The user-typed value the comparator used. */
    userValue?: number;
    userUnit?: "base" | "quote";
    /** The LLM value the comparator used (in the same unit as userValue). */
    llmValueNormalized?: number;
    /** Divergence as |user-llm|/max(|user|,|llm|). */
    divergenceRatio?: number;
    /** Diagnostic — null when the comparator skipped (no anchored user value, or no comparable LLM side). */
    reason?:
        | "no_user_anchored_value"
        | "no_llm_size"
        | "no_ticker_for_cross_unit"
        | "within_tolerance"
        | "divergence_exceeds_threshold";
}

function toNumber(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Compare the user's biggest detected quantity to the LLM-extracted
 * `base_size` / `quote_size`. Conservative: only flags when BOTH sides
 * have a clear value and the divergence exceeds
 * `MAX_VALUE_DIVERGENCE_PCT`.
 */
export function crossCheckUserIntent(input: CrossCheckInput): CrossCheckResult {
    const qs = extractQuantitiesFromPrompt(input.promptText);
    if (!hasAnchoredQuantity(qs)) {
        return { divergent: false, reason: "no_user_anchored_value" };
    }
    // Take the biggest anchored value — the most likely "size" the
    // user typed. Bare numbers are excluded by hasAnchoredQuantity.
    // `as const` narrowing on the filter predicate so `top.unit` is
    // typed as "base" | "quote" downstream.
    const anchored = qs.filter(
        (q): q is ExtractedQuantity & { unit: "base" | "quote" } =>
            q.unit === "base" || q.unit === "quote",
    );
    const top = anchored[0]!;

    const llmBase = toNumber(input.llmBaseSize ?? null);
    const llmQuote = toNumber(input.llmQuoteSize ?? null);

    if (llmBase === null && llmQuote === null) {
        return { divergent: false, reason: "no_llm_size" };
    }

    // CEX post-PR237 Commit 10 — prefer the executable (limit) price
    // when present; the LLM uses it for its own base↔quote rounding
    // so cross-unit normalization with the same anchor avoids
    // false-positive divergences driven by ticker lag.
    const normalizationPrice =
        typeof input.executablePrice === "number" && input.executablePrice > 0
            ? input.executablePrice
            : typeof input.tickerPrice === "number" && input.tickerPrice > 0
              ? input.tickerPrice
              : null;

    // Pick the LLM-side value that matches the user-side unit. If they
    // disagree (user typed BTC, LLM produced USDT), normalize via the
    // executable / ticker price. If we lack a price anchor, skip.
    let llmInUserUnit: number | null = null;
    if (top.unit === "base") {
        if (llmBase !== null) {
            llmInUserUnit = llmBase;
        } else if (llmQuote !== null && normalizationPrice !== null) {
            llmInUserUnit = llmQuote / normalizationPrice;
        }
    } else {
        // top.unit === "quote"
        if (llmQuote !== null) {
            llmInUserUnit = llmQuote;
        } else if (llmBase !== null && normalizationPrice !== null) {
            llmInUserUnit = llmBase * normalizationPrice;
        }
    }

    if (llmInUserUnit === null) {
        return { divergent: false, reason: "no_ticker_for_cross_unit" };
    }

    const denom = Math.max(Math.abs(top.value), Math.abs(llmInUserUnit));
    if (denom === 0) {
        return {
            divergent: false,
            userValue: top.value,
            userUnit: top.unit,
            llmValueNormalized: llmInUserUnit,
            reason: "within_tolerance",
        };
    }
    const divergence = Math.abs(top.value - llmInUserUnit) / denom;

    // CEX post-PR237 Commit 10 — quantization tolerance. When the LLM
    // emits a quantized `base_size` (rounded to the venue's LOT_SIZE)
    // and we compared on the quote side, the resulting quote-side
    // error is bounded by stepSize * normalizationPrice / 2. Convert
    // that absolute error to a fractional tolerance against the
    // denominator the comparator already uses.
    let effectiveThreshold = MAX_VALUE_DIVERGENCE_PCT;
    if (
        typeof input.baseStepSize === "number" &&
        input.baseStepSize > 0 &&
        normalizationPrice !== null
    ) {
        // Allow up to one whole step of noise on either side. This is
        // intentionally generous (1 step, not ½) so an LLM that floor-
        // rounded instead of round-half-up still slips through.
        const stepNoiseQuote = input.baseStepSize * normalizationPrice;
        const stepNoiseFraction = stepNoiseQuote / denom;
        // Cap the bump so a pathologically large step_size can't fully
        // disable the check. 25% (0.25) is well below "obvious bug"
        // territory and well above any real-world rounding error.
        effectiveThreshold = Math.min(
            0.25,
            effectiveThreshold + stepNoiseFraction,
        );
    }

    if (divergence > effectiveThreshold) {
        return {
            divergent: true,
            userValue: top.value,
            userUnit: top.unit,
            llmValueNormalized: llmInUserUnit,
            divergenceRatio: divergence,
            reason: "divergence_exceeds_threshold",
        };
    }
    return {
        divergent: false,
        userValue: top.value,
        userUnit: top.unit,
        llmValueNormalized: llmInUserUnit,
        divergenceRatio: divergence,
        reason: "within_tolerance",
    };
}

/**
 * Fix 14c — asset-name extractor.
 *
 * Returns the de-duped, upper-case list of base-asset mentions the user
 * typed. Used by the symbol-verification guard in
 * `requestParameterReview` to confirm the LLM's extracted symbol
 * actually contains an asset the user named. Distinct from
 * {@link extractQuantitiesFromPrompt} (which requires a numeric anchor)
 * — a message like "What's the price of BTC?" surfaces `["BTC"]` here
 * but `[]` there.
 *
 * Recognized forms (case-insensitive):
 *  - Bare EN codes: `BTC`, `ETH`, `SOL`, ... (the same vocabulary used
 *    by the numeric extractor).
 *  - Pair forms: `BTC-USDT`, `BTC/USDT`, `BTCUSDT` (concatenated).
 *  - zh-CN aliases: `比特币`, `以太坊`, `以太币`, `索拉纳`, `币安币`, ...
 *
 * The pair-concatenated form (`BTCUSDT`) is handled by scanning for any
 * BASE_ASSET_TOKEN as a prefix of a longer alphanumeric run that ends
 * in a known QUOTE_ASSET_TOKEN. Pair-separated forms (`BTC-USDT`,
 * `BTC/USDT`) are stripped down to the base. We do NOT return quote
 * tokens here — the symbol-verification guard only cares whether the
 * user's intended BASE asset matches the extractor's product_id.
 */
export function extractAssetMentions(text: string): string[] {
    if (!text || typeof text !== "string") return [];

    const found = new Set<string>();
    const upper = text.toUpperCase();

    // EN base codes — word-boundary so `MATIC` doesn't fire on `MATICAL`.
    // Note: word-boundary semantics apply since these are alphanumeric.
    for (const token of BASE_ASSET_TOKENS) {
        const re = new RegExp(`\\b${reEscape(token)}\\b`, "g");
        if (re.test(upper)) found.add(token);
    }

    // Pair-separated forms — `BTC-USDT` / `BTC/USDT`. The `\b` rules
    // out runs like `XBTC-USDT` while keeping the base token.
    {
        const baseAlt = BASE_ASSET_TOKENS.map(reEscape).join("|");
        const quoteAlt = QUOTE_ASSET_TOKENS.map(reEscape).join("|");
        const re = new RegExp(`\\b(${baseAlt})[-/](${quoteAlt})\\b`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(upper)) !== null) {
            if (m[1]) found.add(m[1]);
        }
    }

    // Pair-concatenated forms — `BTCUSDT`. We need an explicit pattern
    // because the bare `\bBTC\b` will not match inside `BTCUSDT`.
    {
        const baseAlt = BASE_ASSET_TOKENS.map(reEscape).join("|");
        const quoteAlt = QUOTE_ASSET_TOKENS.map(reEscape).join("|");
        const re = new RegExp(`\\b(${baseAlt})(${quoteAlt})\\b`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(upper)) !== null) {
            if (m[1]) found.add(m[1]);
        }
    }

    // zh-CN aliases — closed vocabulary, no `\b` semantics for CJK.
    for (const [alias, base] of Object.entries(ZH_CN_BASE_ALIASES)) {
        if (text.includes(alias)) found.add(base);
    }

    return Array.from(found).sort();
}
