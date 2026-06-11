import { describe, expect, it, vi } from "vitest";
import { assertSafeConcurrency } from "../lib/runner.mjs";
import { waitForWorkflowIdle } from "../lib/humanInputInterrupt.mjs";

describe("assertSafeConcurrency", () => {
    it("allows concurrency 1 with perRoomGroup", () => {
        expect(() => assertSafeConcurrency("perRoomGroup", 1)).not.toThrow();
    });

    it("rejects concurrency > 1 with shared room strategies", () => {
        expect(() => assertSafeConcurrency("perRoomGroup", 2)).toThrow(
            /unsafe with roomStrategy=perRoomGroup/,
        );
        expect(() => assertSafeConcurrency("reuse", 3)).toThrow(/unsafe/);
    });

    it("allows concurrency > 1 with perCase", () => {
        expect(() => assertSafeConcurrency("perCase", 2)).not.toThrow();
    });
});

describe("waitForWorkflowIdle (perRoomGroup case barrier)", () => {
    it("polls until active workflow clears", async () => {
        const getActiveWorkflow = vi
            .fn()
            .mockResolvedValueOnce({ active: true, kind: "cex" })
            .mockResolvedValueOnce({ active: true, kind: "cex" })
            .mockResolvedValue({ active: false });
        const client = { getActiveWorkflow };
        const idle = await waitForWorkflowIdle(client, "room-spot", {
            timeoutMs: 2000,
            intervalMs: 10,
        });
        expect(idle).toBe(true);
        expect(getActiveWorkflow.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
