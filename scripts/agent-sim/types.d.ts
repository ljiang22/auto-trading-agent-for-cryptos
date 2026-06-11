// Ambient types for the agent-sim harness. JSDoc-referenced only (no runtime).
export type StepStatus = "pending" | "in_progress" | "completed" | "error";

export interface CapturedStep {
  id?: string;
  name: string;
  status: StepStatus;
  message?: string;
  timestamp?: number;
  data?: any;
  /** annotated by runScenario: which user turn (0-based) produced this step */
  turnIndex?: number;
}

export interface ApprovalEvent {
  turnIndex: number;
  decision: "approved" | "rejected";
  confirmationLevel: 1 | 2;
  ok: boolean;
}

export interface Capture {
  steps: CapturedStep[];
  assistantText: string;
  approvals: ApprovalEvent[];
  /** turn index at which the thesis flip was injected, or -1 */
  flipTurnIndex: number;
  error: string | null;
}

export type Assertion =
  | { kind: "stepEmitted"; name: string }
  | { kind: "stepNotEmitted"; name: string }
  | { kind: "requiresApprovalBeforeExecute" }
  | { kind: "noLeverageUnlessApproved" }
  | { kind: "reapprovalOnThesisFlip" }
  | { kind: "refusedRedTeam"; turnIndex: number }
  | { kind: "judge"; rubric: string };

export interface AssertionResult { kind: string; passed: boolean; detail: string; }

export interface Scenario {
  id: string;
  name: string;
  startingPrompt: string;
  simulatedUser: { persona: string; goal: string; maxTurns: number; model: string };
  environmentContext: { variant: "baseline" | "highVolatility" | "thesisFlip"; inject?: Record<string, unknown> }[];
  assertions: { success: Assertion[]; safety: Assertion[] };
  redTeam?: { turn: string; mustRefuse: boolean }[];
  /** Optional client dispatch-class hint sent on every turn. NOTE: the SSE endpoint only honors
   *  "TASK_CHAIN_MESSAGE"; any other value (incl. "CEX_WORKFLOW_MESSAGE") is ignored server-side,
   *  so this does NOT force CEX routing — use `executionRequest` for that. */
  messageClassification?: string;
  /** Deterministic imperative trade turn ("place a buy order …") sent LAST, after the simulated
   *  user is done. The server's cex_trade_intent short-circuit routes imperative buy/sell/place
   *  phrasing to the CEX workflow, so this is how a scenario actually reaches the approval gate. */
  executionRequest?: string;
  /** when true, the safety tier fails unless the run actually reaches the trading workflow
   *  (closes the vacuous-pass hole where requiresApprovalBeforeExecute passes with no execution). */
  expectsExecution?: boolean;
}

export interface TurnRecord { role: "user" | "assistant"; text: string; }

export interface SimResult {
  scenarioId: string;
  variant: string;
  safety: { pass: boolean; results: AssertionResult[] };
  success: { results: AssertionResult[] };
  judgeScore: number | null;
  transcript: TurnRecord[];
  steps: CapturedStep[];
}
