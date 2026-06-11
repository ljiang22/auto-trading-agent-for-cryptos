/**
 * Regression test: cancel_order is excluded from approval-modal enrichment.
 *
 * Bug: when `CEX_APPROVAL_MODAL_ENRICHMENT_ENABLED=true`, the workflow
 * built `symbol_verification` for every write action including
 * cancel_order. Cancel prompts ("yes", "cancel orders 62...1, 46...",
 * "cancel all") have no asset mention, so `buildSymbolVerification`
 * returned `{ matches: false, reason: "no_user_assets_mentioned" }`.
 * The HumanInputDialog disables Confirm when matches=false, and the
 * mismatch banner only renders inside the create_order/preview_order
 * branch — so the Confirm Cancel button silently no-op'd.
 *
 * cancel_order references orders by venue id, not by asset, so the
 * bait-and-switch guard provides no safety value here.
 */

import { describe, expect, it } from "vitest";
import { APPROVAL_MODAL_ENRICHMENT_ACTIONS } from "../src/handlers/cexWorkflowMessageHandler.ts";

describe("APPROVAL_MODAL_ENRICHMENT_ACTIONS", () => {
    it("excludes cancel_order so symbol_verification can't disable Confirm Cancel", () => {
        expect(APPROVAL_MODAL_ENRICHMENT_ACTIONS.has("cancel_order")).toBe(false);
    });

    it("still enriches the write actions that render the TradingOrderEditor / MarketSnapshotPanel", () => {
        expect(APPROVAL_MODAL_ENRICHMENT_ACTIONS.has("create_order")).toBe(true);
        expect(APPROVAL_MODAL_ENRICHMENT_ACTIONS.has("amend_order")).toBe(true);
        expect(APPROVAL_MODAL_ENRICHMENT_ACTIONS.has("preview_order")).toBe(true);
    });

    it("does not enrich read actions", () => {
        for (const action of ["get_balance", "get_orders", "get_fills", "get_ticker"]) {
            expect(APPROVAL_MODAL_ENRICHMENT_ACTIONS.has(action)).toBe(false);
        }
    });
});
