import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_X_influencers_sentiment_score = makeS3SentimentFetcher({ prefix: 'X_influencers/', symbolMode: 'per-symbol' });

export const XInfluencersSentimentAction = makeSourceAction({
    name: "X_Influencers_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from X/Twitter crypto influencers.",
    sourceLabel: "X Influencers",
    sourceType: "x_influencers",
    color: "rgb(168, 85, 247)",
    fetchFn: GET_X_influencers_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What do crypto influencers on X say about BTC?", action: "X_Influencers_Sentiment" } }],
        [{ user: "user2", content: { text: "X influencers sentiment for Ethereum this month", action: "X_Influencers_Sentiment" } }],
    ],
});
