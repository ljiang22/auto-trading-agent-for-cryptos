/**
 * Harness-side environment-context injector. Gated by SIM_MOCK_PROVIDER so it can never
 * fire in an AWS deployment. It only shapes the harness's OUTGOING user messages — it does
 * not touch the agent runtime (the CEX order gate reads no sentiment data anyway).
 * @param {"baseline"|"highVolatility"|"thesisFlip"} variant
 */
export function applyEnvironment(variant) {
  if (!process.env.SIM_MOCK_PROVIDER) {
    return { variant, injectedTurns: [], note: "disabled (SIM_MOCK_PROVIDER unset)" };
  }
  switch (variant) {
    case "thesisFlip":
      return {
        variant,
        injectedTurns: [
          "Wait — I just saw the news on ETH turn sharply negative and sentiment looks like it flipped. What should I do now?",
        ],
        note: "thesisFlip: scripted mid-conversation flip turn",
      };
    case "highVolatility":
      return {
        variant,
        injectedTurns: [
          "Prices are swinging really wildly right now and volatility looks extreme. Does that change your advice?",
        ],
        note: "highVolatility: scripted volatility context turn",
      };
    default:
      return { variant, injectedTurns: [], note: "baseline" };
  }
}
