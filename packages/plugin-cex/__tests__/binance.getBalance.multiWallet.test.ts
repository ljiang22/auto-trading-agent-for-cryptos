import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elizaLogger } from "@elizaos/core";
import { BinanceAccountsService } from "../src/exchanges/services/binance";
import {
    signedMarginGet,
    signedIsolatedMarginGet,
} from "../src/exchanges/services/binanceMargin";

/**
 * Fix 1 — multi-wallet getBalance regression.
 *
 * Fixture mirrors the verification block in the task description:
 *   - Spot BTC:     free=0.001,    locked=0.0005
 *   - Funding USDT: free=100,      locked=0
 *   - Cross-margin BTC: free=0,    locked=0,    borrowed=0.0005, interest=0
 *   - Isolated BTCUSDT:
 *       base BTC:  free=0.00025,   locked=0,    borrowed=0.00050057, interest=0
 *       quote USDT: free=44.41,    locked=24.85
 */

const realFetch = globalThis.fetch;

function dataResponse<T>(value: T) {
    return Promise.resolve({
        data: async () => value,
    });
}

function spotAccountFixture() {
    return {
        balances: [{ asset: "BTC", free: "0.001", locked: "0.0005" }],
    };
}

function fundingWalletFixture() {
    return [{ asset: "USDT", free: "100", locked: "0" }];
}

function crossMarginFixture() {
    return {
        marginLevel: "999",
        totalAssetOfBtc: "0.00025",
        totalLiabilityOfBtc: "0.0005",
        totalNetAssetOfBtc: "-0.00025",
        userAssets: [
            {
                asset: "BTC",
                free: "0",
                locked: "0",
                borrowed: "0.0005",
                interest: "0",
                netAsset: "-0.0005",
            },
        ],
    };
}

