import type { ActionExample } from "@elizaos/core";

export const priceExamples: ActionExample[][] = [
    [
        {
            user: "{{user1}}",
            content: {
                text: "What's the current price of Bitcoin?",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user2}}",
            content: {
                text: "Check ETH price in EUR",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user3}}",
            content: {
                text: "How much is Solana worth right now?",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user4}}",
            content: {
                text: "Get me the price of Dogecoin",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user5}}",
            content: {
                text: "What's the current BTC price and fear index?",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user6}}",
            content: {
                text: "Show me Ethereum price data",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user7}}",
            content: {
                text: "Check the price of Cardano in GBP",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user8}}",
            content: {
                text: "What's the market price for XRP?",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user9}}",
            content: {
                text: "Get current price and market cap for Polygon",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],
    [
        {
            user: "{{user10}}",
            content: {
                text: "How much does one Bitcoin cost today?",
                action: "GET_PRICE_AND_FEAR_INDEX"
            },
        },
    ],

];