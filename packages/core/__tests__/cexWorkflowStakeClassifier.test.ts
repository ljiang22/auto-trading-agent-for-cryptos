import { describe, expect, it } from "vitest";

import {
    classifyStake,
    isReadOnlyStake,
    knownActionNames,
} from "../src/handlers/cexWorkflowStakeClassifier.ts";

describe("classifyStake", () => {
    it("read-only allowlist", () => {
        expect(classifyStake("get_balance")).toBe("read_only");
        expect(classifyStake("get_orders")).toBe("read_only");
        expect(classifyStake("get_fills")).toBe("read_only");
        // Fix 13 — positions + PnL are read-only.
        expect(classifyStake("get_positions")).toBe("read_only");
        expect(classifyStake("get_pnl")).toBe("read_only");
    });

    it("write allowlist", () => {
        expect(classifyStake("create_order")).toBe("write");
        expect(classifyStake("cancel_order")).toBe("write");
        expect(classifyStake("amend_order")).toBe("write");
        expect(classifyStake("preview_order")).toBe("write");
    });

    it("unknown actions default to write (fail-closed)", () => {
        expect(classifyStake("delete_universe")).toBe("write");
        expect(classifyStake("")).toBe("write");
    });

    it("isReadOnlyStake helper", () => {
        expect(isReadOnlyStake("read_only")).toBe(true);
        expect(isReadOnlyStake("write")).toBe(false);
    });

    it("knownActionNames returns both buckets", () => {
        const known = knownActionNames();
        expect(known.read_only).toContain("get_balance");
        expect(known.write).toContain("create_order");
    });
});
