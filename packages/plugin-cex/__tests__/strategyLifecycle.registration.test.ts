import { describe, it, expect } from "vitest";
import { tradeActions } from "../src/actions/index";
import { validateApprovedActionParams } from "../src/actions/shared";

const NAMES = ["arm_strategy", "pause_strategy", "resume_strategy", "stop_strategy", "list_strategies"];

describe("strategy lifecycle registration", () => {
  it("all five actions are registered in tradeActions", () => {
    const registered = new Set(tradeActions.map((a: any) => a.name));
    for (const n of NAMES) expect(registered.has(n)).toBe(true);
  });

  it("validateApprovedActionParams does not throw 'Unknown CEX action' for the new actions", () => {
    for (const n of NAMES) {
      expect(() => validateApprovedActionParams(n as any, {})).not.toThrow(/Unknown CEX action/);
    }
  });
});
