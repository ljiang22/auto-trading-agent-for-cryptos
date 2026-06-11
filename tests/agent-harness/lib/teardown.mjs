/**
 * Post-suite trading teardown — cancel harness-placed orders and verify scoped flat state.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
    buildCancelOrderCompose,
    buildGetOrdersCompose,
    buildGetOrdersNlText,
    buildTeardownVerifyOrdersNlText,
    buildTeardownVerifyPositionsNlText,
} from "./tradingFixtures.mjs";
import { buildMessagePayload } from "./client.mjs";
import { evaluateExpectations } from "./assertions.mjs";
import { extractOrderRefsFromTranscript } from "./transcript.mjs";

/**
 * @param {import("./client.mjs").AgentClient} client
 * @param {string} roomId
 * @param {object} payload
 * @param {object} options
 */
async function sendTeardownMessage(client, roomId, payload, options) {
    return client.sendMessage(roomId, payload, {
        hooks: ["cexAutoApprove"],
        ...options,
    });
}

/**
 * @param {Array<{ clientOrderId: string, venueOrderIds?: string[] }>} harnessOrders
 * @param {import("./transcript.mjs").TranscriptState} transcript
 */
function mergeVenueIdsFromTranscript(harnessOrders, transcript) {
    for (const order of harnessOrders) {
        const extra = extractOrderRefsFromTranscript(transcript, order.clientOrderId);
        order.venueOrderIds = [
            ...new Set([...(order.venueOrderIds || []), ...extra]),
        ];
    }
}

/**
 * @param {Array<{ marginType?: string | null, roomGroup?: string | null, venueOrderIds?: string[] }>} harnessOrders
 */
function groupHarnessOrdersForCancel(harnessOrders) {
    const spot = [];
    const cross = [];
    const isolated = [];
    for (const order of harnessOrders) {
        const marginType = order.marginType
            ? String(order.marginType).toUpperCase()
            : null;
        if (marginType === "CROSS") {
            cross.push(order);
        } else if (marginType === "ISOLATED") {
            isolated.push(order);
        } else {
            spot.push(order);
        }
    }
    return { spot, cross, isolated };
}

function uniqueVenueIds(orders) {
    return [
        ...new Set(
            orders.flatMap((order) => order.venueOrderIds || []).filter(Boolean),
        ),
    ];
}

/**
 * @param {{ client: import("./client.mjs").AgentClient, roomIds: Record<string, string>, approvalTemplates: object | null, outDir?: string, harnessOrders?: object[] }} ctx
 */
