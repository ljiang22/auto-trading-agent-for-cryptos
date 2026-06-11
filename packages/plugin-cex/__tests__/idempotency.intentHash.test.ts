import { describe, expect, it } from "vitest";

import {
    canonicalJSON,
    computeIntentHash,
    deriveClientOrderId,
} from "../src/idempotency/intentHash";
import { buildCanonicalIntent } from "../src/intent/intentBuilder";

describe("canonicalJSON", () => {
    it("sorts keys recursively", () => {
        const out = canonicalJSON({ b: 1, a: 2, nested: { z: 1, a: 2 } });
        expect(out).toBe('{"a":2,"b":1,"nested":{"a":2,"z":1}}');
    });

    it("drops undefined values", () => {
        const out = canonicalJSON({ a: 1, b: undefined, c: 2 });
        expect(out).toBe('{"a":1,"c":2}');
    });

    it("preserves array order", () => {
        const out = canonicalJSON({ items: [3, 1, 2] });
        expect(out).toBe('{"items":[3,1,2]}');
    });
});

describe("deriveClientOrderId", () => {
    it("returns a binance-safe string ≤ 36 chars (alphanumeric + ._-)", () => {
        const hash = "a".repeat(64);
        const id = deriveClientOrderId(hash, "binance");
        expect(id.length).toBeLessThanOrEqual(36);
        expect(id).toMatch(/^[a-zA-Z0-9._-]+$/u);
        expect(id.startsWith("bn-")).toBe(true);
    });

    it("returns a coinbase-safe string ≤ 36 chars", () => {
        const hash = "f".repeat(64);
        const id = deriveClientOrderId(hash, "coinbase");
        expect(id.length).toBeLessThanOrEqual(36);
        expect(id).toMatch(/^[a-zA-Z0-9._-]+$/u);
        expect(id.startsWith("cb-")).toBe(true);
    });

    it("produces stable ids for the same hash + venue", () => {
        const hash = "0123456789abcdef".repeat(4);
        expect(deriveClientOrderId(hash, "binance")).toBe(
            deriveClientOrderId(hash, "binance"),
        );
    });

    it("produces different ids for different hashes", () => {
        const a = deriveClientOrderId("a".repeat(64), "binance");
        const b = deriveClientOrderId("b".repeat(64), "binance");
        expect(a).not.toBe(b);
    });
});

describe("computeIntentHash", () => {
    function baseIntent(opts: { locale?: "en" | "zh-CN"; requestId?: string } = {}) {
        return buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-1",
            locale: opts.locale ?? "en",
            requestId: opts.requestId,
            params: {
                userId: "user-1",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "0.001" },
                },
            },
        });
    }

    it("is stable across EN and zh-CN locales for the same canonical intent", () => {
        const en = baseIntent({ locale: "en", requestId: "r-en" });
        const zh = baseIntent({ locale: "zh-CN", requestId: "r-zh" });
        expect(en.idempotency.intent_hash).toBe(zh.idempotency.intent_hash);
        expect(en.idempotency.client_order_id).toBe(zh.idempotency.client_order_id);
    });

    it("does NOT collide across two distinct intents", () => {
        const a = baseIntent();
        const b = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-1",
            locale: "en",
            params: {
                userId: "user-1",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "0.002" }, // different size
                },
            },
        });
        expect(a.idempotency.intent_hash).not.toBe(b.idempotency.intent_hash);
        expect(a.idempotency.client_order_id).not.toBe(b.idempotency.client_order_id);
    });

    it("excludes request_id from the hash (different request_id, same hash)", () => {
        const a = baseIntent({ requestId: "r-1" });
        const b = baseIntent({ requestId: "r-2" });
        expect(a.idempotency.intent_hash).toBe(b.idempotency.intent_hash);
    });

    it("changes when resubmit_nonce is set (dedup override path)", () => {
        const base = baseIntent();
        const override = buildCanonicalIntent({
            action: "create_order",
            venue: "binance",
            userId: "user-1",
            locale: "en",
            resubmitNonce: "nonce-override-1",
            params: {
                userId: "user-1",
                product_id: "BTC-USDT",
                side: "BUY",
                order_configuration: {
                    market_market_ioc: { base_size: "0.001" },
                },
            },
        });
        expect(base.idempotency.intent_hash).not.toBe(override.idempotency.intent_hash);
        expect(base.idempotency.client_order_id).not.toBe(override.idempotency.client_order_id);
    });

    it("changes when venue changes", () => {
        const binance = baseIntent();
        const coinbase = buildCanonicalIntent({
            action: "create_order",
            venue: "coinbase",
            userId: "user-1",
            locale: "en",
            params: binance.raw_order_configuration
                ? {
                      userId: "user-1",
                      product_id: "BTC-USDT",
                      side: "BUY",
                      order_configuration: binance.raw_order_configuration,
                  }
                : {
                      userId: "user-1",
                  },
        });
        expect(binance.idempotency.intent_hash).not.toBe(coinbase.idempotency.intent_hash);
    });
});
