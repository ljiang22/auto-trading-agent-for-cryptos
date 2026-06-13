/**
 * Fix 13 — `get_positions` action.
 *
 * Surfaces the Binance "Positions" tab data on demand:
 *   - Futures positions (`/fapi/v2/positionRisk`): entry_price,
 *     mark_price, unrealized_pnl, liquidation_price, leverage,
 *     marginType.
 *   - Cross-margin per-asset borrowed positions (`/sapi/v1/margin/account`):
 *     when a user has borrowed but not yet repaid, the borrowed amount
 *     surfaces as a SHORT-equivalent position with the account-level
 *     `marginRatio`. Liquidation price is account-level, not per-asset,
 *     so we leave the per-row `liquidation_price` null.
 *   - Isolated-margin per-pair positions (`/sapi/v1/margin/isolated/account`):
 *     per-pair `liquidatePrice` + `marginRatio` + signed netAsset across
 *     base+quote. Side derived from sign of base.netAsset (positive =
 *     LONG, negative = SHORT).
 *
 * Param shape:
 *   { userId: UUID, wallet_type?: "margin_cross" | "margin_isolated" | "futures" | "all" }
 *
 * Default `wallet_type` is `"all"` — fans out the three sources via
 * `Promise.allSettled` so a permission-denied venue (e.g. futures not
 * enabled on the API key) is skipped silently. The aggregated row set
 * is returned along with the list of wallet types that resolved.
 *
 * Coinbase is OUT OF SCOPE for Fix 13 — Coinbase Advanced Trade
 * doesn't expose a per-position margin/futures view through the
 * trading API in the same shape, and the user-facing requirement
 * (mirror the Binance Positions(2) tab) is Binance-specific.
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

type WalletType = "margin_cross" | "margin_isolated" | "futures" | "all";

const VALID_WALLET_TYPES: ReadonlySet<WalletType> = new Set([
    "margin_cross",
    "margin_isolated",
    "futures",
    "all",
]);

const SIZE_EPSILON = 1e-9;

/**
 * One canonical position row. Field shape mirrors the columns of the
 * Binance Positions tab. Numeric fields are kept as `number | null`
 * (null when the venue doesn't surface them — e.g. cross-margin
 * doesn't expose per-asset liquidation price).
 */
export interface PositionRow {
    wallet_type: "futures" | "margin_cross" | "margin_isolated";
    symbol: string;
    side: "LONG" | "SHORT";
    size: number;
    entry_price: number | null;
    mark_price: number | null;
    unrealized_pnl: number | null;
    liquidation_price: number | null;
    leverage: number | null;
    margin_ratio: number | null;
    margin_type: "cross" | "isolated" | null;
}

function safeNumber(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const trimmed = v.trim();
        if (!trimmed) return null;
        const n = Number.parseFloat(trimmed);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Map a raw `/fapi/v2/positionRisk` row to a normalized `PositionRow`.
 * Returns `null` for closed positions (`|positionAmt| < 1e-9`) so the
 * caller can `.filter(Boolean)` cleanly.
 */
function mapFuturesPositionRow(raw: unknown): PositionRow | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const sizeRaw = safeNumber(r.positionAmt);
    if (sizeRaw === null) return null;
    if (Math.abs(sizeRaw) < SIZE_EPSILON) return null;
    const symbol = typeof r.symbol === "string" ? r.symbol : "";
    if (!symbol) return null;
    const marginTypeRaw = typeof r.marginType === "string" ? r.marginType.toLowerCase() : null;
    return {
        wallet_type: "futures",
        symbol,
        side: sizeRaw > 0 ? "LONG" : "SHORT",
        size: sizeRaw,
        entry_price: safeNumber(r.entryPrice),
        mark_price: safeNumber(r.markPrice),
        unrealized_pnl: safeNumber(r.unRealizedProfit),
        liquidation_price: safeNumber(r.liquidationPrice),
        leverage: safeNumber(r.leverage),
        margin_ratio: null, // futures `positionRisk` doesn't include per-position margin ratio
        margin_type:
            marginTypeRaw === "isolated"
                ? "isolated"
                : marginTypeRaw === "cross"
                  ? "cross"
                  : null,
    };
}

/**
 * Map cross-margin per-asset entries to a position row. Binance's
 * cross-margin account doesn't surface a per-asset liquidation price
 * (that's account-level via `marginRatio`); we leave liq_price null
 * and stamp the account-level margin ratio on each row instead.
 *
 * "Position" here = the asset has a non-zero `netAsset` (free+locked
 * minus borrowed minus interest). LONG netAsset > 0 means the user
 * holds the asset; SHORT means they've borrowed it.
 */
