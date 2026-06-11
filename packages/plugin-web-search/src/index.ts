import { webSearch } from "./actions/webSearch";

export const webSearchPlugin = {
    name: "webSearch",
    description: "Search the web and get news",
    actions: [webSearch],
    evaluators: [],
    providers: [],
    services: [],
    clients: [],
    adapters: [],
};

export default webSearchPlugin;
