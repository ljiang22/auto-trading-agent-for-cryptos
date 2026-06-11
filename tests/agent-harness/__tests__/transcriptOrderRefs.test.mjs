import { describe, expect, it } from "vitest";
import {
    createTranscriptState,
    extractOrderRefsFromTranscript,
    extractHarnessOrderRefsFromTranscript,
    ingestEvent,
} from "../lib/transcript.mjs";

describe("extractOrderRefsFromTranscript", () => {
    it("finds venue order_id linked to client_order_id in step events", () => {
        const transcript = createTranscriptState();
        ingestEvent(
            {
                type: "step",
                step: {
                    name: "create_order",
                    data: {
                        result: {
                            client_order_id: "harness-spot-limit_limit_gtc-1",
                            order_id: "99887766",
                        },
                    },
                },
            },
            transcript,
        );

        expect(
            extractOrderRefsFromTranscript(
                transcript,
                "harness-spot-limit_limit_gtc-1",
            ),
        ).toEqual(["99887766"]);
    });

    it("dedupes venue ids and scans nested arrays", () => {
        const transcript = createTranscriptState();
        ingestEvent(
            {
                type: "action_response",
                response: {
                    user: "assistant",
                    text: JSON.stringify({
                        orders: [
                            {
                                clientOrderId: "harness-margin-cross-limit-2",
                                orderId: "112233",
                            },
                            {
                                clientOrderId: "harness-margin-cross-limit-2",
                                orderId: "112233",
                            },
                        ],
                    }),
                },
            },
            transcript,
        );

        expect(
            extractOrderRefsFromTranscript(
                transcript,
                "harness-margin-cross-limit-2",
            ),
        ).toEqual(["112233"]);
    });

    it("extractHarnessOrderRefsFromTranscript maps multiple client ids", () => {
        const transcript = createTranscriptState();
        ingestEvent(
            {
                type: "step",
                step: {
                    data: {
                        orders: [
                            {
                                client_order_id: "harness-a",
                                order_id: "1",
                            },
                            {
                                client_order_id: "harness-b",
                                order_id: "2",
                            },
                        ],
                    },
                },
            },
            transcript,
        );

        expect(
            extractHarnessOrderRefsFromTranscript(transcript, [
                "harness-a",
                "harness-b",
                "harness-missing",
            ]),
        ).toEqual({
            "harness-a": ["1"],
            "harness-b": ["2"],
            "harness-missing": [],
        });
    });
});
