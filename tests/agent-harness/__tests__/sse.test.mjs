import { describe, expect, it } from "vitest";
import { parseSseChunk } from "../lib/sse.mjs";

describe("parseSseChunk", () => {
    it("parses single data line JSON", () => {
        const events = parseSseChunk('data: {"type":"step","step":{"name":"Trading: risk check"}}\n');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: "step",
            step: { name: "Trading: risk check" },
        });
    });

    it("skips [DONE] and empty data lines", () => {
        const events = parseSseChunk("data:\ndata: [DONE]\ndata: {\"type\":\"error\",\"error\":\"x\"}\n");
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ type: "error", error: "x" });
    });

    it("returns parse_error object for invalid JSON", () => {
        const events = parseSseChunk("data: not-json\n");
        expect(events[0]).toMatchObject({ type: "parse_error", raw: "not-json" });
    });

    it("parses multiple data lines in one chunk", () => {
        const chunk = [
            'data: {"type":"step","step":{"name":"a"}}',
            'data: {"type":"intermediate_response","response":{"user":"assistant","text":"hi"}}',
        ].join("\n");
        const events = parseSseChunk(chunk);
        expect(events).toHaveLength(2);
    });
});
