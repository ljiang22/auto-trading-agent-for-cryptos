import { describe, expect, it, vi, beforeEach } from "vitest";
import {
    applySupervisionModifications,
    type SupervisorModifications,
} from "../src/tasks/taskChainSupervisor.ts";
import type { TaskChain, TaskNode, UUID } from "../src/core/types.ts";
import { elizaLogger } from "../src/utils/logger.ts";

/**
 * Covers PR #158 fix: supervisor must resolve LLM-emitted task **names** (not
 * UUIDs) in add_tasks dependencies, add_branch dependencies + merge_point, and
 * change_dependencies — so the "[TaskChainSupervisor] Invalid dependencies"
 * noise stops firing on legitimate planner output.
 */

function makeTask(overrides: Partial<TaskNode> & { id: UUID; name: string }): TaskNode {
    return {
        id: overrides.id,
        name: overrides.name,
        description: overrides.description ?? "",
        type: "action",
        status: overrides.status ?? "completed",
        dependencies: overrides.dependencies ?? [],
        inputs: [],
        outputs: [],
        config: { actions: [] },
        result: {
            data: {},
            metadata: { startTime: 0, endTime: 0, duration: 0 },
        },
    };
}

function makeChain(tasks: TaskNode[]): TaskChain {
    return {
        id: "00000000-0000-0000-0000-0000000000aa" as UUID,
        name: "test-chain",
        description: "",
        tasks,
        originalRequest: "",
        metadata: { createdAt: 0, status: "running" },
        config: { maxParallel: 4, timeout: 60000, continueOnFailure: false },
    };
}

const ID_FETCH = "11111111-1111-1111-1111-111111111111" as UUID;
const ID_ANALYZE = "22222222-2222-2222-2222-222222222222" as UUID;
const ID_REPORT = "33333333-3333-3333-3333-333333333333" as UUID;

