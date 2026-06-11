import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// H4-regress — when the reconciliation fallback queries Binance GET
// /api/v3/order with a signed REST call, it MUST read the auth bag
// using the same field names the exchange registry seeds and the
// venue order POST path uses (`apiKeyName` / `apiKeySecret`). An
// earlier drift to `apiKey` / `apiSecret` made every signed poll
// throw `Missing required auth field "apiKey"`; the fallback stayed
// dark, the downgrade fired after 60 unresolved-streak misses, and
// reconciliation was effectively non-operational on Binance even
// though the user had valid creds saved.
//
// Wire-level mocking of `node:https` clashes with the runtime's
// httpsAgent (Agent constructor used at module load). Structural test
// instead: the source files for the venue POST path AND the
// reconciliation REST path must read the SAME auth field names.

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSource(rel: string): string {
    return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("H4-regress — Binance reconciliation auth field names match venue + registry", () => {
    const reconciliationSrc = readSource("src/reconciliation/reconciliationFallback.ts");
    const binanceVenueSrc = readSource("src/exchanges/services/binance.ts");

    it("queryBinanceOrder reads `apiKeyName` (not `apiKey`)", () => {
        // Lift the queryBinanceOrder body — must reference apiKeyName.
        const queryFnIdx = reconciliationSrc.indexOf("async function queryBinanceOrder");
        expect(queryFnIdx).toBeGreaterThan(-1);
        const fnBody = reconciliationSrc.slice(queryFnIdx, queryFnIdx + 2000);
        expect(fnBody).toMatch(/requireAuth\(\s*cred,\s*"apiKeyName"/);
        // Negative: the legacy mis-named call must not be present in
        // the same function body.
        expect(fnBody).not.toMatch(/requireAuth\(\s*cred,\s*"apiKey"\s*\)/);
    });

    it("queryBinanceOrder reads `apiKeySecret` (not `apiSecret`)", () => {
        const queryFnIdx = reconciliationSrc.indexOf("async function queryBinanceOrder");
        const fnBody = reconciliationSrc.slice(queryFnIdx, queryFnIdx + 2000);
        expect(fnBody).toMatch(/requireAuth\(\s*cred,\s*"apiKeySecret"/);
        expect(fnBody).not.toMatch(/requireAuth\(\s*cred,\s*"apiSecret"\s*\)/);
    });

    it("Binance venue order POST path uses the same auth field names", () => {
        // Reconciliation MUST agree with whatever the venue order POST
        // path uses, otherwise the user's saved creds work for placing
        // orders but not for reconciling them.
        expect(binanceVenueSrc).toMatch(/requireAuthString\([^)]+,\s*"apiKeyName"/);
        expect(binanceVenueSrc).toMatch(/requireAuthString\([^)]+,\s*"apiKeySecret"/);
    });

    it("exchange_registry seed (sqlite adapter) declares the same field ids", () => {
        // The seed in adapter-sqlite is the source of truth for what
        // field.id values land in the auth bag (via
        // buildAuthRecordFromTokens). If the seed ever changes to e.g.
        // `apiKey`, this test fails and forces the reconciliation +
        // venue code to be updated in lockstep.
        const seedSrc = readFileSync(
            join(__dirname, "..", "..", "adapter-sqlite/src/index.ts"),
            "utf8",
        );
        const binanceSeedIdx = seedSrc.indexOf("const binanceAuthTypes");
        expect(binanceSeedIdx).toBeGreaterThan(-1);
        const seedBlock = seedSrc.slice(binanceSeedIdx, binanceSeedIdx + 1500);
        expect(seedBlock).toMatch(/id:\s*"apiKeyName"/);
        expect(seedBlock).toMatch(/id:\s*"apiKeySecret"/);
    });
});
