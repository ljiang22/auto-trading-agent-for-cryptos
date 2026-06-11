import { cryptoResearchSearch } from "./actions/crypto_research";

export const cryptoResearchSearchPlugin = {
    name: "cryptoResearchSearch",
    description: "Specialized web search focused exclusively on cryptocurrency research analysis, blockchain studies, digital asset research reports, and comprehensive crypto market analysis with academic and professional research emphasis",
    actions: [cryptoResearchSearch],
    evaluators: [],
    providers: [],
    services: [],
    clients: [],
    adapters: [],
};

export default cryptoResearchSearchPlugin;
