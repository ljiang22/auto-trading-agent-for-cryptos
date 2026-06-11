import type { Plugin } from "@elizaos/core";
import { TechnicAnalysisAction } from "./actions/technic_analysis.ts";

export * as actions from "./actions/index.ts";

export const cryptoTechnicAnalysisPlugin: Plugin = {
    name: "crypto_technic_analysis",
    description: "Comprehensive cryptocurrency data analysis plugin for Bitcoin, Ethereum, altcoins, DeFi tokens, and all digital assets. Covers trend analysis, volatility assessment, volume patterns, technic indicators, machine learning models, anomaly detection, backtesting strategies, and market regime identification",
    actions: [
        TechnicAnalysisAction,
    ]
};

export default cryptoTechnicAnalysisPlugin;
