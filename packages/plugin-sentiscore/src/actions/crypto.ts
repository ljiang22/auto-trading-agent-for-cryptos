import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_sentiment_score = makeS3SentimentFetcher({ prefix: 'crypto_news/', symbolMode: 'per-symbol' });

export const CryptoNewsSentimentAction = makeSourceAction({
    name: "Crypto_News_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from crypto news articles.",
    sourceLabel: "Crypto News",
    sourceType: "crypto_news",
    color: "rgb(239, 68, 68)",
    fetchFn: GET_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the crypto news sentiment for BTC?", action: "Crypto_News_Sentiment" } }],
        [{ user: "user2", content: { text: "Crypto news sentiment for ETH last week", action: "Crypto_News_Sentiment" } }],
    ],
});
