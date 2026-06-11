/**
 * §6.0.3 — UNKNOWN-state ledger handling and dedup refusal.
 *
 * Asserts:
 *  - A post-send venue 5xx promotes the row to `unknown` via emitUnknownState
 *    (the workflow handler is responsible for the actual writeUnknown call;
 *    this test verifies the trading event is emitted with `cause` set).
 *  - The pre-submit dedup gate refuses retries while the row is in `unknown`.
 *  - The risk engine refuses NEW writes on the same (venue, symbol) while
 *    `unknown_state_orders_on_pair > 0`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate } from "../../src/risk/riskEngine";
import { buildCanonicalIntent } from "../../src/intent/intentBuilder";
import { DEFAULT_USER_TRADING_PREFERENCES } from "../../src/risk/types";
import { checkExistingOrder } from "../../src/idempotency/preSubmitDedup";
import type { LedgerOperations, PendingOrderLedgerRow } from "../../src/reconciliation/types";
import { callVenueWithRetry } from "../../src/exchanges/services/retry";
import { onTradingEvent } from "../../src/observability/tradingEvents";

function makePreferences() {
    return {
        userId: "user-1",
        ...DEFAULT_USER_TRADING_PREFERENCES,
        updatedAt: new Date().toISOString(),
    } as never;
}

function makeUnknownRow(): PendingOrderLedgerRow {
    return {
        request_id: "req-unknown",
        intent_hash: "h-u",
        client_order_id: "binance-unknown-1",
        venue: "binance",
        symbol: "BTC-USDT",
        userId: "user-1",
        state: "unknown",
        submittedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        latest_payload: null,
        locale: "en",
    };
}

describe("§6.0.3 UNKNOWN-state safety", () => {
    let events: Array<Record<string, unknown>>;
    let unsub: () => void;

    beforeEach(() => {
        events = [];
        unsub = onTradingEvent((e) => events.push(e));
    });

    afterEach(() => {
        unsub();
        vi.useRealTimers();
    });

    it("pre-submit dedup classifies UNKNOWN-state ledger rows as unknown_state", async () => {
        const row = makeUnknownRow();
        const ledger: Pick<LedgerOperations, "getPendingOrderByClientOrderId"> = {
            async getPendingOrderByClientOrderId(client_order_id) {
                return client_order_id === row.client_order_id ? row : null;
            },
        };
        const out = await checkExistingOrder(ledger, row.client_order_id);
        expect(out.kind).toBe("unknown_state");
    });

    it("risk engine blocks new writes when unknown_state_orders_on_pair > 0", () => {
        const intent = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-1",
            locale: "en",
            mode: "live",
            params: {
                userId: "user-1" as never,
                product_id: "BTC-USDT",
                symbol: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "0.01" },
                },
            },
        });
        const decision = evaluate(intent, {
            preferences: makePreferences(),
            unknown_state_orders_on_pair: 1,
        });
        expect(decision.verdict).toBe("block");
        expect(decision.rules_fired).toContain("unknownStateBlocker");
    });

    it("post-send 5xx on a write emits emitUnknownState with cause=venue_5xx", async () => {
        const error = {
            response: { status: 503, headers: {}, data: { msg: "service unavailable" } },
        };
        await expect(
            callVenueWithRetry({
                venue: "binance",
                endpoint: "/api/v3/order",
                method: "POST",
                is_write: true,
                client_order_id: "binance-unknown-2",
                symbol: "BTC-USDT",
                userId: "user-1",
                request_id: "req-unknown-2",
                intent_hash: "h-2",
                request_body: { symbol: "BTC-USDT", side: "BUY", quantity: "0.001" },
                invoke: async () => {
                    throw error;
                },
            }),
        ).rejects.toBeDefined();

        const unknownState = events.find((e) => e.stage === "unknown_state");
        expect(unknownState).toBeDefined();
        expect(unknownState?.cause).toBe("venue_5xx");
        expect(unknownState?.client_order_id).toBe("binance-unknown-2");
    });

    it("post-send timeout on a write emits emitUnknownState with cause=venue_timeout", async () => {
        const error = { code: "ETIMEDOUT" };
        await expect(
            callVenueWithRetry({
                venue: "coinbase",
                endpoint: "/api/v3/brokerage/orders",
                method: "POST",
                is_write: true,
                client_order_id: "cb-unknown-3",
                userId: "user-1",
                request_body: {},
                invoke: async () => {
                    throw error;
                },
            }),
        ).rejects.toBeDefined();

        const unknownState = events.find((e) => e.stage === "unknown_state");
        expect(unknownState).toBeDefined();
        expect(unknownState?.cause).toBe("venue_timeout");
    });

    it("pre-flight network errors do NOT promote to UNKNOWN (request never sent)", async () => {
        // ENOTFOUND is retryable preflight; eventually exhausts attempts. Use ENOTFOUND.
        const error = { code: "ENOTFOUND" };
        try {
            await callVenueWithRetry({
                venue: "binance",
                endpoint: "/api/v3/order",
                method: "POST",
                is_write: true,
                client_order_id: "binance-preflight-1",
                userId: "user-1",
                request_body: {},
                invoke: async () => {
                    throw error;
                },
            });
        } catch {
            /* expected */
        }
        const unknownState = events.find((e) => e.stage === "unknown_state");
        expect(unknownState).toBeUndefined();
    }, 30_000);

    it("callVenueWithRetry invokes the factory FRESH on each retry (no memoized rejection)", async () => {
        // Regression for the unwrapRestData bug: previously callers passed an
        // already-in-flight Promise; the retry helper just `await`-ed the same
        // cached rejection 4 times. The factory contract requires a NEW request
        // per attempt.
        let invocations = 0;
        const error = { code: "ENOTFOUND" }; // retryable preflight
        try {
            await callVenueWithRetry({
                venue: "binance",
                endpoint: "/api/v3/order",
                method: "POST",
                is_write: false,
                userId: "user-1",
                request_body: {},
                invoke: async () => {
                    invocations += 1;
                    throw error;
                },
            });
        } catch {
            /* expected */
        }
        // Capped at 4 attempts in retry.ts; each attempt MUST re-invoke the factory.
        expect(invocations).toBe(4);
    }, 30_000);

    it("HTTP 200 + Binance error payload shape does NOT promote to UNKNOWN", async () => {
        // Real-world failure mode: Binance returns 200 OK with `{code:-1013, msg:...}`
        // for insufficient balance / lot-size / minNotional rejections. The retry
        // helper must classify this as venue_4xx (known-rejected) — NOT
        // venue_network_error — so the order is not stuck in UNKNOWN state.
        const rejection = Object.assign(
            new Error("Binance API error -1013: Filter failure: MIN_NOTIONAL"),
            {
                response: { status: 400, data: { code: -1013, msg: "MIN_NOTIONAL" } },
                binance_rejected: true,
                binance_code: -1013,
            },
        );
        await expect(
            callVenueWithRetry({
                venue: "binance",
                endpoint: "/api/v3/order",
                method: "POST",
                is_write: true,
                client_order_id: "binance-rejection-1",
                symbol: "BTC-USDT",
                userId: "user-1",
                request_body: {},
                invoke: async () => {
                    throw rejection;
                },
            }),
        ).rejects.toBeDefined();

        const unknownState = events.find((e) => e.stage === "unknown_state");
        expect(unknownState).toBeUndefined();
    });
});
