import type { Plugin } from "@elizaos/core";
import { CryptoSentimentAnalysisAndVisualization } from "./actions/combine.ts";
import { CryptoNewsSentimentAction } from "./actions/crypto.ts";
import { XSentimentAction } from "./actions/x.ts";
import { XInfluencersSentimentAction } from "./actions/x_influencers.ts";
import { RedditSentimentAction } from "./actions/reddit.ts";
import { PodcastSentimentAction } from "./actions/podcast.ts";
import { ResearchSentimentAction } from "./actions/research.ts";
import { CryptoPolicySentimentAction } from "./actions/crypto_policy.ts";
import { YoutubeSentimentAction } from "./actions/youtube.ts";
import { MacroNewsSentimentAction } from "./actions/macro_news.ts";
export * as actions from "./actions/index.ts";
export { getLatestSentiment, extractLatestSentiment } from "./latestSentiment.ts";
export type { LatestSentiment } from "./latestSentiment.ts";

export const sentiscore_analysis_Plugin: Plugin = {
    name: "sentiscore_analysis",
    description: "Plugin for analyzing cryptocurrency sentiment scores",
    actions: [
        CryptoSentimentAnalysisAndVisualization,
        CryptoNewsSentimentAction,
        XSentimentAction,
        XInfluencersSentimentAction,
        RedditSentimentAction,
        PodcastSentimentAction,
        ResearchSentimentAction,
        CryptoPolicySentimentAction,
        YoutubeSentimentAction,
        MacroNewsSentimentAction,
    ]
};
export default sentiscore_analysis_Plugin;
