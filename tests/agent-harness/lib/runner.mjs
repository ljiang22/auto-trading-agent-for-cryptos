/**
 * Load and execute agent test suites.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { login, probeAgentAuth } from "./auth.mjs";
import {
    AgentClient,
    resolveAgentId,
    loadApprovalTemplates,
    buildMessagePayload,
} from "./client.mjs";
import { evaluateExpectations } from "./assertions.mjs";
import { normalizeBaseUrl } from "./http.mjs";
import { computePhaseLatencies } from "./transcript.mjs";
import { computeLatencyBreakdown } from "./latency.mjs";
import {
    ROOM_GROUP_LABELS,
    ROOM_GROUPS,
    buildHarnessOrderRecord,
} from "./tradingFixtures.mjs";
import { runTradingTeardown } from "./teardown.mjs";
import {
    awaitInterruptApprovalDebounce,
    getPendingPlanInterrupt,
    interruptDedupeKey,
    isHumanInputInterruptStep,
    mergeTranscripts,
    parseInterruptStep,
    planContinuationText,
    shouldSendPlanContinuation,
    waitForWorkflowIdle,
} from "./humanInputInterrupt.mjs";
import {
    applyMarketContextToCase,
    loadMarketPriceContext,
    suiteNeedsMarketPrices,
} from "./marketPriceContext.mjs";

const CLASSIFICATION_TYPES = new Set([
    "REGULAR_MESSAGE",
    "CEX_WORKFLOW_MESSAGE",
    "TASK_CHAIN_MESSAGE",
    "COMPREHENSIVE_ANALYSIS_MESSAGE",
]);

/**
 * @typedef {Object} RunSuiteOptions
 * @property {string} authBaseUrl
 * @property {string} agentBaseUrl
 * @property {string} email
 * @property {string} password
 * @property {string} [agentId]
 * @property {string} [agentName]
 * @property {string} [suitePath]
 * @property {object} [suite] - inline suite object
 * @property {string} [outDir]
 * @property {string} [filterTags]
 * @property {string} [filterIds]
 * @property {number} [concurrency]
 * @property {boolean} [dryRun]
 * @property {boolean} [skipAuthProbe]
 * @property {boolean} [failFastAuthProbe]
 * @property {boolean} [runTeardown]
 * @property {string} [suitePath]
 * @property {boolean} [skipMarketFetch]
 * @property {number} [marketMidOverride]
 */

/**
 * @param {import("./transcript.mjs").TranscriptState | null | undefined} transcript
 */
function transcriptSawHumanInputInterrupt(transcript) {
    if (!transcript) {
        return false;
    }
    if (transcript.markers?.humanInputResolved) {
        return true;
    }
    return (transcript.events || []).some((entry) => {
        if (entry?.event?.type !== "step") {
            return false;
        }
        const step = entry.event.step;
        if (!isHumanInputInterruptStep(step)) {
            return false;
        }
        const parsed = parseInterruptStep(step);
        return parsed != null && !parsed.plan_context;
    });
}

export function assertSafeConcurrency(roomStrategy, concurrency) {
    if (concurrency > 1 && roomStrategy !== "perCase") {
        throw new Error(
            `concurrency=${concurrency} is unsafe with roomStrategy=${roomStrategy}; use perCase or concurrency=1`,
        );
    }
}

/**
 * @param {string} filePath
 */
export async function loadSuite(filePath) {
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.questions) && !Array.isArray(data.cases)) {
        return legacyQuestionsToSuite(data);
    }
    if (!Array.isArray(data.cases)) {
        throw new Error("suite must include cases[] or legacy questions[]");
    }
    for (const c of data.cases) {
        if (c.expectedClassification) {
            const cls = String(c.expectedClassification).toUpperCase();
            if (!CLASSIFICATION_TYPES.has(cls)) {
                throw new Error(
                    `case ${c.id}: invalid expectedClassification ${c.expectedClassification}`,
                );
            }
        }
    }
    return data;
}

/**
 * Map legacy questions JSON to harness suite shape.
 * @param {object} questionsFile
 */
