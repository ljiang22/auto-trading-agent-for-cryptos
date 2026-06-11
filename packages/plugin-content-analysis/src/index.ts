import type { Plugin } from "@elizaos/core";
import { CryptoContentAnalysis } from "./actions/cryptoContentAnalysis.ts";
import { GeneralContentAnalysis } from "./actions/generalContentAnalysis.ts";

export * as actions from "./actions/index.ts";

export const contentAnalysisPlugin: Plugin = {
    name: "content-analysis",
    description: "Plugin for analyzing and summarizing crypto and general content using specialized analysis templates",
    actions: [
        CryptoContentAnalysis,
        GeneralContentAnalysis
    ],
    evaluators: [],
    providers: [],
};

export default contentAnalysisPlugin;