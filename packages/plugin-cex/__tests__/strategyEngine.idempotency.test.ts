import { describe, it, expect } from "vitest";
import { deriveTrancheClientOrderId } from "../src/strategy/engine/idempotency";

const intent = {
  intent_version: 1, request_id: "r", user_id: "u1", action: "create_order",
  mode: "paper", venue: "paper", symbol: "BTCUSDT", side: "BUY",
  order_type: "market", size: { base_size: "0.001" },
  price_params: {}, execution_constraints: {}, margin_context: {},
  idempotency: { client_order_id: "px-x", intent_hash: "h" },
  policy_context: {}, locale: "en",
} as any;

describe("deriveTrancheClientOrderId", () => {
  it("is deterministic for the same intent + salt (retry-safe)", () => {
    expect(deriveTrancheClientOrderId(intent, "i1:3")).toBe(deriveTrancheClientOrderId(intent, "i1:3"));
  });
  it("differs across tick_count (distinct tranches do not collide)", () => {
    expect(deriveTrancheClientOrderId(intent, "i1:3")).not.toBe(deriveTrancheClientOrderId(intent, "i1:4"));
  });
  it("produces a paper-prefixed id within venue length limits", () => {
    const id = deriveTrancheClientOrderId(intent, "i1:0");
    expect(id.startsWith("px-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(36);
  });
});