export function legacyQuestionsToSuite(questionsFile) {
    const questions = questionsFile.questions || [];
    return {
        name: questionsFile.test_suite_name || "legacy-questions",
        defaults: {
            roomStrategy: "perLevel",
            hooks: ["cexAutoApprove", "taskChainAutoApprove"],
        },
        cases: questions.map((q) => ({
            id: String(q.id ?? q.question?.slice(0, 32)),
            level: q.level,
            tags: q.category ? [q.category] : [],
            approvalTemplateKey: q.approvalTemplateKey,
            message: { text: q.question },
            expect: {
                ...(q.expectedClassification
                    ? { expectedClassification: q.expectedClassification }
                    : {}),
                ...(typeof q.expectedIsCryptoRelated === "boolean"
                    ? { expectedIsCryptoRelated: q.expectedIsCryptoRelated }
                    : {}),
                ...(q.expectedActions
                    ? { expectedActions: q.expectedActions }
                    : {}),
                ...(q.expectActionExecution
                    ? { expectActionExecution: q.expectActionExecution }
                    : {}),
            },
        })),
    };
}

function filterCases(cases, filterTags, filterIds) {
    let out = cases;
    if (filterIds) {
        const ids = new Set(
            filterIds.split(",").map((s) => s.trim()).filter(Boolean),
        );
        out = out.filter((c) => ids.has(String(c.id)));
    }
    if (filterTags) {
        const tags = new Set(
            filterTags.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
        );
        out = out.filter((c) => {
            const caseTags = (c.tags || []).map((t) => String(t).toLowerCase());
            return caseTags.some((t) => tags.has(t));
        });
    }
    return out;
}

function mergeCaseDefaults(caseDef, defaults) {
    const hooks = [
        ...(defaults?.hooks || []),
        ...(caseDef.hooks || []),
    ];
    const uniqueHooks = [...new Set(hooks)];
    return {
        ...caseDef,
        hooks: uniqueHooks.length > 0 ? uniqueHooks : undefined,
        approvalTemplateKey:
            caseDef.approvalTemplateKey ?? defaults?.approvalTemplateKey,
    };
}

async function writeJsonl(filePath, lines) {
    const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await fs.writeFile(filePath, content, "utf8");
}

/**
 * @param {RunSuiteOptions} options
 * @returns {Promise<{ passed: number, failed: number, report: object }>}
 */
