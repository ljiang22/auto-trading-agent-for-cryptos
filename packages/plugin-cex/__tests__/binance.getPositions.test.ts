import { describe, expect, it, vi } from "vitest";

import {
    collectPositions,
    mapFuturesPositionRow,
    mapCrossMarginPositions,
    mapIsolatedMarginPositions,
    renderPositionsTable,
} from "../src/actions/getPositions";

/**
 * Fix 13 — `get_positions` action.
 *
 * Mocks `BinanceAccountsService.getPositionRisk` + `getMarginAccount`
 * + `getIsolatedMarginAccounts` and asserts:
 *   - Side derivation (sign of `positionAmt` for futures, sign of
 *     `baseAsset.netAsset` for isolated, sign of `netAsset` for cross).
 *   - `|size| < 1e-9` filter skips closed positions.
 *   - Permission-denied wallets are skipped silently — the other
 *     wallets' rows still surface + the venue is added to the
 *     `walletsSkipped` list.
 *   - Liquidation price is populated where the venue exposes it
 *     (futures + isolated) and null otherwise (cross).
 */

function fixturePositionRiskTwoOpen() {
    return [
        // Open SHORT — matches the user's Positions(2) screenshot.
        {
            symbol: "BTCUSDT",
            positionAmt: "-0.00025057",
            entryPrice: "77234.40",
            markPrice: "77234.30",
            unRealizedProfit: "0.10026475",
            liquidationPrice: "230411.56",
            leverage: "10",
            marginType: "cross",
        },
        // Open LONG.
        {
            symbol: "ETHUSDT",
            positionAmt: "0.5",
            entryPrice: "3500",
            markPrice: "3520",
            unRealizedProfit: "10",
            liquidationPrice: "3000",
            leverage: "5",
            marginType: "isolated",
        },
        // Closed position — should be filtered out.
        {
            symbol: "SOLUSDT",
            positionAmt: "0",
            entryPrice: "0",
            markPrice: "150",
            unRealizedProfit: "0",
            liquidationPrice: "0",
            leverage: "10",
            marginType: "cross",
        },
        // Below-epsilon position — should also be filtered.
        {
            symbol: "ADAUSDT",
            positionAmt: "0.0000000001",
            entryPrice: "0.5",
            markPrice: "0.5",
            unRealizedProfit: "0",
            liquidationPrice: "0",
            leverage: "10",
            marginType: "cross",
        },
    ];
}

function fixtureIsolatedMarginOnePair() {
    return {
        assets: [
            {
                symbol: "BTCUSDT",
                marginRatio: "12.34",
                marginLevel: "5.0",
                liquidatePrice: "230000.00",
                baseAsset: {
                    asset: "BTC",
                    free: "0",
                    locked: "0",
                    borrowed: "0.00050057",
                    interest: "0",
                    // SHORT: user has borrowed BTC (negative net)
                    netAsset: "-0.00050057",
                },
                quoteAsset: {
                    asset: "USDT",
                    free: "44.41",
                    locked: "24.85",
                    borrowed: "0",
                    interest: "0",
                    netAsset: "69.26",
                },
            },
        ],
    };
}

function fixtureCrossMarginOneAsset() {
    return {
        marginLevel: "999",
        marginRatio: "8.5",
        totalAssetOfBtc: "0.001",
        totalLiabilityOfBtc: "0.0005",
        userAssets: [
            {
                asset: "BTC",
                free: "0",
                locked: "0",
                borrowed: "0.0005",
                interest: "0",
                netAsset: "-0.0005",
            },
            // Dust row — below epsilon, should be skipped.
            {
                asset: "ETH",
                free: "0",
                locked: "0",
                borrowed: "0",
                interest: "0",
                netAsset: "0",
            },
        ],
    };
}

describe("Fix 13 — mapFuturesPositionRow", () => {
    it("derives SHORT from negative positionAmt", () => {
        const row = mapFuturesPositionRow({
            symbol: "BTCUSDT",
            positionAmt: "-0.00025057",
            entryPrice: "77234.40",
            markPrice: "77234.30",
            unRealizedProfit: "0.10026475",
            liquidationPrice: "230411.56",
            leverage: "10",
            marginType: "cross",
        });
        expect(row).not.toBeNull();
        expect(row?.side).toBe("SHORT");
        expect(row?.liquidation_price).toBe(230411.56);
        expect(row?.unrealized_pnl).toBe(0.10026475);
        expect(row?.entry_price).toBe(77234.40);
        expect(row?.leverage).toBe(10);
        expect(row?.margin_type).toBe("cross");
    });

    it("derives LONG from positive positionAmt", () => {
        const row = mapFuturesPositionRow({
            symbol: "ETHUSDT",
            positionAmt: "0.5",
            entryPrice: "3500",
            markPrice: "3520",
            unRealizedProfit: "10",
            liquidationPrice: "3000",
            leverage: "5",
            marginType: "isolated",
        });
        expect(row?.side).toBe("LONG");
        expect(row?.margin_type).toBe("isolated");
    });

    it("filters out positions with |size| < 1e-9", () => {
        expect(mapFuturesPositionRow({ symbol: "BTCUSDT", positionAmt: "0" })).toBeNull();
        expect(
            mapFuturesPositionRow({ symbol: "BTCUSDT", positionAmt: "0.0000000001" }),
        ).toBeNull();
        expect(
            mapFuturesPositionRow({ symbol: "BTCUSDT", positionAmt: "-0.0000000001" }),
        ).toBeNull();
    });
});

