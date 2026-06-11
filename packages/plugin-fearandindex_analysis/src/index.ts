import type { Plugin } from "@elizaos/core";
import { fearAndGreedIndexAnalysisAction } from "./actions/fearandgreed_index_analysis.ts";
export * as actions from "./actions/index.ts";

export const fearAndGreedAnalysisPlugin: Plugin = {
    name: "fear_and_greed_analysis",
    description: "Comprehensive Fear & Greed Index analysis plugin for cryptocurrency market sentiment analysis. Provides detailed insights into market psychology, trading signals, trend analysis, and strategic recommendations based on current and historical fear and greed data.",
    actions: [
        fearAndGreedIndexAnalysisAction,
    ],
    evaluators: [],
    providers: [],
};

export default fearAndGreedAnalysisPlugin;