export async function runSuite(options) {
    const authBaseUrl = normalizeBaseUrl(options.authBaseUrl);
    const agentBaseUrl = normalizeBaseUrl(options.agentBaseUrl);

    const suite =
        options.suite ||
        (options.suitePath ? await loadSuite(options.suitePath) : null);
    if (!suite) {
        throw new Error("runSuite requires suite or suitePath");
    }

    const defaults = suite.defaults || {};
    let cases = filterCases(
        suite.cases,
        options.filterTags,
        options.filterIds,
    );
    if (cases.length === 0) {
        throw new Error("no cases to run after filters");
    }

    const outDir =
        options.outDir ||
        path.join(
            process.cwd(),
            "tests/agent-harness/runs",
            new Date().toISOString().replace(/[:.]/g, "-"),
        );

    if (options.dryRun) {
        console.log(`[dry-run] suite=${suite.name} cases=${cases.length}`);
        return { passed: 0, failed: 0, report: { dryRun: true, cases: cases.length } };
    }

    await fs.mkdir(outDir, { recursive: true });
    await fs.mkdir(path.join(outDir, "cases"), { recursive: true });

    const session = await login({
        authBaseUrl,
        email: options.email,
        password: options.password,
    });

    if (!options.skipAuthProbe) {
        try {
            const me = await probeAgentAuth(agentBaseUrl, session);
            console.log(
                `[auth] probe ok email=${me?.email ?? session.email} type=${me?.success !== false ? "authenticated" : "unknown"}`,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (options.failFastAuthProbe) {
                throw new Error(`Agent auth probe failed: ${message}`);
            }
            console.warn(`[auth] agent probe failed (continuing): ${message}`);
        }
    }

    const agentId = await resolveAgentId(
        agentBaseUrl,
        options.agentId || defaults.agentId,
        options.agentName || defaults.agentName,
        session,
    );

    const client = new AgentClient({
        agentBaseUrl,
        session,
        agentId,
    });

    const approvalTemplates = await loadApprovalTemplates(
        defaults.approvalTemplates || options.approvalTemplatesPath,
    );

    const roomStrategy = defaults.roomStrategy || "perCase";
    const roomByLevel = new Map();
    const roomByGroup = new Map();
    let sharedRoomId = defaults.reuseRoomId || null;
    const runStartedAt = Date.now();

    if (roomStrategy === "perRoomGroup") {
        for (const group of ROOM_GROUPS) {
            const label = ROOM_GROUP_LABELS[group] || `Trading QA — ${group}`;
            const roomId = await client.createRoom(label);
            roomByGroup.set(group, roomId);
            console.log(`[room] ${group} -> ${roomId}`);
        }
    } else if (roomStrategy === "perLevel") {
        const levels = [
            ...new Set(
                cases
                    .map((c) => c.level)
                    .filter((l) => l != null && Number.isFinite(Number(l))),
            ),
        ].sort((a, b) => Number(a) - Number(b));
        for (const level of levels) {
            const roomId = await client.createRoom(`Suite ${suite.name} L${level}`);
            roomByLevel.set(level, roomId);
        }
    } else if (roomStrategy === "reuse" && !sharedRoomId) {
        sharedRoomId = await client.createRoom(`Suite ${suite.name}`);
    }

    console.log(`Agent: ${agentId}`);
    console.log(`Suite: ${suite.name} (${cases.length} cases)`);
    console.log(`Output: ${outDir}`);

    /** @type {Awaited<ReturnType<typeof loadMarketPriceContext>> | null} */
    let marketCtx = null;
    if (suiteNeedsMarketPrices(cases)) {
        marketCtx = await loadMarketPriceContext({
            skipFetch: options.skipMarketFetch === true,
            midOverride: options.marketMidOverride,
        });
        const ladder = marketCtx.priceLadder;
        console.log(
            `[market] ${marketCtx.productId} mid=${marketCtx.mid} source=${marketCtx.source} ` +
                `buyLimit=${ladder.buyLimit} sellLimit=${ladder.sellLimit} ` +
                `buyStop=${ladder.buyStop} buyStopLimit=${ladder.buyStopLimit} sellActivation=${ladder.sellActivation}`,
        );
    }

    const caseResults = [];
    const harnessOrders = [];
    const concurrency = Math.max(1, options.concurrency ?? 1);
    assertSafeConcurrency(roomStrategy, concurrency);

    async function runOneCase(caseDef) {
        const merged = mergeCaseDefaults(caseDef, defaults);
        const caseId = String(merged.id ?? "case");
        const started = Date.now();

        console.log(`\n[Case ${caseId}] ${merged.tags?.join(", ") || ""}`);

        let roomId;
        if (roomStrategy === "perRoomGroup") {
            const group = merged.roomGroup;
            if (!group || !roomByGroup.has(group)) {
                throw new Error(
                    `case ${caseId}: roomGroup required for perRoomGroup (read_only|spot|margin)`,
                );
            }
            roomId = roomByGroup.get(group);
        } else if (roomStrategy === "perLevel" && merged.level != null) {
            roomId = roomByLevel.get(merged.level);
            if (!roomId) {
                roomId = await client.createRoom(`Suite ${suite.name} L${merged.level}`);
                roomByLevel.set(merged.level, roomId);
            }
        } else if (roomStrategy === "reuse") {
            roomId = sharedRoomId;
        } else {
            roomId = await client.createRoom(`Case ${caseId}`);
        }

        if (merged.request) {
            const req = merged.request;
            try {
                await client.request({
                    method: req.method || "GET",
                    path: req.path,
                    body: req.body,
                });
            } catch (err) {
                const failures = [
                    `request failed: ${err instanceof Error ? err.message : String(err)}`,
                ];
                return finishCase(caseId, merged, null, failures, started, outDir, roomId);
            }
        }

        const priced =
            marketCtx != null
                ? applyMarketContextToCase(merged, marketCtx)
                : merged;
        const msgPreview =
            priced.message?.text ||
            priced.compose?.action ||
            "(no text)";
        console.log(`[Question] ${String(msgPreview).slice(0, 200)}`);
        const payload = buildMessagePayload(priced);
        const hookNames = priced.hooks || [];

        let transcript;
        try {
            transcript = await client.sendMessage(roomId, payload, {
                hooks: hookNames,
                approvalTemplates,
                caseDef: priced,
                timeoutMs: priced.expect?.maxDurationMs,
            });

            const maxPlanTurns = 5;
            let planTurns = 0;
            while (
                planTurns < maxPlanTurns &&
                shouldSendPlanContinuation(transcript, priced, hookNames)
            ) {
                const planInterrupt = getPendingPlanInterrupt(transcript);
                const continuationText = planContinuationText(priced);
                const remainingMs = Math.max(
                    5000,
                    (priced.expect?.maxDurationMs ?? 300_000) - (Date.now() - started),
                );
                console.log(
                    `[hooks] plan continuation: "${continuationText}" (turn ${planTurns + 1})`,
                );
                const continuation = await client.sendContinuation(
                    roomId,
                    continuationText,
                    {
                        hooks: hookNames,
                        approvalTemplates,
                        caseDef: priced,
                        timeoutMs: remainingMs,
                    },
                );
                if (planInterrupt) {
                    transcript.markers.planContinuationSentFor = interruptDedupeKey(
                        planInterrupt.approvalId,
                        planInterrupt.confirmationLevel,
                    );
                }
                mergeTranscripts(transcript, continuation);
                planTurns++;
            }
        } catch (err) {
            const failures = [
                `sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
            ];
            return finishCase(caseId, merged, null, failures, started, outDir, roomId);
        }

        const sawHumanInput = transcriptSawHumanInputInterrupt(transcript);
        if (sawHumanInput) {
            await awaitInterruptApprovalDebounce();
        }
        if (roomId && (roomStrategy === "perRoomGroup" || sawHumanInput)) {
            const remainingMs = Math.max(
                5000,
                (priced.expect?.maxDurationMs ?? 300_000) - (Date.now() - started),
            );
            const idleTimeout = sawHumanInput
                ? remainingMs
                : Math.min(remainingMs, 15_000);
            const idle = await waitForWorkflowIdle(client, roomId, {
                timeoutMs: idleTimeout,
            });
            if (!idle && sawHumanInput) {
                console.warn(
                    `[runner] workflow still active after case ${caseId} (timeout ${idleTimeout}ms)`,
                );
            }
        }

        if (transcript.errorMessage) {
            console.log(`Error: ${transcript.errorMessage}`);
        } else if (transcript.lastAssistantText) {
            console.log(
                `Answer: ${transcript.lastAssistantText.slice(0, 500)}${transcript.lastAssistantText.length > 500 ? "…" : ""}`,
            );
        } else {
            console.log("Answer: (no assistant response captured)");
        }

        const failures = evaluateExpectations({
            transcript,
            expect: priced.expect || {},
            caseDef: priced,
        });

        return finishCase(
            caseId,
            priced,
            transcript,
            failures,
            started,
            outDir,
            roomId,
            marketCtx,
        );
    }

    async function finishCase(
        caseId,
        merged,
        transcript,
        failures,
        started,
        outDir,
        roomId,
        marketContext = null,
    ) {
        const durationMs = Date.now() - started;
        const passed = failures.length === 0;
        const phaseLatencies = transcript ? computePhaseLatencies(transcript) : null;
        const latencyBreakdown = transcript ? computeLatencyBreakdown(transcript) : null;
        const safeName = sanitizeFileName(caseId);

        const harnessOrder = buildHarnessOrderRecord(merged, transcript);
        if (harnessOrder) {
            harnessOrders.push(harnessOrder);
        }

        if (transcript) {
            try {
                await writeJsonl(
                    path.join(outDir, "cases", `${safeName}.jsonl`),
                    transcript.events,
                );
                const summary = {
                    id: caseId,
                    roomGroup: merged.roomGroup ?? null,
                    roomId: roomId ?? null,
                    requestId: transcript.requestId ?? transcript.cexRequestId ?? null,
                    cexRequestId: transcript.cexRequestId ?? null,
                    startedAtMs: started,
                    endedAtMs: Date.now(),
                    durationMs,
                    phaseLatencies,
                    latencyBreakdown,
                    failures,
                    passed,
                    lastAssistantText: transcript.lastAssistantText,
                    errorMessage: transcript.errorMessage,
                    detectedClassification: transcript.detectedClassification,
                    riskDecisionFromStream: transcript.riskDecisionFromStream,
                    approvalPhasesSeen: transcript.approvalPhasesSeen,
                    actionNamesSeen: [...transcript.actionNamesSeen],
                    tags: merged.tags ?? [],
                    harnessOrder,
                    ...(marketContext
                        ? {
                              marketMid: marketContext.mid,
                              marketSource: marketContext.source,
                          }
                        : {}),
                };
                await fs.writeFile(
                    path.join(outDir, "cases", `${safeName}.summary.json`),
                    JSON.stringify(summary, null, 2),
                    "utf8",
                );
            } catch (err) {
                console.warn(`Failed to write case artifacts: ${err.message}`);
            }
        }

        if (passed) {
            console.log("[Result] PASS");
        } else {
            console.log("[Result] FAIL");
            for (const f of failures) {
                console.log(`[Expectation] ${f}`);
            }
        }

        return {
            id: caseId,
            passed,
            durationMs,
            failures,
            roomGroup: merged.roomGroup ?? null,
            roomId: roomId ?? null,
            requestId: transcript?.requestId ?? transcript?.cexRequestId ?? null,
            lastAssistantText: transcript?.lastAssistantText ?? null,
            errorMessage: transcript?.errorMessage ?? null,
            detectedClassification: transcript?.detectedClassification ?? null,
            riskDecisionFromStream: transcript?.riskDecisionFromStream ?? null,
            actionNamesSeen: transcript
                ? [...transcript.actionNamesSeen]
                : [],
            phaseLatencies,
            latencyBreakdown,
            harnessOrder,
        };
    }

    const roomIds =
        roomStrategy === "perRoomGroup"
            ? Object.fromEntries(roomByGroup.entries())
            : undefined;

    let teardownResult = null;
    const shouldTeardown =
        options.runTeardown !== false &&
        defaults.runTeardown !== false &&
        roomIds &&
        typeof roomIds === "object";

    try {
        if (concurrency === 1) {
            for (const caseDef of cases) {
                try {
                    caseResults.push(await runOneCase(caseDef));
                } catch (err) {
                    const caseId = String(caseDef.id ?? "case");
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[Case ${caseId}] uncaught error: ${message}`);
                    caseResults.push({
                        id: caseId,
                        passed: false,
                        durationMs: 0,
                        failures: [`uncaught error: ${message}`],
                        roomGroup: caseDef.roomGroup ?? null,
                        roomId: null,
                        requestId: null,
                        lastAssistantText: null,
                        errorMessage: message,
                        detectedClassification: null,
                        riskDecisionFromStream: null,
                        actionNamesSeen: [],
                        phaseLatencies: null,
                    });
                }
            }
        } else {
            const chunks = [];
            for (let i = 0; i < cases.length; i += concurrency) {
                chunks.push(cases.slice(i, i + concurrency));
            }
            for (const chunk of chunks) {
                const batch = await Promise.all(
                    chunk.map(async (caseDef) => {
                        try {
                            return await runOneCase(caseDef);
                        } catch (err) {
                            const caseId = String(caseDef.id ?? "case");
                            const message =
                                err instanceof Error ? err.message : String(err);
                            console.error(`[Case ${caseId}] uncaught error: ${message}`);
                            return {
                                id: caseId,
                                passed: false,
                                durationMs: 0,
                                failures: [`uncaught error: ${message}`],
                                roomGroup: caseDef.roomGroup ?? null,
                                roomId: null,
                                requestId: null,
                                lastAssistantText: null,
                                errorMessage: message,
                                detectedClassification: null,
                                riskDecisionFromStream: null,
                                actionNamesSeen: [],
                                phaseLatencies: null,
                            };
                        }
                    }),
                );
                caseResults.push(...batch);
            }
        }
    } finally {
        if (shouldTeardown) {
            console.log("\n=== Teardown ===");
            teardownResult = await runTradingTeardown({
                client,
                roomIds,
                approvalTemplates,
                outDir,
                harnessOrders,
            });
        }
    }

    const passed = caseResults.filter((r) => r.passed).length;
    const failed = caseResults.length - passed;

    const runEndedAt = Date.now();

    const report = {
        suite: suite.name,
        suitePath: options.suitePath ?? null,
        agentId,
        agentBaseUrl,
        authBaseUrl,
        email: session.email,
        runStartedAt: new Date(runStartedAt).toISOString(),
        runEndedAt: new Date(runEndedAt).toISOString(),
        runStartedAtMs: runStartedAt,
        runEndedAtMs: runEndedAt,
        startedAt: new Date(runStartedAt).toISOString(),
        endedAt: new Date(runEndedAt).toISOString(),
        roomStrategy,
        roomIds,
        outDir,
        passed,
        failed,
        total: caseResults.length,
        cases: caseResults,
        harnessOrders,
        teardown: teardownResult,
    };

    await fs.writeFile(
        path.join(outDir, "report.json"),
        JSON.stringify(report, null, 2),
        "utf8",
    );

    console.log(`\n=== ${passed}/${caseResults.length} passed ===`);
    if (failed > 0) {
        process.exitCode = 1;
    }
    if (teardownResult && !teardownResult.ok) {
        process.exitCode = 1;
    }

    return { passed, failed, report, outDir, teardown: teardownResult };
}

function sanitizeFileName(id) {
    return String(id).replace(/[^a-zA-Z0-9._-]+/g, "_");
}