describe("applySupervisionModifications — dependency-ref resolution (PR #158)", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    describe("add_tasks", () => {
        it("resolves a dependency referenced by task name (the regression this PR fixes)", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
            ]);

            // LLM emits the **name** "Fetch news" in dependencies, not the UUID.
            // Pre-fix: cast as UUID[] → validation step failed → task skipped with
            // "Invalid dependencies" WARN. Post-fix: resolved to ID_FETCH.
            const mods: SupervisorModifications = {
                decision: true,
                add_tasks: [
                    {
                        name: "Summarize",
                        description: "summarize",
                        dependencies: ["Fetch news"],
                    },
                ],
            };

            const result = await applySupervisionModifications(chain, mods);

            expect(result).not.toBeNull();
            const added = result!.chain.tasks.find((t) => t.name === "Summarize");
            expect(added).toBeDefined();
            expect(added!.dependencies).toEqual([ID_FETCH]);
        });

        it("matches names case-insensitively", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch News", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_tasks: [
                    {
                        name: "Summarize",
                        description: "",
                        dependencies: ["fetch news"], // lowercased on purpose
                    },
                ],
            });

            const added = result!.chain.tasks.find((t) => t.name === "Summarize");
            expect(added!.dependencies).toEqual([ID_FETCH]);
        });

        it("accepts an exact UUID dependency (backward compatible)", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_tasks: [
                    {
                        name: "Summarize",
                        description: "",
                        dependencies: [ID_FETCH],
                    },
                ],
            });

            const added = result!.chain.tasks.find((t) => t.name === "Summarize");
            expect(added!.dependencies).toEqual([ID_FETCH]);
        });

        it("dedupes when the same task is referenced by both ID and name", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_tasks: [
                    {
                        name: "Summarize",
                        description: "",
                        dependencies: [ID_FETCH, "Fetch news", "fetch news"],
                    },
                ],
            });

            const added = result!.chain.tasks.find((t) => t.name === "Summarize");
            // seen-set must collapse the three refs to a single DAG edge
            expect(added!.dependencies).toEqual([ID_FETCH]);
        });

        it("skips the task and warns when a dependency cannot be resolved", async () => {
            const warnSpy = vi.spyOn(elizaLogger, "warn").mockImplementation(() => {});
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_tasks: [
                    {
                        name: "Summarize",
                        description: "",
                        dependencies: ["Nonexistent task"],
                    },
                ],
            });

            // Task with bad deps is skipped → chain unchanged → result is null
            // because no modifications were actually applied.
            expect(result).toBeNull();
            const skipped = warnSpy.mock.calls
                .map((args) => String(args[0]))
                .some((msg) => /Skipping task .* invalid dependencies: Nonexistent task/.test(msg));
            expect(skipped).toBe(true);
        });
    });

    describe("change_dependencies", () => {
        it("resolves both task_id and new_dependencies by name", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
                makeTask({ id: ID_ANALYZE, name: "Analyze", status: "pending", dependencies: [] }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                change_dependencies: [
                    {
                        task_id: "Analyze", // by name
                        new_dependencies: ["Fetch news"], // by name
                    },
                ],
            });

            expect(result).not.toBeNull();
            const analyze = result!.chain.tasks.find((t) => t.id === ID_ANALYZE)!;
            expect(analyze.dependencies).toEqual([ID_FETCH]);
        });

        it("refuses to change a non-pending task's deps even when resolved by name", async () => {
            const warnSpy = vi.spyOn(elizaLogger, "warn").mockImplementation(() => {});
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
                makeTask({ id: ID_ANALYZE, name: "Analyze", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                change_dependencies: [
                    { task_id: "Analyze", new_dependencies: ["Fetch news"] },
                ],
            });

            expect(result).toBeNull();
            const refused = warnSpy.mock.calls
                .map((args) => String(args[0]))
                .some((m) => /Cannot change dependencies for non-pending task/.test(m));
            expect(refused).toBe(true);
        });
    });

    describe("add_branch", () => {
        it("resolves merge_point by name", async () => {
            const chain = makeChain([
                makeTask({ id: ID_REPORT, name: "Final report", status: "pending" }),
            ]);

            const mods: SupervisorModifications = {
                decision: true,
                add_branch: {
                    enabled: true,
                    tasks: [
                        { name: "Branch A", description: "", dependencies: [] },
                        { name: "Branch B", description: "", dependencies: [] },
                    ],
                    merge_point: "Final report", // by name
                },
            };

            const result = await applySupervisionModifications(chain, mods);

            expect(result).not.toBeNull();
            const merge = result!.chain.tasks.find((t) => t.id === ID_REPORT)!;
            // merge target must depend on both newly-added branch tasks
            const branchA = result!.chain.tasks.find((t) => t.name === "Branch A")!;
            const branchB = result!.chain.tasks.find((t) => t.name === "Branch B")!;
            expect(new Set(merge.dependencies)).toEqual(new Set([branchA.id, branchB.id]));
        });

        it("resolves branch-task cross-deps via branch-task-N-id markers", async () => {
            const chain = makeChain([
                makeTask({ id: ID_FETCH, name: "Fetch news", status: "completed" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_branch: {
                    enabled: true,
                    tasks: [
                        { name: "Branch A", description: "", dependencies: ["Fetch news"] },
                        // Branch B depends on Branch A via the documented marker
                        { name: "Branch B", description: "", dependencies: ["branch-task-1-id"] },
                    ],
                },
            });

            expect(result).not.toBeNull();
            const branchA = result!.chain.tasks.find((t) => t.name === "Branch A")!;
            const branchB = result!.chain.tasks.find((t) => t.name === "Branch B")!;
            expect(branchA.dependencies).toEqual([ID_FETCH]);
            expect(branchB.dependencies).toEqual([branchA.id]);
        });

        it("warns and ignores unresolvable merge_point", async () => {
            const warnSpy = vi.spyOn(elizaLogger, "warn").mockImplementation(() => {});
            const chain = makeChain([
                makeTask({ id: ID_REPORT, name: "Final report", status: "pending" }),
            ]);

            const result = await applySupervisionModifications(chain, {
                decision: true,
                add_branch: {
                    enabled: true,
                    tasks: [{ name: "Branch A", description: "", dependencies: [] }],
                    merge_point: "Does not exist",
                },
            });

            // Branch still added, but merge wiring is skipped with a warning
            expect(result).not.toBeNull();
            const final = result!.chain.tasks.find((t) => t.id === ID_REPORT)!;
            expect(final.dependencies).toEqual([]);
            const warned = warnSpy.mock.calls
                .map((args) => String(args[0]))
                .some((m) => /Merge point not found: Does not exist/.test(m));
            expect(warned).toBe(true);
        });
    });
});
