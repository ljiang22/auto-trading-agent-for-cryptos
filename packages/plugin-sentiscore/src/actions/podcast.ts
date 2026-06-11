import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_podcast_sentiment_score = makeS3SentimentFetcher({ prefix: 'podcast/', symbolMode: 'per-symbol' });

export const PodcastSentimentAction = makeSourceAction({
    name: "Podcast_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from crypto podcast discussions.",
    sourceLabel: "Podcast",
    sourceType: "podcast",
    color: "rgb(20, 184, 166)",
    fetchFn: GET_podcast_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the podcast sentiment for BTC?", action: "Podcast_Sentiment" } }],
        [{ user: "user2", content: { text: "Crypto podcast sentiment for Solana this month", action: "Podcast_Sentiment" } }],
    ],
});
