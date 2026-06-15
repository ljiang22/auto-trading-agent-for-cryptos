import { describe, it, expect } from "vitest";
import { singleStepFallsThroughToLegacy } from "../src/handlers/cexPlanRunner";

const plan = (actions: string[]) =>
  ({ steps: actions.map((a, i) => ({ id: String(i + 1), action: a })) }) as never;

describe("singleStepFallsThroughToLegacy", () => {
  it("a single create_order falls through to legacy (modal/risk tuned for one-shot orders)", () => {
    expect(singleStepFallsThroughToLegacy(plan(["create_order"]))).toBe(true);
  });

  it("a single list_strategies does NOT fall through — executes via the plan runner (no LLM freelance)", () => {
    expect(singleStepFallsThroughToLegacy(plan(["list_strategies"]))).toBe(false);
  });

  it("single pause/resume/stop/arm_strategy execute via the plan runner, not the legacy LLM", () => {
    for (const a of ["pause_strategy", "resume_strategy", "stop_strategy", "arm_strategy"]) {
      expect(singleStepFallsThroughToLegacy(plan([a]))).toBe(false);
    }
  });

  it("a single get_balance still falls through (legacy/ADK read path is well-tuned)", () => {
    expect(singleStepFallsThroughToLegacy(plan(["get_balance"]))).toBe(true);
  });

  it("multi-step plans are not single-step fall-through", () => {
    expect(singleStepFallsThroughToLegacy(plan(["get_balance", "create_order"]))).toBe(false);
  });
});
