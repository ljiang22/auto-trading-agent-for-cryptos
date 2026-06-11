import { describe, expect, it } from "vitest";
import { formatCEXActionForLLM, getCEXCanonicalSpec } from "../src/spec/canonical";

/**
 * After PR #234 added `margin_type` to the get_orders schema, the LLM
 * was still hitting the spot endpoint for "what margin orders do I
 * have" prompts. CloudWatch showed the formatted schema fed to the LLM
 * was a flat key/type/enum listing with no descriptions — so the
 * model had no semantic hint that `margin_type` should fire for
 * "margin orders" in prose. This test pins the new contract: the
 * formatter MUST include `description` text when present.
 */

describe("get_balance schema declares wallet_type (post-PR239 schema fix)", () => {
    // Issue 4 post-mortem regression: PR #239 added wallet_type
    // extraction + projection but the workflow handler's
    // `sanitizeCEXParamsBySchema` strips any field not declared in the
    // action schema. Without this entry, single-action
    // "show my spot balance" prompts always fanned out across every
    // wallet. This test locks in the schema entry.
    const spec = getCEXCanonicalSpec();

    it("get_balance schema includes wallet_type as an optional enum", () => {
        const schema = spec.schemas.get_balance;
        expect(schema).toBeDefined();
        const walletType = schema?.parameters.wallet_type;
        expect(walletType).toBeDefined();
        expect(walletType?.type).toBe("enum");
        expect(walletType?.required).toBe(false);
        expect(walletType?.enum).toEqual([
            "spot",
            "funding",
            "margin_cross",
            "margin_isolated",
            "all",
        ]);
    });

    it("formatted LLM schema surfaces wallet_type with its description", () => {
        const out = formatCEXActionForLLM("get_balance", spec.schemas);
        expect(out).toContain("wallet_type");
        expect(out).toMatch(/spot/);
        expect(out).toMatch(/margin_cross/);
        expect(out).toMatch(/margin_isolated/);
    });

    it("get_orders schema includes history as an optional boolean", () => {
        const schema = spec.schemas.get_orders;
        const history = schema?.parameters.history;
        expect(history).toBeDefined();
        expect(history?.type).toBe("boolean");
        expect(history?.required).toBe(false);
    });

    // Schemas for the remaining read-only actions were previously
    // omitted, which made `sanitizeCEXParamsBySchema` return `{}`
    // (the documented behavior for an undefined schema). That
    // silently stripped user params, causing prompts like
    // "order book for ETH" to drop into the "product_id is required"
    // error path even though the LLM had extracted it. Each entry
    // below pins the schema so the sanitizer keeps the field.
    it("get_orderbook schema declares product_id (required) and depth (optional)", () => {
        const schema = spec.schemas.get_orderbook;
        expect(schema).toBeDefined();
        expect(schema?.parameters.product_id?.required).toBe(true);
        expect(schema?.parameters.depth?.required).toBe(false);
    });

    it("get_ticker schema declares product_ids (optional array)", () => {
        const schema = spec.schemas.get_ticker;
        expect(schema).toBeDefined();
        expect(schema?.parameters.product_ids?.type).toBe("array");
        expect(schema?.parameters.product_ids?.required).toBe(false);
    });

    it("get_positions schema declares wallet_type enum", () => {
        const schema = spec.schemas.get_positions;
        expect(schema).toBeDefined();
        expect(schema?.parameters.wallet_type?.enum).toEqual([
            "margin_cross",
            "margin_isolated",
            "futures",
            "all",
        ]);
    });

    it("get_pnl schema declares scope + start_date + end_date", () => {
        const schema = spec.schemas.get_pnl;
        expect(schema).toBeDefined();
        expect(schema?.parameters.scope?.enum).toEqual([
            "realized",
            "unrealized",
            "all",
        ]);
        expect(schema?.parameters.start_date).toBeDefined();
        expect(schema?.parameters.end_date).toBeDefined();
    });

    it("get_trading_mode schema declares the injected userId + exchange", () => {
        const schema = spec.schemas.get_trading_mode;
        expect(schema).toBeDefined();
        expect(schema?.parameters.userId?.injected).toBe(true);
        expect(schema?.parameters.exchange?.injected).toBe(true);
    });
});

describe("formatCEXActionForLLM — descriptions are included", () => {
    const spec = getCEXCanonicalSpec();

    it("includes the description for get_orders.margin_type", () => {
        const out = formatCEXActionForLLM("get_orders", spec.schemas);
        expect(out).toContain("margin_type");
        // The description body must reach the LLM, not just the enum.
        expect(out).toMatch(/margin/i);
        expect(out).toMatch(/CROSS/);
        // Description suffix uses `// ...` so it's visually distinct.
        expect(out).toContain("//");
    });

    it("includes the description for create_order.margin_action", () => {
        const out = formatCEXActionForLLM("create_order", spec.schemas);
        expect(out).toContain("margin_action");
        expect(out).toMatch(/AUTO_BORROW/);
        expect(out).toMatch(/borrow/i);
    });

    it("keeps the same compact key + req + enum shape on fields without descriptions", () => {
        // The format is `- key [req-label] — enum  // description?`
        const out = formatCEXActionForLLM("get_orders", spec.schemas);
        // Pick a description-less field to verify backwards compat.
        expect(out).toContain("limit [optional]");
    });

    it("preserves the action-level description on the leading line", () => {
        const out = formatCEXActionForLLM("get_orders", spec.schemas);
        expect(out.split("\n")[0]).toContain("Fetch open or historical orders");
    });
});
