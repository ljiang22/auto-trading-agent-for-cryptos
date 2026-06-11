import { TwitterClientInterface } from "./client";

export const twitterPlugin = {
    name: "twitter",
    description: "Twitter client",
    clients: [TwitterClientInterface],
};
export default twitterPlugin;
