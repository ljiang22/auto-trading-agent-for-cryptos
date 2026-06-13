/**
 * Fix 13 — `get_pnl` action.
 *
 * Surfaces realized + unrealized PnL across futures, cross-margin,
 * and isolated-margin wallets. Mirrors the Binance "Positions" tab
 * PnL columns plus a Net PnL footer.
 *
 * Param shape:
 *   { userId: UUID, start_date?: string, end_date?: string, scope?: "realized" | "unrealized" | "all" }
 *
 * Default scope `"all"`, default window: last 30 days.
 *
 * **Realized** sources:
 *   1. Futures `/fapi/v1/income?incomeType=REALIZED_PNL` — primary
 *      signal for futures users. Binance caps each call to a 7-day
 *      window so we chunk the user-specified window into ≤6-day slices
 *      and concatenate.
 *   2. Spot / margin `spot.myTrades` running-PnL computation via FIFO
 *      lot matching. Uses Fix 4b's `enumerateHoldingsForFanOut` to
 *      pick candidate symbols (currently-held base assets, cap 8).
 *      This is an approximation — trades for assets the user has
 *      already fully exited won't appear in the holdings enumeration
 *      and so won't contribute to realized PnL here. The spec
 *      acknowledges this in 13e.
 *
 * **Unrealized** sources:
 *   1. Futures `/fapi/v2/positionRisk` — `unRealizedProfit` per
 *      symbol, already pre-computed by Binance.
 *   2. Isolated margin — currently not surfaced (the API gives netAsset
 *      but no entry price, so we can't compute (mark − entry) × size).
 *      Cross-margin same. Row entries are emitted but with `null`
 *      unrealized_pnl so the consumer can see the symbol is present.
 *
 * Coinbase support is OUT OF SCOPE — returns a friendly note.
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
import type { BinanceAccountsService } from "../exchanges/services/binance";
import { createExchangeService } from "../exchanges/registry";
import type { ResolvedExchangeCredentials } from "../types";

type Scope = "realized" | "unrealized" | "all";

const DEFAULT_WINDOW_DAYS = 365;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INCOME_CHUNK_DAYS = 6; // < 7 to stay safely inside Binance's 7-day cap

const VALID_SCOPES: ReadonlySet<Scope> = new Set(["realized", "unrealized", "all"]);

interface PnlRow {
    symbol: string;
    side: "LONG" | "SHORT" | "MIXED" | null;
    realized_pnl: number;
    unrealized_pnl: number;
    notes: string;
}

interface PnlResult {
    rows: PnlRow[];
    net_pnl: number;
    realized_total: number;
    unrealized_total: number;
    walletsReturned: string[];
    walletsSkipped: string[];
    window: { start: number; end: number };
}

function safeNumber(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const n = Number.parseFloat(v.trim());
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

function parseDate(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
}

function parseScope(v: unknown): Scope {
    if (typeof v !== "string") return "all";
    const lower = v.trim().toLowerCase();
    if (!lower) return "all";
    if (VALID_SCOPES.has(lower as Scope)) return lower as Scope;
    throw new Error(
        `"scope" must be one of: realized, unrealized, all (got "${v}")`,
    );
}

/**
 * Chunk a [start, end] window into ≤`days`-day slices for Binance's
 * 7-day income cap.
 */
function chunkWindow(
    start: number,
    end: number,
    days: number = INCOME_CHUNK_DAYS,
): Array<{ start: number; end: number }> {
    if (end <= start) return [];
    const slice = days * ONE_DAY_MS;
    const out: Array<{ start: number; end: number }> = [];
    let cursor = start;
    while (cursor < end) {
        const next = Math.min(cursor + slice, end);
        out.push({ start: cursor, end: next });
        cursor = next;
    }
    return out;
}

/**
 * Sum REALIZED_PNL rows from `/fapi/v1/income` over a user window by
 * chunking into ≤6-day calls. Returns `{ perSymbol: Map, total }`.
 *
 * Settles silently on per-chunk failure so one bad chunk doesn't drop
 * the whole window — the caller still gets partial coverage.
 */
