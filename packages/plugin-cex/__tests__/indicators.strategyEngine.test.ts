import { describe, it, expect } from "vitest";
import { volumeZScore, pctFromHigh } from "../src/backtest/indicators";

const bar = (close: number, high: number, volume: number) => ({
  timestamp: 0, open: close, high, low: close, close, volume,
});

describe("volumeZScore", () => {
  it("is 0 when the last volume equals the window mean", () => {
    const bars = [bar(1, 1, 10), bar(1, 1, 10), bar(1, 1, 10)];
    expect(volumeZScore(bars, 2, 3)).toBeCloseTo(0, 6);
  });
  it("is positive on a volume spike", () => {
    const bars = [bar(1, 1, 10), bar(1, 1, 10), bar(1, 1, 100)];
    expect(volumeZScore(bars, 2, 3)).toBeGreaterThan(1);
  });
  it("returns NaN before the window fills", () => {
    const bars = [bar(1, 1, 10)];
    expect(Number.isNaN(volumeZScore(bars, 0, 3))).toBe(true);
  });
  it("returns 0 for a zero-variance window", () => {
    const bars = [bar(1, 1, 5), bar(1, 1, 5)];
    expect(volumeZScore(bars, 1, 2)).toBe(0);
  });
});

describe("pctFromHigh", () => {
  it("is 0 at a fresh high", () => {
    const bars = [bar(10, 10, 1), bar(12, 12, 1)];
    expect(pctFromHigh(bars, 1, 2)).toBeCloseTo(0, 6);
  });
  it("is -5 when 5% below the rolling high", () => {
    const bars = [bar(100, 100, 1), bar(95, 95, 1)];
    expect(pctFromHigh(bars, 1, 2)).toBeCloseTo(-5, 6);
  });
  it("returns NaN before the window fills", () => {
    const bars = [bar(10, 10, 1)];
    expect(Number.isNaN(pctFromHigh(bars, 0, 5))).toBe(true);
  });
});
