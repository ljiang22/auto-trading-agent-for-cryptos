import { makeS3SentimentFetcher } from "./_s3SentimentFetcher.ts";
import { makeSourceAction } from "./_sourceActionFactory.ts";

export const GET_crypto_policy_sentiment_score = makeS3SentimentFetcher({ prefix: 'crypto_policy/', symbolMode: 'all' });

export const CryptoPolicySentimentAction = makeSourceAction({
    name: "Crypto_Policy_Sentiment",
    description: "Fetch and analyze cryptocurrency sentiment from crypto policy and regulatory news.",
    sourceLabel: "Crypto Policy",
    sourceType: "crypto_policy",
    color: "rgb(107, 114, 128)",
    fetchFn: GET_crypto_policy_sentiment_score,
    examples: [
        [{ user: "user1", content: { text: "What's the regulatory sentiment for Bitcoin?", action: "Crypto_Policy_Sentiment" } }],
        [{ user: "user2", content: { text: "Crypto policy sentiment for ETH this week", action: "Crypto_Policy_Sentiment" } }],
    ],
});
