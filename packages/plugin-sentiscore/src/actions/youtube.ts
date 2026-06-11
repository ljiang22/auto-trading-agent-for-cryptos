import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_youtube_sentiment_score = makeS3SentimentFetcher({ prefix: 'youtube/', symbolMode: 'all' });

export const YoutubeSentimentAction = makeSourceAction({
    name: "YouTube_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from YouTube videos and comments.",
    sourceLabel: "YouTube",
    sourceType: "youtube",
    color: "rgb(220, 38, 38)",
    fetchFn: GET_youtube_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the YouTube sentiment for BTC?", action: "YouTube_Sentiment" } }],
        [{ user: "user2", content: { text: "YouTube content sentiment for Ethereum last month", action: "YouTube_Sentiment" } }],
    ],
});
