/**
 * Regression test for the cancel-all expansion at modal-open time.
 *
 * Bug: when the user said "cancel all my orders", the approval modal
 * surfaced an empty `order_ids` field with the `All open` checkbox
 * checked. The user wants to SEE the actual ids in the field so they
 * can edit / deselect specific ones — handing the venue layer a
 * `all_open=true` flag is correct semantically but a poor approval UX.
 *
 * Fix: at modal-open time (inside `requestParameterReview`), if the
 * action is `cancel_order` with `all_open=true` and empty `order_ids`,
 * fall through to `provider.resolveAllOrdersFromContext` (memory-based)
 * and replace `all_open` with the enumerated id list. Memory-only by
 * design — keeps the modal-open path off the venue REST critical path.
 */

import { describe, expect, it, vi } from "vitest";
import {
    expandCancelAllFromMemory,
    expandCancelAllWithFallback,
} from "../src/handlers/cexWorkflowMessageHandler.ts";

const memo = { id: "memo-1", text: "(rendered orders table)", createdAt: 1 };

describe("expandCancelAllFromMemory", () => {
    it("expands all_open=true into the enumerated order_ids from memory", () => {
        const resolver = vi.fn().mockReturnValue({
            orders: [
                { order_id: "62161255434", symbol: "BTC-USDT" },
                { order_id: "46803815", symbol: "BTC-USDT" },
            ],
            sourceMemoryId: "memo-1",
        });

        const result = expandCancelAllFromMemory(
            { all_open: true },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all my orders",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );

        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.params.order_ids).toEqual(["62161255434", "46803815"]);
            expect(result.params.product_id).toBe("BTC-USDT");
            // `all_open` must be dropped so the modal renders the
            // enumerated list, not the "cancel everything" checkbox.
            expect("all_open" in result.params).toBe(false);
            expect(result.sourceMemoryId).toBe("memo-1");
        }
    });

    it("passes ALL ids across multiple symbols and leaves product_id blank (venue does per-id symbol lookup)", () => {
        const resolver = vi.fn().mockReturnValue({
            orders: [
                { order_id: "111", symbol: "BTC-USDT" },
                { order_id: "222", symbol: "ETH-USDT" },
                { order_id: "333", symbol: "BTC-USDT" },
            ],
            sourceMemoryId: "memo-2",
        });

        const result = expandCancelAllFromMemory(
            { all_open: true },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );

        expect(result.expanded).toBe(true);
        if (result.expanded) {
            // Multi-symbol case: every id passes through, no filter.
            expect(result.params.order_ids).toEqual(["111", "222", "333"]);
            // product_id stays undefined so the modal field renders
            // blank — there is no single symbol to surface.
            expect(result.params.product_id).toBeUndefined();
        }
    });

    it("surfaces a product_id hint only when every memory row shares the same symbol", () => {
        const resolver = vi.fn().mockReturnValue({
            orders: [
                { order_id: "111", symbol: "BTC-USDT" },
                { order_id: "333", symbol: "BTC-USDT" },
            ],
            sourceMemoryId: "memo-shared",
        });

        const result = expandCancelAllFromMemory(
            { all_open: true },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );

        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.params.order_ids).toEqual(["111", "333"]);
            expect(result.params.product_id).toBe("BTC-USDT");
        }
    });

    it("returns { expanded: false } when order_ids is already populated (don't clobber)", () => {
        const resolver = vi.fn();
        const result = expandCancelAllFromMemory(
            { all_open: true, order_ids: ["explicit-1"] },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
        expect(resolver).not.toHaveBeenCalled();
    });

    it("returns { expanded: false } when all_open is not set", () => {
        const result = expandCancelAllFromMemory(
            { order_ids: ["123"] },
            {
                resolveAllOrdersFromContext: vi.fn(),
                messageText: "cancel order 123",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });

    it("returns { expanded: false } when memory has no orders (caller keeps all_open=true)", () => {
        const resolver = vi.fn().mockReturnValue(null);
        const result = expandCancelAllFromMemory(
            { all_open: true },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });

    it("returns { expanded: false } when the provider doesn't expose the resolver", () => {
        const result = expandCancelAllFromMemory(
            { all_open: true },
            {
                resolveAllOrdersFromContext: undefined,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });

    it("accepts string 'true' for all_open (decompose template ships JSON-stringified bools sometimes)", () => {
        const resolver = vi.fn().mockReturnValue({
            orders: [{ order_id: "999", symbol: "BTC-USDT" }],
            sourceMemoryId: "memo-3",
        });
        const result = expandCancelAllFromMemory(
            { all_open: "true" as unknown as boolean },
            {
                resolveAllOrdersFromContext: resolver,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.params.order_ids).toEqual(["999"]);
        }
    });
});

describe("expandCancelAllWithFallback (memory → venue tier)", () => {
    const memo = { id: "memo-1", text: "(orders table)", createdAt: 1 };

    it("uses memory result when memory has orders (venue fetch NOT called)", async () => {
        const resolveAllOrdersFromContext = vi.fn().mockReturnValue({
            orders: [
                { order_id: "62161255434", symbol: "BTC-USDT" },
                { order_id: "46803815", symbol: "BTC-USDT" },
            ],
            sourceMemoryId: "memo-1",
        });
        const fetchUserOpenOrders = vi.fn();

        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext,
                fetchUserOpenOrders,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [memo],
                venue: "binance",
            },
        );

        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.source).toBe("memory");
            expect(result.params.order_ids).toEqual(["62161255434", "46803815"]);
        }
        expect(fetchUserOpenOrders).not.toHaveBeenCalled();
    });

    it("falls through to venue fetch when memory is empty", async () => {
        const resolveAllOrdersFromContext = vi.fn().mockReturnValue(null);
        const fetchUserOpenOrders = vi.fn().mockResolvedValue([
            { order_id: "62174095098", symbol: "BTC-USDT" },
            { order_id: "62174095099", symbol: "BTC-USDT" },
            { order_id: "62174095100", symbol: "BTC-USDT" },
        ]);

        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext,
                fetchUserOpenOrders,
                messageText: "cancel all my orders",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );

        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.source).toBe("venue");
            expect(result.params.order_ids).toEqual([
                "62174095098",
                "62174095099",
                "62174095100",
            ]);
            expect(result.params.product_id).toBe("BTC-USDT");
            expect("all_open" in result.params).toBe(false);
        }
        expect(fetchUserOpenOrders).toHaveBeenCalledOnce();
    });

    it("passes ALL venue ids across multiple symbols (no single-symbol filter)", async () => {
        const fetchUserOpenOrders = vi.fn().mockResolvedValue([
            { order_id: "111", symbol: "BTC-USDT" },
            { order_id: "222", symbol: "ETH-USDT" },
            { order_id: "333", symbol: "BTC-USDT" },
        ]);
        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(true);
        if (result.expanded) {
            // All three ids land in the modal. The venue cancel layer
            // looks up symbol per id at execute time, so multi-symbol
            // fan-out works without a `product_id` hint.
            expect(result.params.order_ids).toEqual(["111", "222", "333"]);
            expect(result.params.product_id).toBeUndefined();
            expect(result.sourceDetail).toBe("3 open order(s) across 2 symbol(s)");
        }
    });

    it("surfaces a product_id only when every venue row shares the same symbol", async () => {
        const fetchUserOpenOrders = vi.fn().mockResolvedValue([
            { order_id: "AAA", symbol: "SOL-USDT" },
            { order_id: "BBB", symbol: "SOL-USDT" },
        ]);
        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(true);
        if (result.expanded) {
            expect(result.params.order_ids).toEqual(["AAA", "BBB"]);
            expect(result.params.product_id).toBe("SOL-USDT");
        }
    });

    it("returns { expanded: false } when memory misses AND venue returns no orders", async () => {
        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders: vi.fn().mockResolvedValue([]),
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });

    it("returns { expanded: false } when venue fetch fails (null) — caller keeps all_open=true", async () => {
        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders: vi.fn().mockResolvedValue(null),
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });

    it("does NOT call venue fetch when all_open is absent (memory result was the only valid path)", async () => {
        const fetchUserOpenOrders = vi.fn();
        const result = await expandCancelAllWithFallback(
            { order_ids: ["explicit-1"] },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders,
                messageText: "cancel order explicit-1",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
        expect(fetchUserOpenOrders).not.toHaveBeenCalled();
    });

    it("works when fetchUserOpenOrders is undefined (older plugin-cex build)", async () => {
        const result = await expandCancelAllWithFallback(
            { all_open: true },
            {
                resolveAllOrdersFromContext: vi.fn().mockReturnValue(null),
                fetchUserOpenOrders: undefined,
                messageText: "cancel all",
                locale: "en",
                recentAssistantMemories: [],
                venue: "binance",
            },
        );
        expect(result.expanded).toBe(false);
    });
});