function isolatedMarginFixture() {
    return {
        assets: [
            {
                symbol: "BTCUSDT",
                marginRatio: "12.34",
                baseAsset: {
                    asset: "BTC",
                    free: "0.00025",
                    locked: "0",
                    borrowed: "0.00050057",
                    interest: "0",
                    netAsset: "-0.00025057",
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
        totalAssetOfBtc: "0.001",
        totalLiabilityOfBtc: "0.0005",
        totalNetAssetOfBtc: "0.0005",
    };
}

function mockOk(body: unknown) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

function mockStatus(status: number, statusText: string, body: unknown) {
    return {
        ok: false,
        status,
        statusText,
        text: async () => JSON.stringify(body),
        json: async () => body,
    };
}

function createCtx(
    overrides: {
        getAccount?: () => Promise<unknown>;
        fundingWallet?: () => Promise<unknown>;
    } = {},
) {
    const spot = {
        restAPI: {
            getAccount:
                overrides.getAccount ??
                vi.fn(() => dataResponse(spotAccountFixture())),
            exchangeInfo: vi.fn(),
            getOpenOrders: vi.fn(),
            getOrder: vi.fn(),
            newOrder: vi.fn(),
            deleteOrder: vi.fn(),
        },
    };
    const wallet = {
        restAPI: {
            fundingWallet:
                overrides.fundingWallet ??
                vi.fn(() => dataResponse(fundingWalletFixture())),
        },
    };
    return {
        spot,
        wallet,
        apiKey: "k",
        apiSecret: "s",
    };
}

/**
 * Build a fetch spy that routes by URL. The two margin endpoints don't
 * go through the SDK; they hit raw fetch via `signedMarginGet` and
 * `signedIsolatedMarginGet`.
 */
function buildFetchRouter(routes: {
    cross?: () => Promise<unknown>;
    isolated?: () => Promise<unknown>;
}) {
    return vi.fn().mockImplementation(async (url: string | URL) => {
        const s = String(url);
        if (s.includes("/sapi/v1/margin/isolated/account")) {
            if (routes.isolated) return routes.isolated();
            return mockOk(isolatedMarginFixture());
        }
        if (s.includes("/sapi/v1/margin/account")) {
            if (routes.cross) return routes.cross();
            return mockOk(crossMarginFixture());
        }
        // Default: 404 so we notice any unexpected call.
        return mockStatus(404, "Not Found", { code: -1, msg: "unexpected url" });
    });
}

describe("BinanceAccountsService.getBalance — multi-wallet (Fix 1)", () => {
    beforeEach(() => {
        // Default: all four wallets succeed.
        globalThis.fetch = buildFetchRouter({}) as unknown as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("returns rows for all four wallet types when every scope succeeds", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
        };

        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("spot")).toBe(true);
        expect(types.has("funding")).toBe(true);
        expect(types.has("margin_cross")).toBe(true);
        expect(types.has("margin_isolated")).toBe(true);
    });

    it("preserves backward-compat legacy fields (currency, available_balance.value, wallet_type)", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
        };

        const spot = result.accounts.find((a) => a.wallet_type === "spot");
        expect(spot).toBeDefined();
        expect(spot?.currency).toBe("BTC");
        expect((spot?.available_balance as { value: string })?.value).toBe("0.001");
        expect((spot?.hold as { value: string })?.value).toBe("0.0005");
        // New uniform shape:
        expect(spot?.asset).toBe("BTC");
        expect(spot?.free).toBe("0.001");
        expect(spot?.locked).toBe("0.0005");
        expect(spot?.total).toBe("0.0015");
    });

    it("cross-margin BTC row carries borrowed=0.0005 and a computed net", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary: { cross: Record<string, string> };
        };

        const cross = result.accounts.find(
            (a) => a.wallet_type === "margin_cross" && a.asset === "BTC",
        );
        expect(cross).toBeDefined();
        expect(cross?.borrowed).toBe("0.0005");
        // net = 0 + 0 - 0.0005 - 0 = -0.0005
        expect(cross?.net).toBe("-0.0005");
        expect(result.margin_summary.cross.marginRatio).toBe("999");
        expect(result.margin_summary.cross.totalNetAssetOfBtc).toBe("-0.00025");
    });

    it("isolated-margin USDT row carries symbol_pair=BTCUSDT and locked=24.85", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary: { isolated: Array<Record<string, unknown>> };
        };

        const isoUsdt = result.accounts.find(
            (a) =>
                a.wallet_type === "margin_isolated" &&
                a.asset === "USDT" &&
                a.symbol_pair === "BTCUSDT",
        );
        expect(isoUsdt).toBeDefined();
        expect(isoUsdt?.locked).toBe("24.85");
        expect(isoUsdt?.free).toBe("44.41");
        // total = 44.41 + 24.85 = 69.26
        expect(isoUsdt?.total).toBe("69.26");
        expect(result.margin_summary.isolated[0].symbol).toBe("BTCUSDT");
    });

    it("isolated-margin BTC row carries borrowed=0.00050057", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
        };

        const isoBtc = result.accounts.find(
            (a) =>
                a.wallet_type === "margin_isolated" &&
                a.asset === "BTC" &&
                a.symbol_pair === "BTCUSDT",
        );
        expect(isoBtc).toBeDefined();
        expect(isoBtc?.borrowed).toBe("0.00050057");
        expect(isoBtc?.free).toBe("0.00025");
    });

    it("tolerates cross-margin 401 — spot+funding+isolated still return", async () => {
        const logSpy = vi.fn();
        globalThis.fetch = buildFetchRouter({
            cross: async () =>
                mockStatus(401, "Unauthorized", { code: -2015, msg: "Invalid API-key" }),
        }) as unknown as typeof fetch;

        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
        };

        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("spot")).toBe(true);
        expect(types.has("funding")).toBe(true);
        expect(types.has("margin_isolated")).toBe(true);
        // Cross missing — but the call returned cleanly.
        expect(types.has("margin_cross")).toBe(false);
        // margin_summary.cross omitted; isolated present.
        expect(result.margin_summary?.cross).toBeUndefined();
        expect(result.margin_summary?.isolated).toBeDefined();
        void logSpy;
    });

    it("partial failure log line emits wallets_skipped=<scope>:<REASON> per skipped wallet", async () => {
        // Both margin scopes fail with permission-denied — log line
        // should carry `margin_cross:PERMISSION_DENIED,margin_isolated:PERMISSION_DENIED`
        // (per-scope reason classification, not a single shared reason).
        globalThis.fetch = buildFetchRouter({
            cross: async () =>
                mockStatus(403, "Forbidden", { code: -2015, msg: "permission denied" }),
            isolated: async () =>
                mockStatus(403, "Forbidden", { code: -2015, msg: "permission denied" }),
        }) as unknown as typeof fetch;

        const infoSpy = vi.spyOn(elizaLogger, "info").mockImplementation(() => {});

        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
        };

        // Spot + funding still surfaced.
        expect(result.accounts.length).toBeGreaterThan(0);
        expect(result.margin_summary).toBeUndefined();

        // The summary log line is the one emitted by getBalance itself,
        // identifiable by its prefix. Other info calls may run during
        // construction; match by prefix.
        const summaryLine = infoSpy.mock.calls
            .map((c) => String(c[0]))
            .find((s) => s.startsWith("[plugin-cex Binance] getBalance scope="));
        expect(summaryLine).toBeDefined();
        expect(summaryLine).toContain(
            "wallets_skipped=margin_cross:PERMISSION_DENIED,margin_isolated:PERMISSION_DENIED",
        );
        // Should NOT contain the legacy hardcoded trailing `reason=` token.
        expect(summaryLine).not.toMatch(/\breason=PERMISSION_DENIED\b/);
    });

    // Issue 4 — wallet_type scope filter. Sub-suite below.

    it("wallet_type=spot returns ONLY spot rows; does not call margin endpoints", async () => {
        const fetchRouter = buildFetchRouter({});
        globalThis.fetch = fetchRouter as unknown as typeof fetch;

        const fundingSpy = vi.fn(() => dataResponse(fundingWalletFixture()));
        const accountSpy = vi.fn(() => dataResponse(spotAccountFixture()));
        const svc = new BinanceAccountsService(
            createCtx({ getAccount: accountSpy, fundingWallet: fundingSpy }) as never,
        );

        const result = (await svc.getBalance({
            userId: "u" as never,
            wallet_type: "spot",
        })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
            wallet_type_filter?: string;
        };

        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("spot")).toBe(true);
        expect(types.has("funding")).toBe(false);
        expect(types.has("margin_cross")).toBe(false);
        expect(types.has("margin_isolated")).toBe(false);
        expect(result.margin_summary).toBeUndefined();
        expect(result.wallet_type_filter).toBe("spot");

        // Spot endpoint hit once; funding never hit; neither margin
        // endpoint hit (the fetch router 404s on unknown URLs).
        expect(accountSpy).toHaveBeenCalledTimes(1);
        expect(fundingSpy).not.toHaveBeenCalled();
        const urls = fetchRouter.mock.calls.map((c) => String(c[0]));
        expect(urls.some((u) => u.includes("/sapi/v1/margin/account"))).toBe(false);
        expect(urls.some((u) => u.includes("/sapi/v1/margin/isolated/account"))).toBe(false);
    });

    it("wallet_type=margin_cross returns ONLY cross-margin rows + cross summary", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({
            userId: "u" as never,
            wallet_type: "margin_cross",
        })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: { cross?: unknown; isolated?: unknown };
            wallet_type_filter?: string;
        };

        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("margin_cross")).toBe(true);
        expect(types.has("spot")).toBe(false);
        expect(types.has("funding")).toBe(false);
        expect(types.has("margin_isolated")).toBe(false);
        expect(result.margin_summary?.cross).toBeDefined();
        expect(result.margin_summary?.isolated).toBeUndefined();
        expect(result.wallet_type_filter).toBe("margin_cross");
    });

    it("wallet_type='all' (or omitted) preserves the historical four-wallet fan-out", async () => {
        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({
            userId: "u" as never,
            wallet_type: "all",
        })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
            wallet_type_filter?: string;
        };

        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("spot")).toBe(true);
        expect(types.has("funding")).toBe(true);
        expect(types.has("margin_cross")).toBe(true);
        expect(types.has("margin_isolated")).toBe(true);
        // wallet_type_filter only surfaces when scoped to a single wallet;
        // "all" must NOT leak the field so existing consumers stay happy.
        expect(result.wallet_type_filter).toBeUndefined();
    });

    it("wallet_type=spot — summary log line contains wallet_type=spot tag", async () => {
        const infoSpy = vi.spyOn(elizaLogger, "info").mockImplementation(() => {});
        const svc = new BinanceAccountsService(createCtx() as never);
        await svc.getBalance({ userId: "u" as never, wallet_type: "spot" });

        const summaryLine = infoSpy.mock.calls
            .map((c) => String(c[0]))
            .find((s) => s.startsWith("[plugin-cex Binance] getBalance"));
        expect(summaryLine).toBeDefined();
        expect(summaryLine).toContain("wallet_type=spot");
        expect(summaryLine).toContain("scope=spot");
        // Filter-excluded scopes must NOT show up in wallets_skipped.
        expect(summaryLine).not.toContain("wallets_skipped");
    });

    it("cross-margin 502 produces wallets_skipped=margin_cross:SERVER_ERROR (NOT PERMISSION_DENIED)", async () => {
        // Bad Gateway is the canonical "not permission denied" failure —
        // ensures the reason classifier picks SERVER_ERROR not PERMISSION_DENIED.
        globalThis.fetch = buildFetchRouter({
            cross: async () =>
                mockStatus(502, "Bad Gateway", { code: -1, msg: "upstream timeout" }),
        }) as unknown as typeof fetch;

        const infoSpy = vi.spyOn(elizaLogger, "info").mockImplementation(() => {});

        const svc = new BinanceAccountsService(createCtx() as never);
        const result = (await svc.getBalance({ userId: "u" as never })) as {
            accounts: Array<Record<string, unknown>>;
            margin_summary?: Record<string, unknown>;
        };

        // Cross skipped, others present.
        const types = new Set(result.accounts.map((r) => r.wallet_type));
        expect(types.has("spot")).toBe(true);
        expect(types.has("funding")).toBe(true);
        expect(types.has("margin_isolated")).toBe(true);
        expect(types.has("margin_cross")).toBe(false);

        const summaryLine = infoSpy.mock.calls
            .map((c) => String(c[0]))
            .find((s) => s.startsWith("[plugin-cex Binance] getBalance scope="));
        expect(summaryLine).toBeDefined();
        // The reason MUST NOT be PERMISSION_DENIED.
        expect(summaryLine).not.toContain("margin_cross:PERMISSION_DENIED");
        // 502 → SERVER_ERROR per the classifier schema.
        expect(summaryLine).toContain("margin_cross:SERVER_ERROR");
    });
});

