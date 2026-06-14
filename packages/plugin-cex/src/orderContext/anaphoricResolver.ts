/**
 * Multi-turn order-ID resolver. When the user says "cancel this order",
 * "the one you just showed", "撤销那个订单", etc., this scans the most
 * recent assistant memories for displayed order IDs and returns one.
 *
 * Strategy:
 *   1. Detect anaphoric phrases — pure-function pattern set.
 *   2. Walk memories most-recent-first.
 *   3. Parse markdown tables / single-order detail rows for order IDs.
 *   4. Prefer single-result memories (high confidence).
 *   5. Optional venue scoping.
 */

export interface AnaphoricResolverInput {
    messageText: string;
    locale: "en" | "zh-CN" | "mixed-en";
    recentAssistantMemories: Array<{ id: string; text: string; createdAt: number }>;
    venue?: string | null;
}

export interface AnaphoricResolverOutput {
    order_id: string;
    symbol?: string;
    unambiguous: boolean;
    sourceMemoryId: string;
}

/**
 * Batch resolver — extracts ALL orders from the most recent relevant
 * assistant memory. Used by "cancel all of these orders" style requests
 * where the caller needs every (order_id, symbol) pair.
 */
export interface BatchOrderResolverOutput {
    orders: Array<{ order_id: string; symbol?: string }>;
    sourceMemoryId: string;
}

const ANAPHORIC_PATTERNS_EN: RegExp[] = [
    /\b(this|that|the|those|these)\s+(order|one)\b/i,
    /\bthe\s+one\s+(you\s+)?(just\s+)?(showed|shown|displayed|listed)\b/i,
    /\bcancel\s+(it|this|that)\b/i,
    /\bsame\s+order\b/i,
    // M1 — "my latest order" / "the recent trade" / "my last buy" etc.
    // Round-5: allow up to two adjectives between the temporal word
    // and the noun ("my latest paper order", "my last open limit
    // order", "the recent BTC trade").
    /\b(?:my|the)\s+(?:latest|last|recent|newest|most\s+recent)(?:\s+\w+){0,2}\s+(?:order|trade|buy|sell|limit|stop)\b/i,
    /\b(?:the|that)\s+(?:recent|latest|last)\s+one\b/i,
    // M1-r2 — verb + my-latest WITHOUT an explicit noun
    // ("cancel my latest" / "kill the most recent" / "edit my last").
    /\b(?:cancel|kill|stop|abort|amend|modify|edit|change|adjust|close|exit)\s+(?:my|the|that|this)\s+(?:latest|last|recent|newest|most\s+recent)\b/i,
    // M1-r2 — bare "the latest" / "my last" when used after a trading verb.
    /\b(?:my|the)\s+(?:latest|last|recent|newest|most\s+recent)\b(?!\s+(?:news|message|email|chat))/i,
];

const ANAPHORIC_PATTERNS_ZH: RegExp[] = [
    /(那个|这个|刚才|刚刚|刚显示)/u,
    /撤(销|消)(它|那个|这个)/u,
    /取消(它|那个|这个)/u,
    // M1 — "my latest" / "the recent one" with explicit noun.
    /(?:我的)?(?:最近|最新|刚才|刚刚|刚下的)(?:那个|这个)?(?:订单|交易|买单|卖单)/u,
    // M1-r2 — verb + 最近/最新/刚 without explicit noun
    // (撤销最近的 / 取消刚才那个 / 改最新一个 / 撤掉那个最近的).
    /(?:撤销|撤销|撤消|取消|撤掉|改|修改)(?:我的?|那个|这个)?(?:最近|最新|刚才|刚刚|刚下的)(?:的|一个)?/u,
    // M1-r2 — bare "最新一个" / "最近那笔" anywhere.
    /(?:最新|最近)(?:那个|这个|一个|一笔|的那个)/u,
];

function isAnaphoric(text: string, locale: AnaphoricResolverInput["locale"]): boolean {
    if (locale === "zh-CN") {
        return (
            ANAPHORIC_PATTERNS_ZH.some((p) => p.test(text)) ||
            ANAPHORIC_PATTERNS_EN.some((p) => p.test(text))
        );
    }
    return ANAPHORIC_PATTERNS_EN.some((p) => p.test(text));
}

/**
 * Order IDs in this codebase look like:
 *   - Binance:  long digits (e.g., 61908270229)
 *   - Coinbase: uuid (e.g., 7d139d40-4e68-4e82-aed2-4e3895542ebf)
 *   - Paper:    paper-ord-<random>-<unix-ms>
 *               (e.g., paper-ord-aox4yzqu-1779228447000) — see
 *               `paperVenue.ts::newId`. The paper venue is a first-class
 *               citizen for "cancel my latest paper order" anaphor, so
 *               the resolver MUST recognize this shape; the QA round-5
 *               report flagged this as M1's open finding.
 * Client order IDs are different and excluded here.
 */