describe("Fix 13 — mapIsolatedMarginPositions", () => {
    it("derives SHORT from negative baseAsset.netAsset and uses per-pair liquidatePrice", () => {
        const rows = mapIsolatedMarginPositions(fixtureIsolatedMarginOnePair());
        expect(rows).toHaveLength(1);
        expect(rows[0].symbol).toBe("BTCUSDT");
        expect(rows[0].side).toBe("SHORT");
        expect(rows[0].liquidation_price).toBe(230000);
        expect(rows[0].margin_ratio).toBe(12.34);
        expect(rows[0].margin_type).toBe("isolated");
        expect(rows[0].wallet_type).toBe("margin_isolated");
    });

    it("skips pairs with |baseAsset.netAsset| < 1e-9", () => {
        const rows = mapIsolatedMarginPositions({
            assets: [
                {
                    symbol: "BTCUSDT",
                    baseAsset: { netAsset: "0" },
                    liquidatePrice: "100000",
                },
            ],
        });
        expect(rows).toHaveLength(0);
    });
});

describe("Fix 13 — mapCrossMarginPositions", () => {
    it("emits one row per non-zero netAsset with account-level marginRatio", () => {
        const rows = mapCrossMarginPositions(fixtureCrossMarginOneAsset());
        expect(rows).toHaveLength(1);
        expect(rows[0].symbol).toBe("BTC");
        expect(rows[0].side).toBe("SHORT");
        expect(rows[0].margin_ratio).toBe(8.5);
        expect(rows[0].liquidation_price).toBeNull();
        expect(rows[0].margin_type).toBe("cross");
    });
});

describe("Fix 13 — collectPositions", () => {
    function buildAccounts(opts: {
        positionRisk?: () => Promise<unknown>;
        marginAccount?: () => Promise<unknown>;
        isolatedAccount?: () => Promise<unknown>;
    }) {
        return {
            getPositionRisk: vi.fn(
                opts.positionRisk ?? (async () => fixturePositionRiskTwoOpen()),
            ),
            getMarginAccount: vi.fn(
                opts.marginAccount ?? (async () => fixtureCrossMarginOneAsset()),
            ),
            getIsolatedMarginAccounts: vi.fn(
                opts.isolatedAccount ?? (async () => fixtureIsolatedMarginOnePair()),
            ),
        };
    }

    it("returns 3 rows for futures (2 open) + isolated (1 pair) + cross (1 asset)", async () => {
        const accounts = buildAccounts({});
        const result = await collectPositions(accounts, "all");
        // futures: BTCUSDT short + ETHUSDT long (SOL closed, ADA below eps filtered)
        // isolated: BTCUSDT short
        // cross: BTC short
        expect(result.rows).toHaveLength(4);
        expect(result.walletsReturned).toEqual([
            "futures",
            "margin_cross",
            "margin_isolated",
        ]);
        expect(result.walletsSkipped).toEqual([]);
    });

    it("verification scenario: futures BTC short (-0.00025057), futures ETH long, isolated BTC short — three rows with correct liq prices", async () => {
        const accounts = buildAccounts({
            // Skip cross to mimic a user without cross-margin holdings.
            marginAccount: async () => ({ userAssets: [] }),
        });
        const result = await collectPositions(accounts, "all");
        const futuresBtc = result.rows.find(
            (r) => r.wallet_type === "futures" && r.symbol === "BTCUSDT",
        );
        const futuresEth = result.rows.find(
            (r) => r.wallet_type === "futures" && r.symbol === "ETHUSDT",
        );
        const isolatedBtc = result.rows.find(
            (r) => r.wallet_type === "margin_isolated" && r.symbol === "BTCUSDT",
        );

        expect(futuresBtc).toBeDefined();
        expect(futuresBtc?.side).toBe("SHORT");
        expect(futuresBtc?.entry_price).toBe(77234.40);
        expect(futuresBtc?.liquidation_price).toBe(230411.56);
        expect(futuresBtc?.unrealized_pnl).toBe(0.10026475);

        expect(futuresEth).toBeDefined();
        expect(futuresEth?.side).toBe("LONG");

        expect(isolatedBtc).toBeDefined();
        expect(isolatedBtc?.side).toBe("SHORT");
        expect(isolatedBtc?.liquidation_price).toBe(230000);

        // All three rows have a non-null liq price for the
        // venues that surface it (futures + isolated).
        expect(futuresBtc?.liquidation_price).not.toBeNull();
        expect(futuresEth?.liquidation_price).not.toBeNull();
        expect(isolatedBtc?.liquidation_price).not.toBeNull();
    });

    it("permission-denied futures wallet → other wallets' rows still returned + skip recorded", async () => {
        const accounts = buildAccounts({
            positionRisk: async () => {
                throw new Error("[binance-futures] 403 Forbidden api=\"futures not enabled\"");
            },
        });
        const result = await collectPositions(accounts, "all");
        expect(result.walletsSkipped).toContain("futures");
        expect(result.walletsReturned).toContain("margin_cross");
        expect(result.walletsReturned).toContain("margin_isolated");
        // We should still have the 2 margin rows (1 cross + 1 isolated).
        expect(result.rows.length).toBeGreaterThanOrEqual(2);
        // No futures rows since the call failed.
        expect(result.rows.filter((r) => r.wallet_type === "futures")).toHaveLength(0);
    });

    it("wallet_type=futures only fetches positionRisk", async () => {
        const accounts = buildAccounts({});
        const result = await collectPositions(accounts, "futures");
        // Only futures rows.
        expect(result.rows.every((r) => r.wallet_type === "futures")).toBe(true);
        // The other two methods should not have been called.
        expect(accounts.getMarginAccount).not.toHaveBeenCalled();
        expect(accounts.getIsolatedMarginAccounts).not.toHaveBeenCalled();
    });
});