export async function runTradingTeardown(ctx) {
    const steps = [];
    const failures = [];
    const spotRoom = ctx.roomIds?.spot || ctx.roomIds?.read_only;
    const marginRoom = ctx.roomIds?.margin ?? null;
    const harnessOrders = (ctx.harnessOrders || []).map((order) => ({
        ...order,
        venueOrderIds: [...(order.venueOrderIds || [])],
    }));

    if (!spotRoom) {
        return {
            ok: false,
            steps,
            failures: ["teardown: no spot/read_only roomId available"],
            harnessOrders,
        };
    }

    async function runStep(name, roomId, caseDef) {
        const started = Date.now();
        console.log(`\n[Teardown] ${name}`);
        try {
            const payload = buildMessagePayload(caseDef);
            const transcript = await sendTeardownMessage(
                ctx.client,
                roomId,
                payload,
                {
                    approvalTemplates: ctx.approvalTemplates,
                    caseDef,
                },
            );
            const stepFailures = evaluateExpectations({
                transcript,
                expect: caseDef.expect || {},
                caseDef,
            });
            const durationMs = Date.now() - started;
            const passed = stepFailures.length === 0;
            steps.push({
                name,
                roomId,
                passed,
                durationMs,
                failures: stepFailures,
                lastAssistantText: transcript.lastAssistantText?.slice(0, 500),
            });
            if (!passed) {
                failures.push(...stepFailures.map((f) => `${name}: ${f}`));
            }
            return transcript;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            failures.push(`${name}: ${msg}`);
            steps.push({ name, roomId, passed: false, error: msg });
            return null;
        }
    }

    if (harnessOrders.length === 0) {
        console.log("[Teardown] no harness create_order cases in this run — skip cancel/verify");
        const result = {
            ok: failures.length === 0,
            passed: failures.length === 0,
            failures,
            steps,
            harnessOrders,
            skipped: true,
            finishedAt: new Date().toISOString(),
        };
        if (ctx.outDir) {
            await fs.writeFile(
                path.join(ctx.outDir, "teardown.json"),
                JSON.stringify(result, null, 2),
                "utf8",
            );
        }
        console.log("[Teardown] PASS — nothing to clean up");
        return result;
    }

    const needsResolve = harnessOrders.some(
        (order) => (order.venueOrderIds || []).length === 0,
    );
    if (needsResolve) {
        const spotResolve = harnessOrders.filter((o) => !o.marginType);
        if (spotResolve.length > 0) {
            const transcript = await runStep(
                "resolve_harness_orders_spot",
                spotRoom,
                {
                    id: "teardown-resolve-spot",
                    message: {
                        text: buildGetOrdersNlText(),
                    },
                    compose: buildGetOrdersCompose(),
                    expect: { maxDurationMs: 120_000 },
                },
            );
            if (transcript) {
                mergeVenueIdsFromTranscript(spotResolve, transcript);
            }
        }
        if (marginRoom) {
            for (const marginType of ["CROSS", "ISOLATED"]) {
                const marginResolve = harnessOrders.filter(
                    (o) =>
                        String(o.marginType || "").toUpperCase() === marginType &&
                        (o.venueOrderIds || []).length === 0,
                );
                if (marginResolve.length === 0) {
                    continue;
                }
                const transcript = await runStep(
                    `resolve_harness_orders_margin_${marginType.toLowerCase()}`,
                    marginRoom,
                    {
                        id: `teardown-resolve-margin-${marginType.toLowerCase()}`,
                        message: {
                            text: buildGetOrdersNlText({ marginType }),
                        },
                        compose: buildGetOrdersCompose({ marginType }),
                        expect: { maxDurationMs: 120_000 },
                    },
                );
                if (transcript) {
                    mergeVenueIdsFromTranscript(marginResolve, transcript);
                }
            }
        }
    }

    const { spot, cross, isolated } = groupHarnessOrdersForCancel(harnessOrders);
    const spotIds = uniqueVenueIds(spot);
    const crossIds = uniqueVenueIds(cross);
    const isolatedIds = uniqueVenueIds(isolated);

    if (spotIds.length > 0) {
        const cancelSpot = buildCancelOrderCompose({
            caseId: "teardown-cancel-spot",
            allOpen: false,
            orderIds: spotIds,
        });
        await runStep("cancel_harness_spot", spotRoom, {
            id: "teardown-cancel-spot",
            message: { text: cancelSpot.previewText },
            compose: cancelSpot,
            expect: {
                expectedActions: ["cancel_order"],
                expectActionExecution: true,
                maxDurationMs: 120_000,
            },
        });
    } else if (spot.length > 0) {
        console.log(
            "[Teardown] no open spot venue IDs for harness orders (likely filled market orders)",
        );
        steps.push({
            name: "cancel_harness_spot",
            passed: true,
            skipped: true,
            reason: "no open spot venue order IDs",
        });
    }

    if (marginRoom && crossIds.length > 0) {
        const cancelCross = buildCancelOrderCompose({
            caseId: "teardown-cancel-margin-cross",
            allOpen: false,
            orderIds: crossIds,
            marginType: "CROSS",
        });
        await runStep("cancel_harness_margin_cross", marginRoom, {
            id: "teardown-cancel-margin-cross",
            message: { text: cancelCross.previewText },
            compose: cancelCross,
            expect: {
                expectedActions: ["cancel_order"],
                expectActionExecution: true,
                maxDurationMs: 120_000,
            },
        });
    } else if (cross.length > 0) {
        console.log("[Teardown] no open CROSS margin venue IDs for harness orders");
        steps.push({
            name: "cancel_harness_margin_cross",
            passed: true,
            skipped: true,
            reason: "no open CROSS venue order IDs",
        });
    }

    if (marginRoom && isolatedIds.length > 0) {
        const cancelIsolated = buildCancelOrderCompose({
            caseId: "teardown-cancel-margin-isolated",
            allOpen: false,
            orderIds: isolatedIds,
            marginType: "ISOLATED",
        });
        await runStep("cancel_harness_margin_isolated", marginRoom, {
            id: "teardown-cancel-margin-isolated",
            message: { text: cancelIsolated.previewText },
            compose: cancelIsolated,
            expect: {
                expectedActions: ["cancel_order"],
                expectActionExecution: true,
                maxDurationMs: 120_000,
            },
        });
    } else if (isolated.length > 0) {
        console.log("[Teardown] no open ISOLATED margin venue IDs for harness orders");
        steps.push({
            name: "cancel_harness_margin_isolated",
            passed: true,
            skipped: true,
            reason: "no open ISOLATED venue order IDs",
        });
    }

    const harnessClientOrderIds = harnessOrders.map((o) => o.clientOrderId);
    const harnessSpotClientIds = spot.map((o) => o.clientOrderId);
    const harnessMarginClientIds = [...cross, ...isolated].map((o) => o.clientOrderId);

    if (harnessSpotClientIds.length > 0) {
        await runStep("verify_harness_orders_spot", spotRoom, {
            id: "teardown-verify-harness-orders-spot",
            message: {
                text: buildTeardownVerifyOrdersNlText(harnessSpotClientIds),
            },
            expect: {
                noHarnessOpenOrders: true,
                harnessClientOrderIds: harnessSpotClientIds,
                maxDurationMs: 120_000,
            },
        });
    }

    if (marginRoom && harnessMarginClientIds.length > 0) {
        await runStep("verify_harness_positions_margin", marginRoom, {
            id: "teardown-verify-harness-positions-margin",
            message: {
                text: buildTeardownVerifyPositionsNlText(harnessMarginClientIds),
            },
            expect: {
                noHarnessOpenPositions: true,
                harnessClientOrderIds: harnessMarginClientIds,
                maxDurationMs: 120_000,
            },
        });
    }

    const result = {
        ok: failures.length === 0,
        passed: failures.length === 0,
        failures,
        steps,
        harnessOrders,
        harnessClientOrderIds,
        venueOrderIds: {
            spot: spotIds,
            cross: crossIds,
            isolated: isolatedIds,
        },
        finishedAt: new Date().toISOString(),
    };

    if (ctx.outDir) {
        await fs.writeFile(
            path.join(ctx.outDir, "teardown.json"),
            JSON.stringify(result, null, 2),
            "utf8",
        );
    }

    if (result.ok) {
        console.log("[Teardown] PASS — harness orders cleaned up");
    } else {
        console.log("[Teardown] FAIL");
        for (const f of failures) {
            console.log(`[Teardown] ${f}`);
        }
    }

    return result;
}