const ORDER_ID_PATTERNS: RegExp[] = [
    // Paper venue id — matched FIRST so a paper id whose timestamp suffix
    // happens to be ≥9 digits doesn't get truncated to just the numeric
    // tail by the Binance pattern below.
    /(paper-ord-[a-z0-9]+-\d{10,})/i,
    // UUID
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
    // Long numeric id (Binance) — at least 9 digits
    /\b([0-9]{9,})\b/,
];

/**
 * An order's lifecycle bucket, derived from the status word the agent
 * rendered next to the id:
 *   - "terminal": already filled / cancelled / rejected / expired — NOT
 *     cancellable (a cancel returns "Not Found" at the venue and wrongly
 *     pads the cancel table — the reported bug).
 *   - "open": new / open / pending / partially-filled — cancellable.
 *   - "unknown": no status word found near the id.
 */
type OrderLifecycle = "open" | "terminal" | "unknown";

/**
 * Classify an order row / line by its rendered status word. Order matters:
 * a "partially filled" order is still cancellable, so it must be checked
 * BEFORE the generic "filled" terminal match (which contains the word
 * "filled" and would otherwise swallow it).
 */
function classifyStatus(text: string): OrderLifecycle {
    if (/partial/i.test(text)) return "open"; // partially[_ -]filled → cancellable
    if (/pending[\s_-]?cancel/i.test(text)) return "terminal";
    if (
        /\b(?:filled|cancell?ed|canceled|rejected|expired|done|settled|closed)\b/i.test(
            text,
        )
    ) {
        return "terminal";
    }
    if (
        /\b(?:new|open|pending|accepted|working|untriggered|live|active|queued|placed|submitted)\b/i.test(
            text,
        )
    ) {
        return "open";
    }
    return "unknown";
}

interface ExtractedOrder {
    order_id: string;
    symbol?: string;
    status?: OrderLifecycle;
}

/**
 * Parse the assistant memory text and extract candidate orders.
 * Heuristic — looks for explicit "Order ID" or "Order ID:" labels,
 * markdown table rows with id-shaped cells, or compact key/value lines.
 */
function extractOrdersFromMemory(text: string): ExtractedOrder[] {
    const orders: ExtractedOrder[] = [];

    // 1) Lines with explicit "Order ID" label and an adjacent value.
    const labeled = text.split(/\r?\n/).filter((line) =>
        /\border\s*id\b/i.test(line) || /订单\s*ID/u.test(line),
    );
    for (const line of labeled) {
        for (const rx of ORDER_ID_PATTERNS) {
            const m = rx.exec(line);
            if (m && m[1]) {
                orders.push({ order_id: m[1], status: classifyStatus(line) });
                break;
            }
        }
    }

    // 2) Markdown table rows — look for `|` lines that contain an id pattern.
    if (orders.length === 0) {
        for (const line of text.split(/\r?\n/)) {
            if (!line.includes("|")) continue;
            const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
            if (cells.length < 2) continue;
            let foundId: string | undefined;
            let foundSymbol: string | undefined;
            let foundStatus: OrderLifecycle = "unknown";
            for (const cell of cells) {
                for (const rx of ORDER_ID_PATTERNS) {
                    const m = rx.exec(cell);
                    if (m && m[1] && !foundId) {
                        foundId = m[1];
                    }
                }
                const cellStatus = classifyStatus(cell);
                if (foundStatus === "unknown" && cellStatus !== "unknown") {
                    foundStatus = cellStatus;
                }
                // A status word ("FILLED" / "NEW") or a side ("BUY" / "SELL")
                // also matches the ticker shape below — skip those cells so
                // they aren't captured as the symbol.
                if (
                    !foundSymbol &&
                    cellStatus === "unknown" &&
                    !/^(?:BUY|SELL)$/i.test(cell) &&
                    /^[A-Z]{2,6}([-\/]?[A-Z]{2,6})?$/.test(cell)
                ) {
                    foundSymbol = cell;
                }
            }
            if (foundId)
                orders.push({
                    order_id: foundId,
                    symbol: foundSymbol,
                    status: foundStatus,
                });
        }
    }

    // Deduplicate.
    const seen = new Set<string>();
    return orders.filter((o) => {
        if (seen.has(o.order_id)) return false;
        seen.add(o.order_id);
        return true;
    });
}

/**
 * Filters orders by venue heuristically — Binance order IDs are
 * numeric, Coinbase are UUIDs. Returns the input unchanged when venue
 * is null. Paper-venue IDs (`paper-ord-…`) are always allowed
 * through regardless of the venue hint, because the paper venue is
 * not tied to a real exchange and "cancel my latest paper order on
 * binance" should still resolve to the paper id the agent just
 * showed.
 */
