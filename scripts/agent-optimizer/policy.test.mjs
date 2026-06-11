import test from "node:test";
import assert from "node:assert/strict";
import { EDITABLE_ALLOWLIST, isAutoEditableCodePath, isProtectedPath, partitionPaths } from "./policy.mjs";

// GEAP §8 policy — the safety surface the autonomous loop may NEVER auto-edit. Locks the directory-
// anchored fail-closed protection added after the 2026-06-10 adversarial review, which proved a
// name-fragment denylist missed nearly the entire real trading-safety surface.

// The exact files the review reproduced an auto-approve against — every one must now be PROTECTED.
const MUST_BE_PROTECTED = [
    "packages/plugin-cex/src/risk/riskEngine.ts",
    "packages/plugin-cex/src/risk/rules/leverageCap.ts",
    "packages/plugin-cex/src/risk/types.ts", // assetAllowlist + BACKSTOP_DENIED_ASSETS
    "packages/plugin-cex/src/intent/canonicalIntent.ts",
    "packages/plugin-cex/src/reconciliation/pendingOrdersLedger.ts",
    "packages/plugin-cex/src/exchanges/services/binance.ts", // order submit
    "packages/plugin-cex/src/actions/setTradingMode.ts",
    "packages/core/src/handlers/cexWorkflowMessageHandler.ts",
    "packages/core/src/handlers/humanInputState.ts",
    "packages/core/src/handlers/statusReport.ts",
    "packages/core/src/security/tokensCrypto.ts",
    "packages/core/src/core/runtime.ts",
    "packages/core/src/templates/cexMessageTemplate.ts",
    "packages/core/src/utils/promptInjectionDefense.ts",
    "packages/core/src/utils/cexBypassPredicate.ts",
    "agent/src/index.ts",
    "agent/src/pluginFilter.ts",
    // re-review additions (2026-06-10): HTTP API / auth / trading endpoints + env/settings validation
    "packages/client-direct/src/api.ts", // kill-switch / exchange-key / trading-prefs PUT handlers
    "packages/client-direct/src/index.ts", // auth middleware + s3FilesHandler + __activeStreams
    "packages/core/src/config/environment.ts", // zod env validation (EXCHANGE_TOKEN_ENCRYPTION_KEY etc.)
    "packages/core/src/config/settings.ts",
    // manifests / lockfiles — a dependency change is a supply-chain risk
    "package.json",
    "agent/package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    // absolute paths must match too (anchors allow a leading /)
    "/home/dev/repo/packages/plugin-cex/src/risk/riskEngine.ts",
];

for (const p of MUST_BE_PROTECTED) {
    test(`PROTECTED: ${p}`, () => assert.equal(isProtectedPath(p), true));
}

test("genuinely non-safety files are NOT protected", () => {
    assert.equal(isProtectedPath("characters/CryptoTrader.json"), false);
    assert.equal(isProtectedPath("packages/plugin-news/src/index.ts"), false);
    assert.equal(isProtectedPath("client/src/components/Foo.tsx"), false);
    assert.equal(isProtectedPath("docs/readme.md"), false);
});

test("EDITABLE_ALLOWLIST is empty by default ⇒ no code path is auto-editable (deny-by-default)", () => {
    assert.deepEqual(EDITABLE_ALLOWLIST, []);
    assert.equal(isAutoEditableCodePath("packages/plugin-news/src/index.ts"), false);
    assert.equal(isAutoEditableCodePath("client/src/components/Foo.tsx"), false);
    // protection always wins, even if a future allowlist entry overlapped a protected dir
    assert.equal(isAutoEditableCodePath("packages/plugin-cex/src/risk/riskEngine.ts"), false);
});

test("partitionPaths splits protected vs editable", () => {
    const { protected: prot, editable } = partitionPaths([
        "packages/plugin-cex/src/risk/riskEngine.ts",
        "characters/CryptoTrader.json",
        "packages/core/src/handlers/cexWorkflowMessageHandler.ts",
    ]);
    assert.deepEqual(prot.sort(), ["packages/core/src/handlers/cexWorkflowMessageHandler.ts", "packages/plugin-cex/src/risk/riskEngine.ts"]);
    assert.deepEqual(editable, ["characters/CryptoTrader.json"]);
});