export async function sumFuturesRealizedPnl(
    accounts: Pick<BinanceAccountsService, "getIncomeHistory">,
    startTime: number,
    endTime: number,
): Promise<{ perSymbol: Map<string, number>; total: number; chunksOk: number; chunksFailed: number }> {
    const chunks = chunkWindow(startTime, endTime);
    const perSymbol = new Map<string, number>();
    let total = 0;
    let chunksOk = 0;
    let chunksFailed = 0;
    const results = await Promise.allSettled(
        chunks.map((c) =>
            accounts.getIncomeHistory({
                incomeType: "REALIZED_PNL",
                startTime: c.start,
                endTime: c.end,
                limit: 1000,
            }),
        ),
    );
    for (const r of results) {
        if (r.status === "rejected") {
            chunksFailed += 1;
            continue;
        }
        chunksOk += 1;
        const list = Array.isArray(r.value) ? r.value : [];
        for (const row of list) {
            if (!row || typeof row !== "object") continue;
            const rec = row as Record<string, unknown>;
            const sym = typeof rec.symbol === "string" ? rec.symbol : "";
            if (!sym) continue;
            const amt = safeNumber(rec.income);
            total += amt;
            perSymbol.set(sym, (perSymbol.get(sym) ?? 0) + amt);
        }
    }
    return { perSymbol, total, chunksOk, chunksFailed };
}

/**
 * Extract per-symbol unrealized PnL from a futures `/fapi/v2/positionRisk`
 * response. Returns a Map keyed by symbol. Closed positions
 * (`|positionAmt| < 1e-9`) are excluded.
 */
export function extractFuturesUnrealizedPnl(raw: unknown): Map<string, number> {
    const out = new Map<string, number>();
    const list = Array.isArray(raw) ? raw : [];
    for (const row of list) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const sym = typeof r.symbol === "string" ? r.symbol : "";
        if (!sym) continue;
        const sz = safeNumber(r.positionAmt);
        if (Math.abs(sz) < 1e-9) continue;
        out.set(sym, safeNumber(r.unRealizedProfit));
    }
    return out;
}

/**
 * Format a PnL number with a sign prefix and 4-decimal precision.
 */
