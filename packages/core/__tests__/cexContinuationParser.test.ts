import { describe, expect, it } from "vitest";
import { parseContinuation } from "../src/handlers/cexContinuationParser";

describe("parseContinuation — EXECUTION_STATUS", () => {
    it("detects executing status query", () => {
        expect(parseContinuation("Can you check the executing status?").command).toBe(
            "EXECUTION_STATUS",
        );
    });

    it("detects order status query", () => {
        expect(parseContinuation("What is the order status?").command).toBe(
            "EXECUTION_STATUS",
        );
    });
});

describe("parseContinuation — APPROVE_NEXT (default 'yes' family)", () => {
    const expectApprove = (input: string) => {
        const result = parseContinuation(input);
        expect(result.command).toBe("APPROVE_NEXT");
    };

    it("'yes'", () => expectApprove("yes"));
    it("'yes.'", () => expectApprove("yes."));
    it("'y'", () => expectApprove("y"));
    it("'ok'", () => expectApprove("ok"));
    it("'okay'", () => expectApprove("okay"));
    it("'sure'", () => expectApprove("sure"));
    it("'confirm'", () => expectApprove("confirm"));
    it("'confirmed'", () => expectApprove("confirmed"));
    it("'go'", () => expectApprove("go"));
    it("'do it'", () => expectApprove("do it"));
    it("'place it'", () => expectApprove("place it"));
    it("'submit'", () => expectApprove("submit"));
    it("'continue'", () => expectApprove("continue"));
    it("'next'", () => expectApprove("next"));
    it("'yes, please'", () => expectApprove("yes, please"));
    it("'please do it'", () => expectApprove("please do it"));
    it("'please place it'", () => expectApprove("please place it"));
    it("zh-CN '是'", () => expectApprove("是"));
    it("zh-CN '确认'", () => expectApprove("确认"));
    it("zh-CN '继续'", () => expectApprove("继续"));
});

describe("parseContinuation — APPROVE_BATCH (explicit 'all' opt-in)", () => {
    const expectBatch = (input: string) => {
        const result = parseContinuation(input);
        expect(result.command).toBe("APPROVE_BATCH");
    };

    it("'yes, all'", () => expectBatch("yes, all"));
    it("'yes all'", () => expectBatch("yes all"));
    it("'approve all'", () => expectBatch("approve all"));
    it("'place all'", () => expectBatch("place all"));
    it("'all of them'", () => expectBatch("all of them"));
    it("'do them all'", () => expectBatch("do them all"));
    it("'batch'", () => expectBatch("batch"));
    it("'batch approve'", () => expectBatch("batch approve"));
    it("'run all'", () => expectBatch("run all"));
    it("zh-CN '全部确认'", () => expectBatch("全部确认"));
    it("zh-CN '全部下单'", () => expectBatch("全部下单"));

    it("a bare 'yes' must NOT batch-approve", () => {
        expect(parseContinuation("yes").command).toBe("APPROVE_NEXT");
    });

    it("a bare 'approve' must NOT batch-approve", () => {
        expect(parseContinuation("approve").command).toBe("APPROVE_NEXT");
    });
});

describe("parseContinuation — CANCEL_PLAN", () => {
    const expectCancel = (input: string) => {
        const result = parseContinuation(input);
        expect(result.command).toBe("CANCEL_PLAN");
    };

    it("'no'", () => expectCancel("no"));
    it("'nope'", () => expectCancel("nope"));
    it("'cancel'", () => expectCancel("cancel"));
    it("'stop'", () => expectCancel("stop"));
    it("'abort'", () => expectCancel("abort"));
    it("'never mind'", () => expectCancel("never mind"));
    it("'nevermind'", () => expectCancel("nevermind"));
    it("'forget it'", () => expectCancel("forget it"));
    it("'don't'", () => expectCancel("don't"));
    it("'skip all'", () => expectCancel("skip all"));
    it("zh-CN '取消'", () => expectCancel("取消"));
    it("zh-CN '停止'", () => expectCancel("停止"));
    it("zh-CN '不要'", () => expectCancel("不要"));
    it("zh-CN '算了'", () => expectCancel("算了"));
});

