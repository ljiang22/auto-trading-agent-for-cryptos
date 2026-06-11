/**
 * Pluggable expectation evaluators for suite cases.
 */

/** @type {Map<string, (ctx: AssertionContext) => string | null>} */
const customAssertions = new Map();

/**
 * @typedef {Object} AssertionContext
 * @property {import("./transcript.mjs").TranscriptState} transcript
 * @property {Record<string, unknown>} expect
 * @property {Record<string, unknown>} caseDef
 */

/**
 * @param {string} name
 * @param {(ctx: AssertionContext) => string | null} fn - return error message or null if ok
 */
export function registerAssertion(name, fn) {
    customAssertions.set(name, fn);
}

function toLowerArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter(Boolean);
}

/**
 * @param {AssertionContext} ctx
 * @returns {string[]} failure messages
 */
export function evaluateExpectations(ctx) {
    const failures = [];
    const { transcript, expect } = ctx;
    if (!expect || typeof expect !== "object") {
        return failures;
    }

    if (expect.pass === false) {
        // explicit fail expectation — handled by runner if needed
    }

    if (typeof expect.maxDurationMs === "number" && Number.isFinite(expect.maxDurationMs)) {
        const elapsed = Date.now() - transcript.startedAt;
        if (elapsed > expect.maxDurationMs) {
            failures.push(
                `exceeded maxDurationMs ${expect.maxDurationMs} (took ${elapsed}ms)`,
            );
        }
    }

    if (transcript.errorMessage) {
        if (expect.expectError !== true) {
            failures.push(`stream error: ${transcript.errorMessage}`);
        }
    } else if (expect.expectError === true) {
        failures.push("expected stream error but none occurred");
    }

    if (expect.finalTextContains) {
        const needles = Array.isArray(expect.finalTextContains)
            ? expect.finalTextContains
            : [expect.finalTextContains];
        const hay = transcript.lastAssistantText || "";
        for (const needle of needles) {
            if (typeof needle === "string" && !hay.includes(needle)) {
                failures.push(`finalText missing substring: ${needle}`);
            }
        }
    }

    if (expect.finalTextNotContains) {
        const needles = Array.isArray(expect.finalTextNotContains)
            ? expect.finalTextNotContains
            : [expect.finalTextNotContains];
        const hay = transcript.lastAssistantText || "";
        for (const needle of needles) {
            if (typeof needle === "string" && hay.includes(needle)) {
                failures.push(`finalText must not contain: ${needle}`);
            }
        }
    }

    if (expect.finalTextMatches) {
        const pattern = expect.finalTextMatches;
        const hay = transcript.lastAssistantText || "";
        if (typeof pattern === "string") {
            const re = new RegExp(pattern, expect.finalTextMatchesFlags || "i");
            if (!re.test(hay)) {
                failures.push(`finalText does not match /${pattern}/`);
            }
        }
    }

    if (expect.expectedClassification) {
        const expected = String(expect.expectedClassification).toUpperCase();
        if (transcript.detectedClassification !== expected) {
            failures.push(
                `expected classification=${expected}, got=${transcript.detectedClassification ?? "none"}`,
            );
        }
    }

    if (typeof expect.expectedIsCryptoRelated === "boolean") {
        if (transcript.detectedIsCryptoRelated !== expect.expectedIsCryptoRelated) {
            failures.push(
                `expected isCryptoRelated=${expect.expectedIsCryptoRelated}, got=${String(transcript.detectedIsCryptoRelated)}`,
            );
        }
    }

    if (expect.expectedActions) {
        const expected = toLowerArray(expect.expectedActions);
        const missing = expected.filter((a) => !transcript.actionNamesSeen.has(a));
        if (missing.length > 0) {
            failures.push(
                `missing expected actions: ${missing.join(", ")} (seen: ${[...transcript.actionNamesSeen].join(", ") || "none"})`,
            );
        }
    }

    if (expect.expectActionExecution === true && !transcript.sawActionExecutionSignal) {
        failures.push("expected action execution signals in step events");
    }

    if (expect.stepsInclude) {
        const needles = Array.isArray(expect.stepsInclude)
            ? expect.stepsInclude
            : [expect.stepsInclude];
        const joined = transcript.stepNames.join("\n").toLowerCase();
        for (const needle of needles) {
            if (typeof needle === "string" && !joined.includes(needle.toLowerCase())) {
                failures.push(`step stream missing: ${needle}`);
            }
        }
    }

    if (expect.approvalRejected === true) {
        const joined = [
            ...transcript.stepNames,
            ...transcript.approvalPhasesSeen,
            transcript.lastAssistantText || "",
        ]
            .join("\n")
            .toLowerCase();
        const rejected =
            joined.includes("parameter_review_rejected") ||
            joined.includes("parameter_final_confirm_rejected") ||
            joined.includes("human_input_rejected") ||
            joined.includes("rejected");
        const submittedReject = (transcript.clientCalls || []).some(
            (c) =>
                (c.kind === "human_input_approval" || c.kind === "cex_approval") &&
                c.ok === true,
        );
        if (!rejected && !submittedReject) {
            failures.push(
                "expected approval rejection phase in step stream",
            );
        }
    }

    if (expect.humanInputResolved === true && !transcript.markers?.humanInputResolved) {
        const hasApprovalCall = (transcript.clientCalls || []).some(
            (c) =>
                c.kind === "human_input_approval" ||
                c.kind === "cex_approval",
        );
        if (!hasApprovalCall) {
            failures.push("expected human input interrupt to be resolved");
        }
    }

    if (expect.riskDecision && !expect.riskDecisionOptional) {
        const expected = String(expect.riskDecision).toLowerCase();
        const fromStream = transcript.riskDecisionFromStream;
        const fromAudit = expect._harvestedRiskDecision;
        const actual = fromAudit || fromStream;
        if (!actual) {
            failures.push(
                `expected riskDecision=${expected} but none captured (run audit harvest for post-run check)`,
            );
        } else if (actual !== expected && !actual.includes(expected)) {
            failures.push(
                `expected riskDecision=${expected}, got=${actual}`,
            );
        }
    }

    if (expect.noOpenOrders === true) {
        const hay = (transcript.lastAssistantText || "").toLowerCase();
        const openSignals = [
            "no open",
            "0 open",
            "no orders",
            "none open",
            "don't have any open",
            "do not have any open",
            "no active",
            "empty",
        ];
        const hasOpen =
            /\b\d+\s+open\b/.test(hay) &&
            !hay.includes("0 open") &&
            !hay.includes("no open");
        if (!openSignals.some((s) => hay.includes(s)) && hasOpen) {
            failures.push("teardown: open orders may still exist");
        } else if (
            hay.length > 0 &&
            !openSignals.some((s) => hay.includes(s)) &&
            hay.includes("order") &&
            !hay.includes("cancel")
        ) {
            failures.push(
                "teardown: could not confirm no open orders from assistant text",
            );
        }
    }

    if (expect.noOpenPositions === true) {
        const hay = (transcript.lastAssistantText || "").toLowerCase();
        const flatSignals = [
            "no position",
            "no open position",
            "no margin position",
            "don't have any position",
            "do not have any position",
            "none",
            "no active position",
            "flat",
        ];
        if (
            hay.length > 0 &&
            !flatSignals.some((s) => hay.includes(s)) &&
            (hay.includes("position") || hay.includes("borrowed"))
        ) {
            failures.push(
                "teardown: could not confirm no open positions from assistant text",
            );
        }
    }

    if (expect.noHarnessOpenOrders === true) {
        const ids = Array.isArray(expect.harnessClientOrderIds)
            ? expect.harnessClientOrderIds.filter(
                  (id) => typeof id === "string" && id.length > 0,
              )
            : [];
        if (ids.length > 0) {
            const hay = (transcript.lastAssistantText || "").toLowerCase();
            for (const id of ids) {
                const needle = id.toLowerCase();
                if (!hay.includes(needle)) {
                    continue;
                }
                const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const negationNearId = new RegExp(
                    `(none of|not open|no longer|aren't|are not|confirmed none|not found|absent)[^\\n]{0,240}${escaped}|${escaped}[^\\n]{0,240}(not open|cancelled|canceled|closed|cleared|absent)`,
                    "i",
                );
                if (negationNearId.test(hay)) {
                    continue;
                }
                const openNearId = new RegExp(
                    `${escaped}[^\\n]{0,120}\\b(new|active|pending|partially|still open|remains open|is open)\\b|\\b(still open|remains open|is open)\\b[^\\n]{0,120}${escaped}`,
                    "i",
                );
                if (openNearId.test(hay)) {
                    failures.push(
                        `teardown: harness order may still be open: ${id}`,
                    );
                }
            }
        }
    }

    if (expect.noHarnessOpenPositions === true) {
        const ids = Array.isArray(expect.harnessClientOrderIds)
            ? expect.harnessClientOrderIds.filter(
                  (id) => typeof id === "string" && id.length > 0,
              )
            : [];
        if (ids.length > 0) {
            const hay = (transcript.lastAssistantText || "").toLowerCase();
            for (const id of ids) {
                const needle = id.toLowerCase();
                if (!hay.includes(needle)) {
                    continue;
                }
                const openHints = ["open", "active", "borrowed", "position"];
                if (openHints.some((hint) => hay.includes(hint))) {
                    failures.push(
                        `teardown: harness margin position may still be open: ${id}`,
                    );
                }
            }
        }
    }

    if (expect.unsupportedVariant === true) {
        const hay = (transcript.lastAssistantText || "").toLowerCase();
        const steps = transcript.stepNames.join("\n").toLowerCase();
        const signals = [
            "unsupported",
            "not supported",
            "invalid",
            "preflight",
            "variant",
        ];
        const hit = signals.some(
            (s) => hay.includes(s) || steps.includes(s),
        );
        if (!hit && !transcript.errorMessage) {
            failures.push(
                "expected unsupported variant rejection signal in response or steps",
            );
        }
    }

    if (expect.custom && typeof expect.custom === "object") {
        for (const [name, enabled] of Object.entries(expect.custom)) {
            if (!enabled) {
                continue;
            }
            const fn = customAssertions.get(name);
            if (!fn) {
                failures.push(`unknown custom assertion: ${name}`);
                continue;
            }
            const msg = fn(ctx);
            if (msg) {
                failures.push(`custom.${name}: ${msg}`);
            }
        }
    }

    return failures;
}
