import type { Plugin } from "@elizaos/core";

import { getNewsAction } from "./actions/getanews.ts";
export const GetANewsPlugin: Plugin = {
    name: "GetANews",
    description: "Get a news",
    actions: [getNewsAction]
};

export default GetANewsPlugin;

