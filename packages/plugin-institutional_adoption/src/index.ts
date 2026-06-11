import { institutionalCryptoSearch } from "./actions/webSearch";

export const institutionalCryptoSearchPlugin = {
    name: "institutionalCryptoSearch",
    description: "Search for institutional cryptocurrency adoption news, corporate treasury holdings, ETFs, and regulatory developments",
    actions: [institutionalCryptoSearch],
    evaluators: [],
    providers: [],
    services: [],
    clients: [],
    adapters: [],
};

export default institutionalCryptoSearchPlugin;
