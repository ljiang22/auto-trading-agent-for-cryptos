import { describe, expect, it } from "vitest";
import {
    escapeUnescapedControlCharsInJsonStrings,
    extractFirstBalancedJsonObject,
    parseCexFormattedResultEnvelope,
} from "../src/handlers/cexWorkflowMessageHandler.ts";

/**
 * Copy of `parseCexMarkdownJsonContract` in `cexWorkflowMessageHandler.ts` (keep in sync).
 * Local so tests can compare to trading parsers without exporting the symbol from the handler.
 */
function parseCexMarkdownJsonContract(
    raw: string,
    mode: "action_or_response" | "response_only"
): Record<string, unknown> | null {
    const t = raw.trim();
    const fenceRe = /\n?\s*```(?:json)?\s*\n?/gi;
    const fencedBodies: string[] = [];
    for (let m = fenceRe.exec(t); m !== null; m = fenceRe.exec(t)) {
        fencedBodies.push(t.slice(m.index + m[0].length).trim());
    }

    const parseTolerant = (slice: string): unknown | undefined => {
        try {
            return JSON.parse(slice);
        } catch {
            try {
                return JSON.parse(
                    escapeUnescapedControlCharsInJsonStrings(slice),
                );
            } catch {
                return undefined;
            }
        }
    };

    const tryBodies = (bodies: string[]): Record<string, unknown> | null => {
        for (const body of bodies) {
            const slice = extractFirstBalancedJsonObject(body);
            if (!slice) continue;
            const parsed = parseTolerant(slice);
            if (!parsed || typeof parsed !== "object") continue;
            const o = parsed as Record<string, unknown>;
            if (mode === "response_only") {
                if ("response" in o) return o;
                continue;
            }
            if (typeof o.action === "string" && o.action.length > 0) {
                return o;
            }
            if ("response" in o) {
                return o;
            }
        }
        return null;
    };

    if (fencedBodies.length > 0) {
        const ordered =
            mode === "response_only" ? [...fencedBodies].reverse() : fencedBodies;
        const hit = tryBodies(ordered);
        if (hit) return hit;
    }

    const slice = extractFirstBalancedJsonObject(t);
    if (!slice) return null;
    const parsed = parseTolerant(slice);
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (mode === "response_only") {
        return "response" in o ? o : null;
    }
    if (typeof o.action === "string" && o.action.length > 0) return o;
    return "response" in o ? o : null;
}

describe("extractFirstBalancedJsonObject", () => {
    it("extracts object when the response string contains triple backticks (markdown fence)", () => {
        const payload = {
            response: "## Placed\n\n```\norderId: 1\n```\n",
        };
        const inner = JSON.stringify(payload, null, 2);
        const slice = extractFirstBalancedJsonObject(inner);
        expect(slice).not.toBeNull();
        expect(JSON.parse(slice!)).toEqual(payload);
    });
});

describe("parseCexFormattedResultEnvelope", () => {
    it("unwraps fenced JSON with inner code fences in the response value", () => {
        const envelope = { response: "Line1\n```\ninner\n```\nLine2" };
        const raw = "```json\n" + JSON.stringify(envelope, null, 2) + "\n```";
        expect(parseCexFormattedResultEnvelope(raw)).toBe(envelope.response);
    });

    it("unwraps bare JSON without markdown fences", () => {
        const raw = JSON.stringify({ response: "Balance **ok**" });
        expect(parseCexFormattedResultEnvelope(raw)).toBe("Balance **ok**");
    });

    it("stringifies non-string response values", () => {
        const raw = "```json\n" + JSON.stringify({ response: { a: 1 } }, null, 2) + "\n```";
        expect(parseCexFormattedResultEnvelope(raw)).toBe(JSON.stringify({ a: 1 }, null, 2));
    });

    it("prefers the last fenced JSON block when an earlier block is not a response envelope", () => {
        const noise =
            "```json\n" + JSON.stringify({ action: "check_balance", parameters: {} }) + "\n```";
        const envelope = { response: "Final user markdown" };
        const raw = noise + "\n\n```json\n" + JSON.stringify(envelope, null, 2) + "\n```";
        expect(parseCexFormattedResultEnvelope(raw)).toBe("Final user markdown");
    });

    // Regression: LLM output for a batch cancel is multi-row markdown.
    // Models routinely emit literal newlines inside the response string
    // (technically invalid JSON), causing JSON.parse to throw and the
    // raw envelope to leak into the chat. We must recover the markdown.
    it("recovers when the LLM emits unescaped newlines in the response value", () => {
        const broken = [
            "{",
            '  "response": "Here is the summary:',
            "",
            "### Order Cancellation Summary",
            "",
            "| Order ID | Status |",
            "|---|---|",
            "| 61915077249 | CANCELED |",
            '| 61915077250 | CANCELED |"',
            "}",
        ].join("\n");
        const out = parseCexFormattedResultEnvelope(broken);
        expect(out).toContain("### Order Cancellation Summary");
        expect(out).toContain("| 61915077249 | CANCELED |");
        // Must not be the raw envelope text.
        expect(out.startsWith("{")).toBe(false);
    });

    it("recovers from unescaped newlines wrapped in a json fence", () => {
        const broken = [
            "```json",
            "{",
            '  "response": "Line one',
            "Line two",
            '| col | val |"',
            "}",
            "```",
        ].join("\n");
        const out = parseCexFormattedResultEnvelope(broken);
        expect(out).toContain("Line one");
        expect(out).toContain("Line two");
    });

    it("preserves valid escape sequences and never double-escapes", () => {
        // Already-valid envelope with explicit \n must round-trip exactly.
        const envelope = { response: "Row1\\nRow2 with **bold**" };
        const raw = JSON.stringify(envelope);
        expect(parseCexFormattedResultEnvelope(raw)).toBe("Row1\\nRow2 with **bold**");
    });
});