describe("parseContinuation — SKIP_STEP", () => {
    it("'skip'", () => {
        expect(parseContinuation("skip").command).toBe("SKIP_STEP");
    });
    it("'skip this'", () => {
        expect(parseContinuation("skip this").command).toBe("SKIP_STEP");
    });
    it("'skip step 2'", () => {
        expect(parseContinuation("skip step 2").command).toBe("SKIP_STEP");
    });
    it("'skip the next'", () => {
        expect(parseContinuation("skip the next").command).toBe("SKIP_STEP");
    });
    it("zh-CN '跳过'", () => {
        expect(parseContinuation("跳过").command).toBe("SKIP_STEP");
    });
});

describe("parseContinuation — step references", () => {
    it("'place 2' captures the step id", () => {
        const r = parseContinuation("place 2");
        expect(r.command).toBe("APPROVE_NEXT");
        expect(r.targetStepId).toBe("2");
    });

    it("'approve 3'", () => {
        const r = parseContinuation("approve 3");
        expect(r.command).toBe("APPROVE_NEXT");
        expect(r.targetStepId).toBe("3");
    });

    it("'step 1'", () => {
        const r = parseContinuation("step 1");
        expect(r.command).toBe("APPROVE_NEXT");
        expect(r.targetStepId).toBe("1");
    });
});

describe("parseContinuation — UNKNOWN", () => {
    const expectUnknown = (input: string) => {
        expect(parseContinuation(input).command).toBe("UNKNOWN");
    };

    it("empty string", () => expectUnknown(""));
    it("whitespace", () => expectUnknown("   "));
    it("unrelated trading request", () => expectUnknown("show me the BTC price"));
    it("comprehensive analysis ask", () => expectUnknown("Generate a comprehensive BTC report"));
    it("a question that isn't yes/no", () => expectUnknown("What's the difference?"));
    it("a balance check that isn't a confirmation", () => expectUnknown("what is my account balance"));
    // Fix-NEW5 iter3 (post-PR243): the orders-table Cancel chip dispatches
    // "cancel order 62132339201" as a fresh chat message. The continuation
    // parser must NOT classify it as CANCEL_PLAN — otherwise a pending
    // multi-step plan in this thread gets cancelled instead of the
    // specific order. Same protection for "cancel trade" / "cancel fill".
    it("'cancel order <id>' is NOT a plan cancel (it's a cancel_order action)", () => expectUnknown("cancel order 62132339201"));
    it("'cancel order <id> on binance' is NOT a plan cancel", () => expectUnknown("cancel order 62132339201 on binance"));
    it("'cancel the order' is NOT a plan cancel", () => expectUnknown("cancel the order"));
    // Fix-NEW8 iter4 (post-PR244): a fresh order-creation message must
    // not be hijacked as plan-continuation. Previously "place 10 USDT…"
    // matched STEP_REFERENCE_RE \b place 10 \b → APPROVE_NEXT step 10.
    it("'place 10 USDT buy BTC at 60800' is NOT a plan-step approve", () => expectUnknown("place 10 USDT buy BTC at 60800"));
    it("'place 10 USDT buy ETH at 1959' is NOT a plan-step approve", () => expectUnknown("place 10 USDT buy ETH at 1959"));
    it("'buy 0.001 BTC at 80000' is NOT a plan-step approve", () => expectUnknown("buy 0.001 BTC at 80000"));
    it("'sell 10 USDT of ETH' is NOT a plan-step approve", () => expectUnknown("sell 10 USDT of ETH"));
    // Step references with bare integers still work.
});

describe("parseContinuation — step references", () => {
    it("'place 2' references step 2", () => {
        const r = parseContinuation("place 2");
        expect(r.command).toBe("APPROVE_NEXT");
        expect(r.targetStepId).toBe("2");
    });
    it("'approve 3' references step 3", () => {
        const r = parseContinuation("approve 3");
        expect(r.command).toBe("APPROVE_NEXT");
        expect(r.targetStepId).toBe("3");
    });
});

describe("parseContinuation — disambiguation", () => {
    it("'cancel' wins over a stray 'yes' (cancel is checked first)", () => {
        // Pathological input combining both — cancel should win because
        // safety bias prefers stopping over progressing.
        expect(parseContinuation("yes but actually cancel").command).toBe("CANCEL_PLAN");
    });

    it("'yes, all' wins over batch loose match before approve", () => {
        expect(parseContinuation("yes, all please").command).toBe("APPROVE_BATCH");
    });

    it("'no' alone is cancel, not a yes-misread", () => {
        expect(parseContinuation("no").command).toBe("CANCEL_PLAN");
    });
});
