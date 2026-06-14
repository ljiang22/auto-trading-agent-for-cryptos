import { describe, it, expect } from "vitest";
import { compileNlToDsl } from "../src/strategy/nlToDSL";
import { strategyDSLSchema } from "../src/strategy/strategyDSL";

describe("hybrid DCA + risk-control compiler", () => {
  it("compiles a DCA + dip-buy + TP/SL request into a valid DSL", () => {
    const res = compileNlToDsl(
      "DCA $50 of BTC weekly, also buy the dip at -5% from the 20-day high, take profit 3% stop loss 2%",
      { locale: "en", owner: "u1", venue: "paper" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(() => strategyDSLSchema.parse(res.strategy)).not.toThrow();
    const s = res.strategy as any;
    const kinds = s.signals.map((x: any) => x.kind);
    expect(kinds).toContain("price.pct_from_high");
    expect(s.entries.length).toBeGreaterThanOrEqual(2);
    expect(s.risk.per_trade_take_profit_bps).toBe(300);
    expect(s.risk.per_trade_stop_loss_bps).toBe(200);
    expect(s.identity.mode).toBe("paper");
  });

  it("does not hijack a plain DCA request (no risk keyword)", () => {
    const res = compileNlToDsl("DCA $50 of BTC weekly", { locale: "en", owner: "u1", venue: "paper" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const kinds = (res.strategy as any).signals.map((x: any) => x.kind);
    expect(kinds).not.toContain("price.pct_from_high");
  });
});