describe("escapeUnescapedControlCharsInJsonStrings", () => {
    it("leaves valid JSON unchanged", () => {
        const valid = JSON.stringify({ response: "a\nb\tc" });
        expect(escapeUnescapedControlCharsInJsonStrings(valid)).toBe(valid);
    });
    it("escapes literal newlines inside a string value", () => {
        const broken = '{"response":"line1\nline2"}';
        const fixed = escapeUnescapedControlCharsInJsonStrings(broken);
        expect(JSON.parse(fixed)).toEqual({ response: "line1\nline2" });
    });
    it("does not touch whitespace outside strings", () => {
        const pretty = '{\n  "k": "v"\n}';
        expect(escapeUnescapedControlCharsInJsonStrings(pretty)).toBe(pretty);
    });
    it("preserves existing escapes (e.g., \\\" inside a string)", () => {
        const withEscapedQuote = '{"k":"a\\"b"}';
        const fixed = escapeUnescapedControlCharsInJsonStrings(withEscapedQuote);
        expect(JSON.parse(fixed)).toEqual({ k: 'a"b' });
    });
    it("escapes carriage returns and tabs alongside newlines", () => {
        const broken = '{"k":"x\r\ty\nz"}';
        const fixed = escapeUnescapedControlCharsInJsonStrings(broken);
        expect(JSON.parse(fixed)).toEqual({ k: "x\r\ty\nz" });
    });
});

/**
 * Mirrors `tradingInfoMessageHandler.ts` formatted-result parsing (~771–784): first ```json
 * fence only, non-greedy, then JSON.parse.
 */
function parseTradingStyleFormattedResultEnvelope(response: string): string {
    try {
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) {
            return response;
        }
        const parsedJson = JSON.parse(jsonMatch[1]) as { response?: unknown };
        if (typeof parsedJson?.response === "string") {
            return parsedJson.response;
        }
        return response;
    } catch {
        return response;
    }
}

describe("formatted result envelope vs tradingInfoMessageHandler", () => {
    it("agrees with trading parser for a single fenced string response", () => {
        const raw = "```json\n" + JSON.stringify({ response: "Done" }, null, 2) + "\n```";
        expect(parseCexFormattedResultEnvelope(raw)).toBe(parseTradingStyleFormattedResultEnvelope(raw));
    });

    it("agrees with trading parser when there is no ```json fence (raw model text)", () => {
        const raw = "Some plain text";
        expect(parseCexFormattedResultEnvelope(raw)).toBe(parseTradingStyleFormattedResultEnvelope(raw));
    });

    it("CEX improves on trading when the first fenced block is not a response envelope", () => {
        const noise =
            "```json\n" + JSON.stringify({ action: "check_balance", parameters: {} }) + "\n```";
        const envelope = { response: "User-facing summary" };
        const raw = noise + "\n\n```json\n" + JSON.stringify(envelope, null, 2) + "\n```";
        expect(parseTradingStyleFormattedResultEnvelope(raw)).toBe(raw);
        expect(parseCexFormattedResultEnvelope(raw)).toBe("User-facing summary");
    });
});

/**
 * Mirrors `tradingInfoMessageHandler.ts` `parseResponse` (~359–407): first ```json block only.
 */
function parseTradingStyleActionOrResponse(rawResponse: string): {
    isAction: boolean;
    action?: string;
    parameters?: Record<string, unknown>;
    text?: string;
} {
    const jsonMatch = rawResponse.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
        return { isAction: false, text: rawResponse };
    }
    try {
        const parsed = JSON.parse(jsonMatch[1]) as {
            action?: string;
            parameters?: Record<string, unknown>;
            response?: unknown;
        };
        if (parsed?.action) {
            return {
                isAction: true,
                action: parsed.action,
                parameters: parsed.parameters || {},
            };
        }
        if (parsed?.response) {
            return {
                isAction: false,
                text: parsed.response as string,
            };
        }
        return { isAction: false, text: rawResponse };
    } catch {
        return { isAction: false, text: rawResponse };
    }
}