describe("Fix 13 — renderPositionsTable", () => {
    it("renders an empty-state line when there are no rows", () => {
        const txt = renderPositionsTable([]);
        expect(txt.toLowerCase()).toContain("no open positions");
    });

    it("renders a per-wallet section with the 9-column body table", () => {
        // Fix-T11 (post-PR238 UI iter): renderer now emits one section
        // per wallet_type (### Futures / Cross Margin / Isolated Margin)
        // instead of a single Wallet-column table. The Wallet column is
        // dropped because the section header carries that information.
        const txt = renderPositionsTable([
            {
                wallet_type: "futures",
                symbol: "BTCUSDT",
                side: "SHORT",
                size: -0.00025057,
                entry_price: 77234.4,
                mark_price: 77234.3,
                unrealized_pnl: 0.10026475,
                liquidation_price: 230411.56,
                leverage: 10,
                margin_ratio: null,
                margin_type: "cross",
            },
        ]);
        expect(txt).toContain("### Futures");
        expect(txt).toContain("| Symbol | Side | Size | Entry | Mark | Unrealized PnL | Liq Price | Leverage | Margin Ratio |");
        expect(txt).toContain("BTCUSDT");
        expect(txt).toContain("SHORT");
    });

    // Commit 9 — position transparency. The renderer should disclose
    // which wallets were checked and which were skipped, so a user
    // can distinguish "futures disabled" from "futures enabled but
    // flat".
    it("appends a 'Wallets checked / skipped' footer when scope is provided", () => {
        const txt = renderPositionsTable(
            [],
            ["futures", "margin_cross"],
            ["margin_isolated"],
        );
        expect(txt).toContain("Wallets checked: futures, margin_cross");
        expect(txt).toContain("Wallets skipped");
        expect(txt).toContain("margin_isolated");
    });

    it("renders a scoped empty-state line when checked wallets exist but rows are empty", () => {
        const txt = renderPositionsTable([], ["futures"], []);
        expect(txt).toContain("No open positions in checked wallets (futures)");
    });

    it("renders the legacy global empty line when no scope is provided", () => {
        const txt = renderPositionsTable([]);
        expect(txt).toContain("No open positions across futures");
    });

    it("appends the footer beneath populated tables too", () => {
        const txt = renderPositionsTable(
            [
                {
                    wallet_type: "futures",
                    symbol: "ETHUSDT",
                    side: "LONG",
                    size: 1,
                    entry_price: 3000,
                    mark_price: 3050,
                    unrealized_pnl: 50,
                    liquidation_price: null,
                    leverage: 5,
                    margin_ratio: null,
                    margin_type: null,
                },
            ],
            ["futures"],
            ["margin_cross"],
        );
        expect(txt).toContain("ETHUSDT");
        expect(txt).toContain("Wallets checked: futures");
        expect(txt).toContain("Wallets skipped");
    });
});
