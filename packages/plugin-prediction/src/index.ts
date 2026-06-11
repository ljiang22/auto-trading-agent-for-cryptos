import type { Plugin } from "@elizaos/core";
import { predictionAction } from "./actions/prediction";

export * as actions from "./actions";

export const predictionPlugin: Plugin = {
    name: "prediction",
    description: "AI-powered crypto market prediction plugin with technical analysis and sentiment-based forecasting capabilities",
    actions: [
        predictionAction,
    ],
    evaluators: [],
};

export default predictionPlugin;