function mapCrossMarginPositions(raw: unknown): PositionRow[] {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const accountMarginRatio = safeNumber(r.marginRatio);
    const userAssets = Array.isArray(r.userAssets) ? r.userAssets : [];
    const rows: PositionRow[] = [];
    for (const asset of userAssets) {
        if (!asset || typeof asset !== "object") continue;
        const a = asset as Record<string, unknown>;
        const netAsset = safeNumber(a.netAsset);
        if (netAsset === null) continue;
        if (Math.abs(netAsset) < SIZE_EPSILON) continue;
        const symbol = typeof a.asset === "string" ? a.asset : "";
        if (!symbol) continue;
        rows.push({
            wallet_type: "margin_cross",
            symbol,
            side: netAsset > 0 ? "LONG" : "SHORT",
            size: netAsset,
            entry_price: null, // cross-margin spot doesn't track avg entry per asset
            mark_price: null,
            unrealized_pnl: null,
            liquidation_price: null, // account-level only
            leverage: null,
            margin_ratio: accountMarginRatio,
            margin_type: "cross",
        });
    }
    return rows;
}

/**
 * Map isolated-margin per-pair entries to position rows. One row per
 * opened pair where the SIGNED base netAsset is non-zero.
 *
 * Liquidation price is per-pair (`liquidatePrice`), margin ratio is
 * per-pair (`marginRatio`). Side derived from the SIGN of
 * `baseAsset.netAsset`.
 */
function mapIsolatedMarginPositions(raw: unknown): PositionRow[] {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const rows: PositionRow[] = [];
    for (const pair of assets) {
        if (!pair || typeof pair !== "object") continue;
        const p = pair as Record<string, unknown>;
        const symbol = typeof p.symbol === "string" ? p.symbol : "";
        if (!symbol) continue;
        const base = p.baseAsset as Record<string, unknown> | undefined;
        if (!base || typeof base !== "object") continue;
        const baseNet = safeNumber(base.netAsset);
        if (baseNet === null) continue;
        if (Math.abs(baseNet) < SIZE_EPSILON) continue;
        rows.push({
            wallet_type: "margin_isolated",
            symbol,
            side: baseNet > 0 ? "LONG" : "SHORT",
            size: baseNet,
            entry_price: null,
            mark_price: null,
            unrealized_pnl: null, // requires (mark - entry) * size; entry not surfaced by margin API
            liquidation_price: safeNumber(p.liquidatePrice),
            leverage: null,
            margin_ratio: safeNumber(p.marginRatio),
            margin_type: "isolated",
        });
    }
    return rows;
}

/**
 * Render the position rows as a markdown table for chat display.
 * The Fix 3 plan-executor inlines this inside a `<details>` block.
 *
 * CEX post-PR237 Commit 9 (Issue 13) — Position transparency. The
 * empty-state branch previously read "No open positions across
 * futures, cross-margin, or isolated-margin wallets." with no
 * indication of WHICH wallets the venue actually answered for and
 * WHICH it skipped. A futures-disabled API key looked identical
 * to a futures-enabled-but-flat account, leaving the user unsure
 * whether the agent had actually checked. The renderer now
 * surfaces `wallets_returned` / `wallets_skipped` in both the
 * empty and populated branches so the user can see the scope.
 */
function renderPositionsTable(
    rows: PositionRow[],
    walletsReturned: string[] = [],
    walletsSkipped: string[] = [],
): string {
    const footer = renderScopeFooter(walletsReturned, walletsSkipped);
    if (rows.length === 0) {
        const emptyMain =
            walletsReturned.length > 0
                ? `_No open positions in checked wallets (${walletsReturned.join(", ")})._`
                : "_No open positions across futures, cross-margin, or isolated-margin wallets._";
        return footer ? `${emptyMain}\n\n${footer}` : emptyMain;
    }
    // Fix-T11 (post-PR238 UI iter) — per-wallet sections. The previous
    // single-table layout (one row per asset with a Wallet column)
    // visually conflated Futures / Cross-margin / Isolated-margin even
    // though their column semantics differ (cross has only account-level
    // margin ratio; isolated has per-pair liquidation; futures has both
    // entry/mark/unrealized). Group rows by wallet_type and emit one
    // section per group with a sub-header so the user can tell at a
    // glance which scope returned what.
    const fmt = (n: number | null, digits = 4): string =>
        n === null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: digits });
    const SECTION_ORDER: ReadonlyArray<{ key: PositionRow["wallet_type"]; label: string }> = [
        { key: "futures", label: "### Futures" },
        { key: "margin_cross", label: "### Cross Margin" },
        { key: "margin_isolated", label: "### Isolated Margin" },
    ];
    const header =
        "| Symbol | Side | Size | Entry | Mark | Unrealized PnL | Liq Price | Leverage | Margin Ratio |";
    const sep =
        "|--------|------|------|-------|------|----------------|-----------|----------|--------------|";
    const sections: string[] = [];
    for (const { key, label } of SECTION_ORDER) {
        const sectionRows = rows.filter((r) => r.wallet_type === key);
        if (sectionRows.length === 0) continue;
        const body = sectionRows.map(
            (r) =>
                `| ${r.symbol} | ${r.side} | ${fmt(r.size, 8)} | ${fmt(r.entry_price)} | ${fmt(r.mark_price)} | ${fmt(r.unrealized_pnl)} | ${fmt(r.liquidation_price)} | ${fmt(r.leverage, 2)} | ${fmt(r.margin_ratio, 4)} |`,
        );
        sections.push([label, "", header, sep, ...body].join("\n"));
    }
    const tables = sections.join("\n\n");
    return footer ? `${tables}\n\n${footer}` : tables;
}

