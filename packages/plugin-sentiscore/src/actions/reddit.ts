import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_reddit_sentiment_score = makeS3SentimentFetcher({ prefix: 'reddit/', symbolMode: 'per-symbol' });

export const RedditSentimentAction = makeSourceAction({
    name: "Reddit_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from Reddit discussions.",
    sourceLabel: "Reddit",
    sourceType: "reddit",
    color: "rgb(249, 115, 22)",
    fetchFn: GET_reddit_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the Reddit sentiment for BTC?", action: "Reddit_Sentiment" } }],
        [{ user: "user2", content: { text: "Reddit community sentiment for Solana this month", action: "Reddit_Sentiment" } }],
    ],
});
