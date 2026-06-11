import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_research_sentiment_score = makeS3SentimentFetcher({ prefix: 'research/', symbolMode: 'per-symbol' });

export const ResearchSentimentAction = makeSourceAction({
    name: "Research_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from crypto research reports.",
    sourceLabel: "Research",
    sourceType: "research",
    color: "rgb(234, 179, 8)",
    fetchFn: GET_research_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What do research reports say about BTC sentiment?", action: "Research_Sentiment" } }],
        [{ user: "user2", content: { text: "Research sentiment for Ethereum last 14 days", action: "Research_Sentiment" } }],
    ],
});
