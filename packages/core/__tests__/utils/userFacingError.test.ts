import { describe, expect, it } from "vitest";
import {
    buildUserError,
    renderUserErrorMarkdown,
} from "../../src/utils/userFacingError";

describe("buildUserError", () => {
    it("returns title + body + action for every code (EN)", () => {
        const codes = [
            "risk_block",
            "risk_kill_switch",
            "fail_closed_audit",
            "fail_closed_reconciliation",
            "fail_closed_market_data",
            "unknown_state",
            "idempotency_hit",
            "dep_unhealthy",
            "venue_timeout",
            "venue_5xx",
            "venue_4xx",
            "prompt_injection_refused",
            "prompt_injection_downgrade",
            "approval_rejected",
            "approval_expired",
            "consent_required",
            "geo_restricted",
            "kill_switch_on",
            "rate_limited",
            "unknown",
        ] as const;
        for (const code of codes) {
            const e = buildUserError({ code, locale: "en" });
            expect(e.code).toBe(code);
            expect(e.title.length).toBeGreaterThan(0);
            expect(e.body.length).toBeGreaterThanOrEqual(0);
            expect(e.action.length).toBeGreaterThan(0);
        }
    });

    it("returns Chinese for zh-CN locale", () => {
        const e = buildUserError({ code: "risk_kill_switch", locale: "zh-CN" });
        expect(e.title).toContain("终止开关");
    });

    it("interpolates {{key}} from context", () => {
        const e = buildUserError({
            code: "rate_limited",
            locale: "en",
            context: { retry_in_seconds: 10 },
        });
        expect(e.action).toContain("10 seconds");
    });

    it("renderUserErrorMarkdown joins title, body, action with a blockquote", () => {
        const err = buildUserError({ code: "approval_rejected", locale: "en" });
        const md = renderUserErrorMarkdown(err);
        expect(md).toContain(`**${err.title}**`);
        expect(md).toContain(err.body);
        expect(md).toContain(`> ${err.action}`);
    });

    it("falls back to `unknown` for unrecognized codes", () => {
        // @ts-expect-error testing fallback behavior
        const e = buildUserError({ code: "definitely-not-real" });
        // Code field echoes the request; title comes from the unknown entry.
        expect(e.title.length).toBeGreaterThan(0);
        expect(e.action).toContain("Contact support");
    });
});