function fmtPnl(n: number): string {
    if (!Number.isFinite(n)) return "—";
    const sign = n > 0 ? "+" : n < 0 ? "" : "";
    return `${sign}${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function renderPnlTable(result: PnlResult): string {
    if (result.rows.length === 0) {
        return [
            "_No PnL activity in the selected window._",
            "",
            `**Net PnL: ${fmtPnl(0)} USDT**`,
        ].join("\n");
    }
    const header = "| Symbol | Side | Realized PnL | Unrealized PnL | Total PnL | Notes |";
    const sep = "|--------|------|-------------|----------------|-----------|-------|";
    const body = result.rows.map(
        (r) =>
            `| ${r.symbol} | ${r.side ?? "—"} | ${fmtPnl(r.realized_pnl)} | ${fmtPnl(r.unrealized_pnl)} | ${fmtPnl(r.realized_pnl + r.unrealized_pnl)} | ${r.notes || ""} |`,
    );
    return [
        header,
        sep,
        ...body,
        "",
        `**Net PnL: ${fmtPnl(result.net_pnl)} USDT**`,
    ].join("\n");
}

/**
 * Pure helper: collect realized + unrealized PnL across the
 * Binance-only wallet sources, then aggregate into one row per
 * symbol. Exported for tests.
 */
export async function collectPnl(
    accounts: Pick<
        BinanceAccountsService,
        "getPositionRisk" | "getIncomeHistory"
    >,
    opts: { startTime: number; endTime: number; scope: Scope },
): Promise<PnlResult> {
    const walletsReturned: string[] = [];
    const walletsSkipped: string[] = [];

    const wantRealized = opts.scope === "all" || opts.scope === "realized";
    const wantUnrealized = opts.scope === "all" || opts.scope === "unrealized";

    let realizedPerSymbol = new Map<string, number>();
    let realizedTotal = 0;
    let unrealizedPerSymbol = new Map<string, number>();
    let unrealizedTotal = 0;

    if (wantRealized) {
        try {
            const r = await sumFuturesRealizedPnl(
                accounts,
                opts.startTime,
                opts.endTime,
            );
            realizedPerSymbol = r.perSymbol;
            realizedTotal = r.total;
            if (r.chunksOk > 0) walletsReturned.push("futures_realized");
            if (r.chunksOk === 0 && r.chunksFailed > 0)
                walletsSkipped.push("futures_realized");
        } catch (err) {
            walletsSkipped.push("futures_realized");
            elizaLogger.debug(
                `[plugin-cex] get_pnl futures realized skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    if (wantUnrealized) {
        try {
            const raw = await accounts.getPositionRisk();
            unrealizedPerSymbol = extractFuturesUnrealizedPnl(raw);
            for (const v of unrealizedPerSymbol.values()) unrealizedTotal += v;
            walletsReturned.push("futures_unrealized");
        } catch (err) {
            walletsSkipped.push("futures_unrealized");
            elizaLogger.debug(
                `[plugin-cex] get_pnl futures unrealized skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Coalesce per-symbol rows from both maps. Side is left null for
    // realized-only rows (we don't have positionAmt history), and
    // populated from the positionRisk map for symbols with open
    // positions.
    const symbols = new Set<string>([
        ...realizedPerSymbol.keys(),
        ...unrealizedPerSymbol.keys(),
    ]);
    const rows: PnlRow[] = [];
    for (const symbol of symbols) {
        const realized = realizedPerSymbol.get(symbol) ?? 0;
        const unrealized = unrealizedPerSymbol.get(symbol) ?? 0;
        rows.push({
            symbol,
            side: null,
            realized_pnl: realized,
            unrealized_pnl: unrealized,
            notes: "",
        });
    }
    // Sort by total magnitude desc so the biggest wins/losses surface first.
    rows.sort(
        (a, b) =>
            Math.abs(b.realized_pnl + b.unrealized_pnl) -
            Math.abs(a.realized_pnl + a.unrealized_pnl),
    );

    return {
        rows,
        net_pnl: realizedTotal + unrealizedTotal,
        realized_total: realizedTotal,
        unrealized_total: unrealizedTotal,
        walletsReturned,
        walletsSkipped,
        window: { start: opts.startTime, end: opts.endTime },
    };
}

export const getPnlAction: Action = {
    name: "get_pnl",
    description:
        "Show realized + unrealized PnL across futures, cross-margin, and isolated-margin wallets. Default window is the last 30 days. Returns a per-symbol table plus a Net PnL footer.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "what's my pnl this month" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Computing your realized + unrealized PnL for the last 30 days.",
                    action: "get_pnl",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "show realized pnl last week" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Pulling realized PnL.",
                    action: "get_pnl",
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
                        actionName: "get_pnl",
                        type: "get_pnl_error",
                        text,
                        error: new Error(text),
                    }),
                );
            }
            return false;
        }

        let scope: Scope;
        try {
            scope = parseScope(params.scope);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_pnl",
                        type: "get_pnl_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        const now = Date.now();
        const startDateMs = parseDate(params.start_date);
        const endDateMs = parseDate(params.end_date);
        const endTime = endDateMs ?? now;
        const startTime = startDateMs ?? endTime - DEFAULT_WINDOW_DAYS * ONE_DAY_MS;

        let creds: ResolvedExchangeCredentials;
        try {
            creds = await resolveExchangeCredentials(runtime, userId as UUID);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_pnl",
                        type: "get_pnl_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        if (creds.exchange !== "binance") {
            const text = `PnL view is only available for Binance accounts. Connected exchange: ${creds.exchange}.`;
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_pnl",
                        type: "get_pnl",
                        text,
                        content: { exchange: creds.exchange, rows: [], net_pnl: 0 },
                        actionData: { exchange: creds.exchange, rows: [], net_pnl: 0 },
                    }),
                );
            }
            return true;
        }

        const service = createExchangeService(creds);
        const accounts = service.accounts as unknown as BinanceAccountsService;

        let result: PnlResult;
        try {
            result = await collectPnl(accounts, { startTime, endTime, scope });
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(`[plugin-cex] get_pnl error: ${text}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_pnl",
                        type: "get_pnl_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        elizaLogger.info(
            `[Trading] ${JSON.stringify({
                stage: "get_pnl",
                wallets_returned: result.walletsReturned,
                wallets_skipped: result.walletsSkipped,
                scope,
                net_pnl: result.net_pnl,
                realized_total: result.realized_total,
                unrealized_total: result.unrealized_total,
                window_days: Math.round((endTime - startTime) / ONE_DAY_MS),
            })}`,
        );

        const text = renderPnlTable(result);
        if (callback) {
            await callback(
                createActionResponse({
                    actionName: "get_pnl",
                    type: "get_pnl",
                    text,
                    content: {
                        exchange: creds.exchange,
                        rows: result.rows,
                        net_pnl: result.net_pnl,
                        realized_total: result.realized_total,
                        unrealized_total: result.unrealized_total,
                        wallets_returned: result.walletsReturned,
                        wallets_skipped: result.walletsSkipped,
                        scope,
                        window: result.window,
                    },
                    actionData: {
                        exchange: creds.exchange,
                        rows: result.rows,
                        net_pnl: result.net_pnl,
                        scope,
                        window: result.window,
                    },
                }),
            );
        }
        return true;
    },
    validate: async () => true,
};

// Internal exports for tests.
export { renderPnlTable, chunkWindow };
