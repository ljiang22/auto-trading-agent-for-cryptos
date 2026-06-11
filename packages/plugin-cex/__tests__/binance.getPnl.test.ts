import { describe, expect, it, vi } from "vitest";

import {
    chunkWindow,
    collectPnl,
    extractFuturesUnrealizedPnl,
    renderPnlTable,
    sumFuturesRealizedPnl,
} from "../src/actions/getPnl";

const ONE_DAY = 24 * 60 * 60 * 1000;

describe("Fix 13 — chunkWindow", () => {
    it("splits a 30-day window into ≤6-day chunks", () => {
        const start = 0;
        const end = 30 * ONE_DAY;
        const chunks = chunkWindow(start, end);
        expect(chunks.length).toBe(5);
        for (const c of chunks) {
            expect(c.end - c.start).toBeLessThanOrEqual(6 * ONE_DAY);
        }
        expect(chunks[0].start).toBe(start);
        expect(chunks[chunks.length - 1].end).toBe(end);
    });

    it("emits a single chunk when the window is < 6 days", () => {
        const start = 0;
        const end = 2 * ONE_DAY;
        const chunks = chunkWindow(start, end);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toEqual({ start, end });
    });

    it("returns an empty array when end <= start", () => {
        expect(chunkWindow(0, 0)).toEqual([]);
        expect(chunkWindow(100, 50)).toEqual([]);
    });
});

describe("Fix 13 — sumFuturesRealizedPnl", () => {
    it("sums per-symbol REALIZED_PNL across chunks", async () => {
        const accounts = {
            getIncomeHistory: vi
                .fn()
                // 30 days / 6 = 5 chunks; we hand back 10 USDT per chunk
                // split across BTCUSDT (+30) and ETHUSDT (+20). Net = 50.
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "6", incomeType: "REALIZED_PNL" },
                    { symbol: "ETHUSDT", income: "4", incomeType: "REALIZED_PNL" },
                ])
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "6", incomeType: "REALIZED_PNL" },
                    { symbol: "ETHUSDT", income: "4", incomeType: "REALIZED_PNL" },
                ])
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "6", incomeType: "REALIZED_PNL" },
                    { symbol: "ETHUSDT", income: "4", incomeType: "REALIZED_PNL" },
                ])
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "6", incomeType: "REALIZED_PNL" },
                    { symbol: "ETHUSDT", income: "4", incomeType: "REALIZED_PNL" },
                ])
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "6", incomeType: "REALIZED_PNL" },
                    { symbol: "ETHUSDT", income: "4", incomeType: "REALIZED_PNL" },
                ]),
        };
        const start = 0;
        const end = 30 * ONE_DAY;
        const result = await sumFuturesRealizedPnl(accounts as never, start, end);
        expect(result.total).toBeCloseTo(50, 5);
        expect(result.perSymbol.get("BTCUSDT")).toBeCloseTo(30, 5);
        expect(result.perSymbol.get("ETHUSDT")).toBeCloseTo(20, 5);
        expect(result.chunksOk).toBe(5);
        expect(result.chunksFailed).toBe(0);
    });

    it("settles silently on per-chunk failure and returns partial sum", async () => {
        const accounts = {
            getIncomeHistory: vi
                .fn()
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "10", incomeType: "REALIZED_PNL" },
                ])
                .mockRejectedValueOnce(new Error("boom"))
                .mockResolvedValueOnce([
                    { symbol: "BTCUSDT", income: "5", incomeType: "REALIZED_PNL" },
                ]),
        };
        // 3 chunks → 18 days
        const result = await sumFuturesRealizedPnl(accounts as never, 0, 18 * ONE_DAY);
        expect(result.chunksOk).toBe(2);
        expect(result.chunksFailed).toBe(1);
        expect(result.total).toBeCloseTo(15, 5);
    });
});

describe("Fix 13 — extractFuturesUnrealizedPnl", () => {
    it("returns one entry per non-zero positionAmt", () => {
        const m = extractFuturesUnrealizedPnl([
            { symbol: "BTCUSDT", positionAmt: "-0.001", unRealizedProfit: "20" },
            { symbol: "ETHUSDT", positionAmt: "0", unRealizedProfit: "5" }, // skipped
            { symbol: "SOLUSDT", positionAmt: "1", unRealizedProfit: "-3" },
        ]);
        expect(m.get("BTCUSDT")).toBe(20);
        expect(m.get("SOLUSDT")).toBe(-3);
        expect(m.has("ETHUSDT")).toBe(false);
    });
});

