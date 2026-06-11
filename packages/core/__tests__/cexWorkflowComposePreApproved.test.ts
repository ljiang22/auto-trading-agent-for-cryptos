/**
 * F10.2 — one-click "Compose a trade" pre-approval predicate.
 *
 * Tests `isComposePreApproved` directly. The predicate is the sole
 * gate that decides whether `requestParameterReview` skips the
 * `human_input_required` modal. Every safety-critical server gate
 * (risk pre-check, dep-health, idempotency, quote-freshness recheck,
 * per-symbol lock) still runs regardless of this flag — the modal is a
 * UI-side double-confirmation that we elide when the dialog has
 * already collected the user's explicit "I confirm…" gate.
 *
 * Coverage:
 *   - happy path: composed create_order + flag → true
 *   - missing flag → false (legacy compose path, modal still required)
 *   - non-create_order action with the flag → false (defense in depth;
 *     compose dialog only produces create_order today)
 *   - flag without composedAction → false (spoof guard mirroring the
 *     server body-parser rule)
 *   - string "true" instead of boolean → false (parser coerces; an
 *     un-coerced string means the parser was skipped)
 *   - missing / null / non-object content → false
 */
import { describe, expect, it } from "vitest";
import { isComposePreApproved } from "../src/handlers/cexWorkflowMessageHandler.ts";

describe("F10.2 — isComposePreApproved", () => {
    it("returns true for create_order with composedAction + composedPreApproved=true", () => {
        const content = {
            text: "limit buy 0.001 BTC on binance (BTC/USDT) at 75000 GTC",
            composedAction: "create_order",
            composedParams: { exchange: "binance", side: "BUY" },
            composedPreApproved: true,
        };
        expect(isComposePreApproved(content, "create_order")).toBe(true);
    });

    it("returns false when composedPreApproved is missing", () => {
        const content = {
            composedAction: "create_order",
            composedParams: { exchange: "binance" },
        };
        expect(isComposePreApproved(content, "create_order")).toBe(false);
    });

    it("returns false when composedPreApproved is false", () => {
        const content = {
            composedAction: "create_order",
            composedParams: { exchange: "binance" },
            composedPreApproved: false,
        };
        expect(isComposePreApproved(content, "create_order")).toBe(false);
    });

    it("returns false when composedPreApproved is the un-coerced string 'true'", () => {
        // If a FormData payload reaches the handler with the flag still as a
        // string, that means the body parser skipped the coercion step — do
        // not trust the un-validated path.
        const content = {
            composedAction: "create_order",
            composedParams: { exchange: "binance" },
            composedPreApproved: "true" as unknown as boolean,
        };
        expect(isComposePreApproved(content, "create_order")).toBe(false);
    });

    it("returns false when composedAction is absent (spoof guard)", () => {
        // A free-text message that somehow carries composedPreApproved
        // without the structured composedAction must NOT skip the modal.
        const content = {
            text: "buy 0.01 BTC",
            composedPreApproved: true,
        };
        expect(isComposePreApproved(content, "create_order")).toBe(false);
    });

    it("returns false when composedAction is an empty string", () => {
        const content = {
            composedAction: "",
            composedPreApproved: true,
        };
        expect(isComposePreApproved(content, "create_order")).toBe(false);
    });

    it("returns false for non-create_order actions even when flag is set", () => {
        const content = {
            composedAction: "cancel_order",
            composedPreApproved: true,
        };
        expect(isComposePreApproved(content, "cancel_order")).toBe(false);
        expect(isComposePreApproved(content, "amend_order")).toBe(false);
        expect(isComposePreApproved(content, "preview_order")).toBe(false);
        expect(isComposePreApproved(content, "get_balance")).toBe(false);
    });

    it("returns false for missing / null / non-object content", () => {
        expect(isComposePreApproved(undefined, "create_order")).toBe(false);
        expect(isComposePreApproved(null, "create_order")).toBe(false);
        expect(isComposePreApproved({}, "create_order")).toBe(false);
    });
});
