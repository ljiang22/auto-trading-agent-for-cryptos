import { describe, expect, it } from "vitest";
import {
    getCatalogEntries,
    getCanonicalCoverageMatrix,
} from "../suites/trading-prod/trading-prod-catalog.mjs";
import {
    assertNlMatchesOrderConfiguration,
    assertNoVariantKeysInNl,
    catalogEntryNlMatchesComposePreview,
} from "../lib/canonicalCaseAlignment.mjs";

describe("canonical coverage matrix", () => {
    it("every matrix row maps to a catalog entry id", () => {
        const entries = getCatalogEntries();
        const ids = new Set(entries.map((e) => e.id));
        const matrix = getCanonicalCoverageMatrix();
        const missing = matrix.filter((row) => !ids.has(row.caseId));
        expect(missing).toEqual([]);
    });

    it("includes write expansion actions", () => {
        const matrix = getCanonicalCoverageMatrix();
        const actions = new Set(matrix.map((r) => r.action));
        expect(actions.has("preview_order")).toBe(true);
        expect(actions.has("amend_order")).toBe(true);
        expect(actions.has("set_trading_mode")).toBe(true);
    });

    it("catalog NL uses canonical vocabulary not variant keys", () => {
        const entries = getCatalogEntries();
        for (const entry of entries) {
            const text = entry.nl?.text ?? entry.compose?.previewText ?? "";
            expect(assertNoVariantKeysInNl(text), entry.id).toBe(true);
        }
    });

    it("catalog NL matches compose previewText when both are set", () => {
        const entries = getCatalogEntries();
        const mismatches = entries.filter((e) => !catalogEntryNlMatchesComposePreview(e));
        expect(mismatches.map((e) => e.id)).toEqual([]);
    });

    it("compose-backed create/preview NL mentions order_configuration values", () => {
        const entries = getCatalogEntries();
        const failures = [];
        for (const entry of entries) {
            const action = entry.compose?.action;
            const params = entry.compose?.params;
            const text = entry.nl?.text ?? entry.compose?.previewText ?? "";
            if (!params || !action) continue;
            const result = assertNlMatchesOrderConfiguration(text, params, action);
            if (!result.ok) {
                failures.push(`${entry.id}: ${result.reason}`);
            }
        }
        expect(failures).toEqual([]);
    });
});