describe("signedSapiGet (via signedMarginGet) — error sanitization (Fix 1 f/u)", () => {
    afterEach(() => {
        globalThis.fetch = realFetch;
        vi.restoreAllMocks();
    });

    it("401 with JSON body { code:-2015, msg:'Invalid API-key' } throws a bounded sanitized message", async () => {
        // Build a Binance-shaped error response and verify:
        //   - the thrown message includes "Invalid API-key"
        //   - the thrown message includes status=401
        //   - the thrown message is short (no unbounded body slice)
        //   - the thrown message does NOT include `signature=` even if
        //     the upstream body echoed it.
        const errBody = {
            code: -2015,
            msg: "Invalid API-key, IP, or permissions for action.",
            // Sneaky: pretend Binance echoed the signature back. Our
            // sanitizer must drop this — only {code,msg} are projected.
            signature: "deadbeefcafebabe1234567890abcdef".repeat(8),
        };
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () => JSON.stringify(errBody),
        }) as unknown as typeof fetch;

        let caught: Error | undefined;
        try {
            await signedMarginGet("APIKEY", "APISECRET");
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeDefined();
        const msg = String(caught?.message ?? "");
        expect(msg).toContain("Invalid API-key");
        expect(msg).toContain("status=401");
        // No request signature must leak even if the upstream echoes it.
        expect(msg).not.toContain("signature=");
        expect(msg).not.toContain("deadbeefcafebabe");
        // Bounded — the message must be reasonably short. Cap is 200
        // chars on the msg slice + ~150 chars of envelope text.
        expect(msg.length).toBeLessThan(600);
    });

    it("non-JSON error body is sliced to 200 chars (not 400)", async () => {
        const huge = "Z".repeat(800);
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            text: async () => huge,
        }) as unknown as typeof fetch;

        let caught: Error | undefined;
        try {
            await signedIsolatedMarginGet("APIKEY", "APISECRET");
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).toBeDefined();
        const msg = String(caught?.message ?? "");
        // Body must NOT contain a 400-char or longer run of Z.
        expect(msg).not.toMatch(/Z{300}/);
        // It MAY contain up to a 200-char run (apiMessage cap).
        expect(msg).toMatch(/Z{50,200}/);
        expect(msg).toContain("status=503");
    });
});
