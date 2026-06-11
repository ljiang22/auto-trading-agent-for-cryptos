import { describe, expect, it } from "vitest";
// Cross-package import: this util lives in `client/` (pure TS, no React deps) but the
// `client/` package has no vitest setup; we host the test next to approvalLookup.test.ts
// in `client-direct/__tests__` where the test runner already runs.
import {
    isHumanInputFieldMissing,
    parseHumanInputValue,
} from "../../../client/src/components/Dialog/humanInputParsing.ts";

describe("human input parsing", () => {
    it("does not coerce empty numeric input to zero", () => {
        expect(parseHumanInputValue("", "number")).toBeUndefined();
        expect(parseHumanInputValue("   ", "number")).toBeUndefined();
    });

    it("preserves explicit numeric zero", () => {
        expect(parseHumanInputValue("0", "number")).toBe(0);
    });

    it("throws for invalid non-empty number values", () => {
        expect(() => parseHumanInputValue("abc", "number")).toThrow("Expected number");
    });

    it("accepts true/false (case-insensitive) and treats empty as undefined", () => {
        expect(parseHumanInputValue("true", "boolean")).toBe(true);
        expect(parseHumanInputValue("FALSE", "boolean")).toBe(false);
        expect(parseHumanInputValue("", "boolean")).toBeUndefined();
        expect(parseHumanInputValue("   ", "boolean")).toBeUndefined();
    });

    it("throws for invalid non-empty boolean values", () => {
        expect(() => parseHumanInputValue("yes", "boolean")).toThrow("Expected boolean");
        expect(() => parseHumanInputValue("1", "boolean")).toThrow("Expected boolean");
    });

    it("parses arrays and objects as expected", () => {
        expect(parseHumanInputValue("", "array")).toEqual([]);
        expect(parseHumanInputValue("a, b", "array")).toEqual(["a", "b"]);
        expect(parseHumanInputValue("", "object")).toEqual({});
        expect(parseHumanInputValue("{\"k\":1}", "object")).toEqual({ k: 1 });
    });

    it("throws a typed error for invalid object JSON", () => {
        expect(() => parseHumanInputValue("not-json", "object")).toThrow("Expected JSON object");
    });

    it("enforces required-field missing checks", () => {
        expect(isHumanInputFieldMissing("", { type: "number", required: true } as any)).toBe(true);
        expect(isHumanInputFieldMissing("0", { type: "number", required: true } as any)).toBe(false);
        expect(isHumanInputFieldMissing("", { type: "number", required: false } as any)).toBe(false);
    });
});