function parseCexStyleActionOrResponse(rawResponse: string): {
    isAction: boolean;
    action?: string;
    parameters?: Record<string, unknown>;
    text?: string;
} {
    const parsed = parseCexMarkdownJsonContract(rawResponse, "action_or_response");
    if (!parsed) {
        return { isAction: false, text: rawResponse };
    }
    if (typeof parsed.action === "string" && parsed.action.length > 0) {
        const params =
            typeof parsed.parameters === "object" && parsed.parameters !== null
                ? (parsed.parameters as Record<string, unknown>)
                : {};
        return { isAction: true, action: parsed.action, parameters: params };
    }
    if ("response" in parsed) {
        const v = parsed.response;
        const text =
            typeof v === "string"
                ? v
                : v !== null && typeof v === "object"
                  ? JSON.stringify(v, null, 2)
                  : undefined;
        if (text !== undefined) {
            return { isAction: false, text };
        }
    }
    return { isAction: false, text: rawResponse };
}

describe("action_or_response contract vs tradingInfoMessageHandler parseResponse", () => {
    it("agrees for a single ```json action block", () => {
        const raw =
            "```json\n" +
            JSON.stringify({ action: "PLACE_ORDER", parameters: { product_id: "BTC-USD" } }, null, 2) +
            "\n```";
        const a = parseTradingStyleActionOrResponse(raw);
        const b = parseCexStyleActionOrResponse(raw);
        expect(b.isAction).toBe(true);
        expect(a).toEqual(b);
    });

    it("agrees for a single ```json response block", () => {
        const raw = "```json\n" + JSON.stringify({ response: "Need more detail." }, null, 2) + "\n```";
        const a = parseTradingStyleActionOrResponse(raw);
        const b = parseCexStyleActionOrResponse(raw);
        expect(b.isAction).toBe(false);
        expect(a.text).toBe(b.text);
    });

    it("agrees when there is no fenced JSON", () => {
        const raw = "Plain assistant reply";
        expect(parseCexStyleActionOrResponse(raw)).toEqual(parseTradingStyleActionOrResponse(raw));
    });

    it("CEX prefers first action in document order when multiple fenced objects exist", () => {
        const first =
            "```json\n" +
            JSON.stringify({ action: "A", parameters: { x: 1 } }, null, 2) +
            "\n```";
        const second =
            "\n```json\n" + JSON.stringify({ action: "B", parameters: { y: 2 } }, null, 2) + "\n```";
        const raw = first + second;
        const cex = parseCexStyleActionOrResponse(raw);
        expect(cex.isAction).toBe(true);
        expect(cex.action).toBe("A");
        const trading = parseTradingStyleActionOrResponse(raw);
        expect(trading.isAction).toBe(true);
        expect(trading.action).toBe("A");
    });
});

describe("parseCexFormattedResultEnvelope — invalid-escape / unescaped-quote recovery", () => {
    it("recovers a response with a markdown-escaped dollar sign (\\$) that breaks JSON.parse", () => {
        // Long trading markdown often contains `\$60,691.90` etc. — an invalid
        // JSON escape that defeats both JSON.parse and the control-char retry,
        // so the raw envelope used to leak into the chat.
        const raw = '{"response": "Buy BTC near \\$60,691.90 support with \\$1000."}';
        const out = parseCexFormattedResultEnvelope(raw);
        expect(out.startsWith("{")).toBe(false);
        expect(out).toContain("$60,691.90");
        expect(out).toContain("$1000");
    });

    it("recovers a response containing an unescaped interior double-quote", () => {
        const raw = '{"response": "Buy at the "support" level near 60k."}';
        const out = parseCexFormattedResultEnvelope(raw);
        expect(out.startsWith("{")).toBe(false);
        expect(out).toContain("support");
        expect(out).toContain("near 60k.");
    });

    it("recovers a realistic multi-strategy reply with \\$ + raw newlines + headings", () => {
        const raw = [
            "{",
            '  "response": "Here are 3 auto-trading strategy options for \\$1000.',
            "",
            "## Strategy Option 1: Conservative DCA",
            "",
            "*   Buy when price is near \\$60,691.90 support.\"",
            "}",
        ].join("\n");
        const out = parseCexFormattedResultEnvelope(raw);
        expect(out.startsWith("{")).toBe(false);
        expect(out).toContain("## Strategy Option 1");
        expect(out).toContain("$1000");
        expect(out).toContain("$60,691.90");
    });

    it("leaves a genuine plain-markdown reply (no envelope) unchanged", () => {
        const raw = "## Strategy\n\nBuy BTC near $60k.";
        expect(parseCexFormattedResultEnvelope(raw)).toBe(raw.trim());
    });
});
