import { describe, expect, it } from "vitest";
import { buildCanonicalIntent } from "../src/intent/intentBuilder";
import {
    extractAmendOrderInput,
    extractCancelOrderInput,
    extractCreateOrderInput,
    extractGetBalanceInput,
    extractGetOrdersInput,
    extractPreviewOrderInput,
} from "../src/adk/parameterExtractor";
// @ts-expect-error harness catalog is ESM .mjs
import { getCatalogEntries } from "../../../tests/agent-harness/suites/trading-prod/trading-prod-catalog.mjs";
// @ts-expect-error harness fixtures ESM
import { catalogEntryToCase } from "../../../tests/agent-harness/lib/tradingFixtures.mjs";
// @ts-expect-error harness alignment ESM
import {
    assertNoVariantKeysInNl,
    catalogEntryNlMatchesComposePreview,
    expectedCanonicalFieldsFromCompose,
    variantToOrderType,
} from "../../../tests/agent-harness/lib/canonicalCaseAlignment.mjs";

const TEST_USER = "00000000-0000-0000-0000-000000000001";

function buildIntentFromEntry(entry: {
    compose?: { action?: string; params?: Record<string, unknown> };
}) {
    const action = entry.compose?.action;
    if (
        !action ||
        !["create_order", "preview_order", "amend_order", "cancel_order"].includes(action)
    ) {
        return null;
    }
    const params = { ...entry.compose?.params };
    if (typeof params.client_order_id === "string") {
        params.client_order_id = params.client_order_id;
    }
    return buildCanonicalIntent({
        action: action as "create_order" | "preview_order" | "amend_order" | "cancel_order",
        venue: "binance",
        userId: TEST_USER,
        locale: "en",
        mode: (params.mode as "live") ?? "live",
        params: {
            userId: TEST_USER,
            exchange: "binance",
            ...params,
        },
    });
}

describe("trading prod harness ↔ canonical intent", () => {
    const entries = getCatalogEntries();

    it("every catalog entry NL matches compose previewText when both exist", () => {
        const mismatches = entries.filter(
            (e: { nl?: { text?: string }; compose?: { previewText?: string } }) =>
                !catalogEntryNlMatchesComposePreview(e),
        );
        expect(mismatches.map((e: { id: string }) => e.id)).toEqual([]);
    });

    it("catalog NL contains no internal variant keys", () => {
        for (const entry of entries) {
            const text = entry.nl?.text ?? entry.compose?.previewText ?? "";
            expect(assertNoVariantKeysInNl(text), entry.id).toBe(true);
        }
    });

    it("compose-backed write cases build valid canonical intents", () => {
        const failures: string[] = [];
        for (const entry of entries) {
            if (!entry.compose?.action) continue;
            if ((entry.tags as string[] | undefined)?.includes("risk_deny")) {
                continue;
            }
            try {
                const intent = buildIntentFromEntry(entry);
                if (!intent) continue;
                const expected = expectedCanonicalFieldsFromCompose(
                    catalogEntryToCase(entry),
                );
                if (expected?.order_type) {
                    expect(intent.order_type, entry.id).toBe(expected.order_type);
                }
                if (expected?.side) {
                    expect(intent.side, entry.id).toBe(expected.side);
                }
            } catch (err) {
                failures.push(
                    `${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
        expect(failures).toEqual([]);
    });

    it("trailing and OCO variants infer correct order_type", () => {
        const trailing = entries.find(
            (e: { id: string }) => e.id === "spot-trailing_stop_limit_gtc",
        );
        const oco = entries.find((e: { id: string }) => e.id === "spot-oco_gtc");
        expect(trailing).toBeTruthy();
        expect(oco).toBeTruthy();
        const trailingIntent = buildIntentFromEntry(trailing);
        const ocoIntent = buildIntentFromEntry(oco);
        expect(trailingIntent?.order_type).toBe("trailing_stop_limit");
        expect(trailingIntent?.execution_constraints?.trailing_delta_bps).toBe(100);
        expect(ocoIntent?.order_type).toBe("oco");
    });

    describe("NL extractors align with compose (explicit venue)", () => {
        it("create_order market IOC", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "spot-market_market_ioc",
            );
            const nl = entry.nl.text as string;
            const extracted = extractCreateOrderInput(nl);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.side).toBe(entry.compose.params.side);
                expect(extracted.order_type).toBe("market");
                expect(extracted.quote_size).toBe("6.00");
            }
        });

        it("create_order limit GTC extracts side and limit price", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "spot-limit_limit_gtc",
            );
            const nl = entry.nl.text as string;
            const extracted = extractCreateOrderInput(nl);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.side).toBe("BUY");
                expect(extracted.order_type).toBe("limit");
                expect(extracted.limit_price).toBe(
                    entry.compose.params.order_configuration.limit_limit_gtc
                        .limit_price,
                );
            }
        });

        it("create_order stop-limit GTC extracts stop and limit", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "spot-stop_limit_stop_limit_gtc",
            );
            const oc =
                entry.compose.params.order_configuration.stop_limit_stop_limit_gtc;
            const extracted = extractCreateOrderInput(entry.nl.text);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.stop_price).toBe(oc.stop_price);
                expect(extracted.limit_price).toBe(oc.limit_price);
            }
        });

        it("get_balance spot wallet_type", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "ro-balance-spot",
            );
            const extracted = extractGetBalanceInput(entry.nl.text);
            expect(extracted.wallet_type).toBe("spot");
        });

        it("get_orders cross margin", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "ro-orders-margin-cross",
            );
            const extracted = extractGetOrdersInput(entry.nl.text);
            expect(extracted.symbol).toBeTruthy();
        });

        it("cancel by order ids", () => {
            const entry = entries.find((e: { id: string }) => e.id === "cancel-by-ids");
            const extracted = extractCancelOrderInput(entry.nl.text);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.order_ids?.length).toBeGreaterThan(0);
            }
        });

        it("amend order limit price", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "amend-spot-limit",
            );
            const extracted = extractAmendOrderInput(entry.nl.text);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.new_limit_price).toBeTruthy();
            }
        });

        it("preview market buy", () => {
            const entry = entries.find(
                (e: { id: string }) => e.id === "preview-spot-market",
            );
            const extracted = extractPreviewOrderInput(entry.nl.text);
            expect("needsClarification" in extracted).toBe(false);
            if (!("needsClarification" in extracted)) {
                expect(extracted.order_type).toBe("market");
            }
        });
    });
});

describe("variantToOrderType", () => {
    it("maps exotic Binance variants", () => {
        expect(variantToOrderType("trailing_stop_limit_gtc")).toBe(
            "trailing_stop_limit",
        );
        expect(variantToOrderType("oco_gtc")).toBe("oco");
    });
});
