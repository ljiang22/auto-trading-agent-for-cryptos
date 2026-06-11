import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_X_sentiment_score = makeS3SentimentFetcher({ prefix: 'X/', symbolMode: 'per-symbol' });

export const XSentimentAction = makeSourceAction({
    name: "X_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from X/Twitter posts.",
    sourceLabel: "X/Twitter",
    sourceType: "x",
    color: "rgb(59, 130, 246)",
    fetchFn: GET_X_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the X/Twitter sentiment for BTC?", action: "X_Sentiment" } }],
        [{ user: "user2", content: { text: "Show me Twitter sentiment for SOL this week", action: "X_Sentiment" } }],
    ],
});