function filterByVenue(
    orders: ExtractedOrder[],
    venue: string | null | undefined,
): ExtractedOrder[] {
    if (!venue) return orders;
    const isPaper = (id: string) => /^paper-ord-/i.test(id);
    if (venue === "binance") {
        return orders.filter((o) => isPaper(o.order_id) || /^\d+$/.test(o.order_id));
    }
    if (venue === "coinbase") {
        return orders.filter((o) => isPaper(o.order_id) || /-/.test(o.order_id));
    }
    return orders;
}

export function resolveAnaphoricOrderId(
    input: AnaphoricResolverInput,
): AnaphoricResolverOutput | null {
    if (!isAnaphoric(input.messageText, input.locale)) return null;

    const memos = [...input.recentAssistantMemories].sort(
        (a, b) => b.createdAt - a.createdAt,
    );
    for (const memo of memos) {
        const all = extractOrdersFromMemory(memo.text);
        const filtered = filterByVenue(all, input.venue ?? null);
        if (filtered.length === 0) continue;
        // High-confidence: exactly one order visible in the memo.
        if (filtered.length === 1) {
            return {
                order_id: filtered[0].order_id,
                symbol: filtered[0].symbol,
                unambiguous: true,
                sourceMemoryId: memo.id,
            };
        }
        // Multiple orders → ambiguous; surface the first but flag it.
        return {
            order_id: filtered[0].order_id,
            symbol: filtered[0].symbol,
            unambiguous: false,
            sourceMemoryId: memo.id,
        };
    }
    return null;
}

/**
 * Multi-order resolver. Returns ALL order_id + symbol pairs visible in
 * the most recent assistant memory containing recognizable order rows.
 * Used by "cancel all of these orders" requests where Binance requires
 * a per-order symbol.
 */
export function resolveAllOrdersFromContext(
    input: AnaphoricResolverInput,
): BatchOrderResolverOutput | null {
    const memos = [...input.recentAssistantMemories].sort(
        (a, b) => b.createdAt - a.createdAt,
    );
    for (const memo of memos) {
        const all = extractOrdersFromMemory(memo.text);
        const filtered = filterByVenue(all, input.venue ?? null);
        if (filtered.length === 0) continue;
        // A batch cancel must only target cancellable orders. Drop rows whose
        // rendered status is terminal (filled / cancelled / rejected /
        // expired) — cancelling them returns "Not Found" at the venue and
        // wrongly pads the cancel table. Open + unknown-status rows are kept
        // (the venue stays the final arbiter). If this memo lists orders but
        // none are cancellable, skip it and look further back rather than
        // surfacing an all-terminal list to cancel.
        const cancellable = filtered.filter((o) => o.status !== "terminal");
        if (cancellable.length === 0) continue;
        return {
            orders: cancellable.map((o) => ({
                order_id: o.order_id,
                symbol: o.symbol,
            })),
            sourceMemoryId: memo.id,
        };
    }
    return null;
}

export interface SymbolForOrderIdInput {
    orderId: string;
    recentAssistantMemories: Array<{
        id: string;
        text: string;
        createdAt: number;
    }>;
    venue?: string | null;
}

export interface SymbolForOrderIdOutput {
    symbol: string;
    sourceMemoryId: string;
}

/**
 * Reverse lookup: given an explicit order id (the user typed it), find
 * the matching trading pair the agent recently displayed for that id.
 *
 * Why this exists: Binance's cancel endpoint requires the symbol, but
 * users naturally type "cancel order 61915077249" without one. Instead
 * of bouncing the request back with a clarification, we search recent
 * assistant memories — which almost always contain the symbol because
 * the user just looked the order up. This keeps the single-step
 * confirmation flow intact (form prefilled, no extra round-trip).
 *
 * Returns null when:
 *   - no memory mentions the id, or
 *   - the memory mentions the id but no recognizable symbol cell.
 *
 * In those cases, callers should fall back to clarification (which
 * this resolver does not produce).
 */
export function resolveSymbolForOrderId(
    input: SymbolForOrderIdInput,
): SymbolForOrderIdOutput | null {
    const target = input.orderId.trim();
    if (!target) return null;

    const memos = [...input.recentAssistantMemories].sort(
        (a, b) => b.createdAt - a.createdAt,
    );
    for (const memo of memos) {
        const all = extractOrdersFromMemory(memo.text);
        const filtered = filterByVenue(all, input.venue ?? null);
        // Look up the exact id, not the first one — assistant memories
        // can contain dozens of distinct rows from a get_orders table.
        const match = filtered.find((o) => o.order_id === target);
        if (match?.symbol) {
            return { symbol: match.symbol, sourceMemoryId: memo.id };
        }
    }
    return null;
}
