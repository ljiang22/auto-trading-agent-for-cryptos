import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Covers PR #158: the two `[memories API]` log lines on the /memories endpoint
 * fire on every paginated request (i.e. on every chat panel open). Logging
 * them at WARN drowned CloudWatch's actual-warning signal. They must be INFO.
 *
 * The route handler lives inside `createApiRouter` which takes an AgentRuntime,
 * an Express app, a DirectClient, and a Stripe service — too much scaffolding
 * for what is fundamentally a one-token level change. We pin the behaviour
 * with a source-level regression check: any reintroduction of `warn` on these
 * specific log lines fails CI.
 */

const apiSource = readFileSync(
    resolve(__dirname, "../src/api.ts"),
    "utf8"
);

describe("[memories API] log level (PR #158)", () => {
    it("has at least one INFO call on the [memories API] pagination path", () => {
        // Sanity: the log lines we care about still exist (we're not just
        // accidentally testing a file that no longer has them).
        const infoMatches = apiSource.match(
            /elizaLogger\.info\(\s*`\[memories API\][^`]*`/g
        );
        expect(infoMatches).not.toBeNull();
        expect(infoMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it("does NOT log [memories API] pagination at WARN", () => {
        const warnMatches = apiSource.match(
            /elizaLogger\.warn\(\s*`\[memories API\][^`]*`/g
        );
        expect(warnMatches).toBeNull();
    });
});