/**
 * CEX post-PR237 Commit 9 (Issue 13) — Build the
 * "Wallets checked / skipped" footer line shown beneath the
 * positions table (or instead of it, when empty). Returns empty
 * string when there's nothing to report.
 */
function renderScopeFooter(
    walletsReturned: string[],
    walletsSkipped: string[],
): string {
    const lines: string[] = [];
    if (walletsReturned.length > 0) {
        lines.push(`_Wallets checked: ${walletsReturned.join(", ")}._`);
    }
    if (walletsSkipped.length > 0) {
        lines.push(
            `_Wallets skipped (permission or unavailable): ${walletsSkipped.join(", ")}._`,
        );
    }
    return lines.join("\n");
}

/**
 * Pure helper: dispatch the three wallet fetches in parallel and
 * return the aggregated row set + the list of wallet types that
 * resolved. Exported for unit tests so the test can pass a fake
 * `BinanceAccountsService`-shaped object without booting the full
 * exchange registry.
 */
export async function collectPositions(
    accounts: Pick<
        BinanceAccountsService,
        "getPositionRisk" | "getMarginAccount" | "getIsolatedMarginAccounts"
    >,
    wallet_type: WalletType,
): Promise<{ rows: PositionRow[]; walletsReturned: string[]; walletsSkipped: string[] }> {
    const wantFutures = wallet_type === "all" || wallet_type === "futures";
    const wantCross = wallet_type === "all" || wallet_type === "margin_cross";
    const wantIsolated = wallet_type === "all" || wallet_type === "margin_isolated";

    const [futuresRes, crossRes, isolatedRes] = await Promise.allSettled([
        wantFutures ? accounts.getPositionRisk() : Promise.resolve(null),
        wantCross ? accounts.getMarginAccount() : Promise.resolve(null),
        wantIsolated ? accounts.getIsolatedMarginAccounts() : Promise.resolve(null),
    ]);

    const rows: PositionRow[] = [];
    const walletsReturned: string[] = [];
    const walletsSkipped: string[] = [];

    if (wantFutures) {
        if (futuresRes.status === "fulfilled" && futuresRes.value !== null) {
            const raw = futuresRes.value;
            const list = Array.isArray(raw) ? raw : [];
            for (const r of list) {
                const row = mapFuturesPositionRow(r);
                if (row) rows.push(row);
            }
            walletsReturned.push("futures");
        } else if (futuresRes.status === "rejected") {
            walletsSkipped.push("futures");
            elizaLogger.debug(
                `[plugin-cex] get_positions futures skipped: ${futuresRes.reason instanceof Error ? futuresRes.reason.message : String(futuresRes.reason)}`,
            );
        }
    }

    if (wantCross) {
        if (crossRes.status === "fulfilled" && crossRes.value !== null) {
            const mapped = mapCrossMarginPositions(crossRes.value);
            rows.push(...mapped);
            walletsReturned.push("margin_cross");
        } else if (crossRes.status === "rejected") {
            walletsSkipped.push("margin_cross");
            elizaLogger.debug(
                `[plugin-cex] get_positions margin_cross skipped: ${crossRes.reason instanceof Error ? crossRes.reason.message : String(crossRes.reason)}`,
            );
        }
    }

    if (wantIsolated) {
        if (isolatedRes.status === "fulfilled" && isolatedRes.value !== null) {
            const mapped = mapIsolatedMarginPositions(isolatedRes.value);
            rows.push(...mapped);
            walletsReturned.push("margin_isolated");
        } else if (isolatedRes.status === "rejected") {
            walletsSkipped.push("margin_isolated");
            elizaLogger.debug(
                `[plugin-cex] get_positions margin_isolated skipped: ${isolatedRes.reason instanceof Error ? isolatedRes.reason.message : String(isolatedRes.reason)}`,
            );
        }
    }

    return { rows, walletsReturned, walletsSkipped };
}

