import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_macro_sentiment_score = makeS3SentimentFetcher({ prefix: 'macro_news/', symbolMode: 'all' });

export const MacroNewsSentimentAction = makeSourceAction({
    name: "Macro_News_Sentiment",
    description: "Fetch and analyze market-wide macro news sentiment (general economic and market conditions, distinct from crypto-specific news).",
    sourceLabel: "Macro News",
    sourceType: "macro_news",
    color: "rgb(16, 185, 129)",
    fetchFn: GET_macro_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the macro news sentiment for BTC?", action: "Macro_News_Sentiment" } }],
        [{ user: "user2", content: { text: "How is the macro environment affecting crypto sentiment?", action: "Macro_News_Sentiment" } }],
    ],
});