describe("Fix 13 — collectPnl realized + unrealized", () => {
    it("combines futures realized ($50) + unrealized ($20) → net = $70", async () => {
        const accounts = {
            // Realized chunks: one chunk for a tight 2-day window, $50 total on BTCUSDT.
            getIncomeHistory: vi.fn(async () => [
                { symbol: "BTCUSDT", income: "50", incomeType: "REALIZED_PNL" },
            ]),
            // Unrealized: $20 on BTCUSDT.
            getPositionRisk: vi.fn(async () => [
                {
                    symbol: "BTCUSDT",
                    positionAmt: "0.01",
                    unRealizedProfit: "20",
                    entryPrice: "60000",
                    markPrice: "62000",
                    liquidationPrice: "30000",
                    leverage: "5",
                    marginType: "cross",
                },
            ]),
        };
        const result = await collectPnl(accounts as never, {
            startTime: 0,
            endTime: 2 * ONE_DAY,
            scope: "all",
        });
        expect(result.realized_total).toBe(50);
        expect(result.unrealized_total).toBe(20);
        expect(result.net_pnl).toBe(70);
        // One coalesced row for BTCUSDT.
        const btc = result.rows.find((r) => r.symbol === "BTCUSDT");
        expect(btc).toBeDefined();
        expect(btc?.realized_pnl).toBe(50);
        expect(btc?.unrealized_pnl).toBe(20);
        expect(result.walletsReturned).toContain("futures_realized");
        expect(result.walletsReturned).toContain("futures_unrealized");
    });

    it("scope=realized skips positionRisk", async () => {
        const accounts = {
            getIncomeHistory: vi.fn(async () => [
                { symbol: "BTCUSDT", income: "50", incomeType: "REALIZED_PNL" },
            ]),
            getPositionRisk: vi.fn(),
        };
        const result = await collectPnl(accounts as never, {
            startTime: 0,
            endTime: 2 * ONE_DAY,
            scope: "realized",
        });
        expect(accounts.getPositionRisk).not.toHaveBeenCalled();
        expect(result.unrealized_total).toBe(0);
        expect(result.realized_total).toBe(50);
    });

    it("scope=unrealized skips income history", async () => {
        const accounts = {
            getIncomeHistory: vi.fn(),
            getPositionRisk: vi.fn(async () => [
                {
                    symbol: "BTCUSDT",
                    positionAmt: "0.01",
                    unRealizedProfit: "20",
                },
            ]),
        };
        const result = await collectPnl(accounts as never, {
            startTime: 0,
            endTime: 2 * ONE_DAY,
            scope: "unrealized",
        });
        expect(accounts.getIncomeHistory).not.toHaveBeenCalled();
        expect(result.realized_total).toBe(0);
        expect(result.unrealized_total).toBe(20);
    });
});

describe("Fix 13 — renderPnlTable", () => {
    it("renders a Net PnL footer with the right total + sign", () => {
        const txt = renderPnlTable({
            rows: [
                {
                    symbol: "BTCUSDT",
                    side: null,
                    realized_pnl: 50,
                    unrealized_pnl: 20,
                    notes: "",
                },
            ],
            net_pnl: 70,
            realized_total: 50,
            unrealized_total: 20,
            walletsReturned: [],
            walletsSkipped: [],
            window: { start: 0, end: 1 },
        });
        expect(txt).toContain("| Symbol | Side | Realized PnL | Unrealized PnL | Total PnL | Notes |");
        expect(txt).toContain("BTCUSDT");
        expect(txt).toContain("**Net PnL: +70 USDT**");
    });

    it("renders empty-state when there are no rows", () => {
        const txt = renderPnlTable({
            rows: [],
            net_pnl: 0,
            realized_total: 0,
            unrealized_total: 0,
            walletsReturned: [],
            walletsSkipped: [],
            window: { start: 0, end: 1 },
        });
        expect(txt.toLowerCase()).toContain("no pnl activity");
        expect(txt).toContain("**Net PnL: ");
    });
});