function parseWalletType(value: unknown): WalletType {
    if (typeof value !== "string") return "all";
    const lower = value.trim().toLowerCase();
    if (!lower) return "all";
    if (VALID_WALLET_TYPES.has(lower as WalletType)) return lower as WalletType;
    throw new Error(
        `"wallet_type" must be one of: margin_cross, margin_isolated, futures, all (got "${value}")`,
    );
}

export const getPositionsAction: Action = {
    name: "get_positions",
    description:
        "Show open positions across futures, cross-margin, and isolated-margin wallets. Returns one row per non-zero position with entry price, mark price, unrealized PnL, liquidation price, leverage, and margin ratio — the same data as the Binance Positions tab.",
    examples: [
        [
            { user: "{{user1}}", content: { text: "show my positions" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Fetching your open positions across futures and margin.",
                    action: "get_positions",
                },
            },
        ],
        [
            { user: "{{user1}}", content: { text: "what are my open futures positions" } },
            {
                user: "{{user2}}",
                content: {
                    text: "Pulling futures positions.",
                    action: "get_positions",
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
                        actionName: "get_positions",
                        type: "get_positions_error",
                        text,
                        error: new Error(text),
                    }),
                );
            }
            return false;
        }

        let wallet_type: WalletType;
        try {
            wallet_type = parseWalletType(params.wallet_type);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_positions",
                        type: "get_positions_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        let creds: ResolvedExchangeCredentials;
        try {
            creds = await resolveExchangeCredentials(runtime, userId as UUID);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_positions",
                        type: "get_positions_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        if (creds.exchange !== "binance") {
            // Coinbase support is out of scope for Fix 13.
            const text = `Position view is only available for Binance accounts. Connected exchange: ${creds.exchange}.`;
            if (callback) {
                await callback(
                    createActionResponse({
                        actionName: "get_positions",
                        type: "get_positions",
                        text,
                        content: { exchange: creds.exchange, rows: [], wallets_returned: [] },
                        actionData: { exchange: creds.exchange, rows: [], wallets_returned: [] },
                    }),
                );
            }
            return true;
        }

        const service = createExchangeService(creds);
        // We've gated on `creds.exchange === "binance"` above so the
        // narrowing here is safe; the cast lets us reach the futures /
        // margin accessors that `ExchangeAccountsService` doesn't
        // declare (they're Binance-only additions in Fix 13).
        const accounts = service.accounts as unknown as BinanceAccountsService;

        let result: Awaited<ReturnType<typeof collectPositions>>;
        try {
            result = await collectPositions(accounts, wallet_type);
        } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            elizaLogger.warn(`[plugin-cex] get_positions error: ${text}`);
            if (callback) {
                await callback(
                    createActionErrorResponse({
                        actionName: "get_positions",
                        type: "get_positions_error",
                        text,
                        error: err instanceof Error ? err : new Error(text),
                    }),
                );
            }
            return false;
        }

        // Single grep-friendly summary log line. Mirrors the
        // `wallets_skipped=<scope>:<REASON>` style used by getBalance.
        elizaLogger.info(
            `[Trading] ${JSON.stringify({
                stage: "get_positions",
                wallets_returned: result.walletsReturned,
                wallets_skipped: result.walletsSkipped,
                rows: result.rows.length,
                wallet_type,
            })}`,
        );

        const text = renderPositionsTable(
            result.rows,
            result.walletsReturned,
            result.walletsSkipped,
        );
        if (callback) {
            await callback(
                createActionResponse({
                    actionName: "get_positions",
                    type: "get_positions",
                    text,
                    content: {
                        exchange: creds.exchange,
                        rows: result.rows,
                        wallets_returned: result.walletsReturned,
                        wallets_skipped: result.walletsSkipped,
                        wallet_type,
                    },
                    actionData: {
                        exchange: creds.exchange,
                        rows: result.rows,
                        wallets_returned: result.walletsReturned,
                        wallets_skipped: result.walletsSkipped,
                        wallet_type,
                    },
                }),
            );
        }
        return true;
    },
    validate: async () => true,
};

// Internal exports for tests.
export {
    mapFuturesPositionRow,
    mapCrossMarginPositions,
    mapIsolatedMarginPositions,
    renderPositionsTable,
};
