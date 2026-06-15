import { describe, it, expect } from "vitest";
import { extractLatestSentiment } from "./latestSentiment";

describe("extractLatestSentiment", () => {
  it("returns the score with the max time", () => {
    const body = {
      symbol: "BTC",
      sentiScores: [
        { time: 100, value: 0.1, total: 5 },
        { time: 300, value: -0.4, total: 20 },
        { time: 200, value: 0.9, total: 1 },
      ],
    };
    expect(extractLatestSentiment(body as any)).toEqual({ value: -0.4, ts: 300_000 });
  });

  it("returns null on empty/absent scores", () => {
    expect(extractLatestSentiment({ sentiScores: [] } as any)).toBeNull();
    expect(extractLatestSentiment({} as any)).toBeNull();
  });
});
