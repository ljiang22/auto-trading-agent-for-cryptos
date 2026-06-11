import { describe, expect, it } from "vitest";

import {
    classifyTool,
    rankToolCandidates,
} from "../src/adk/intentClassifier";
import type { AdkToolName } from "../src/adk/types";

interface Case {
    input: string;
    expected: AdkToolName | null;
    note?: string;
}

const CASES: Case[] = [
    // get_balance — EN
    { input: "What's my BTC balance?", expected: "get_balance" },
    { input: "show my Coinbase balances", expected: "get_balance" },
    { input: "how much BTC do I have", expected: "get_balance" },
    // get_balance — ZH
    { input: "我的BTC余额是多少", expected: "get_balance" },
    { input: "查看账户余额", expected: "get_balance" },
    // get_orders — EN
    { input: "show me my open orders", expected: "get_orders" },
    { input: "list my orders", expected: "get_orders" },
    { input: "give me order history", expected: "get_orders" },
    { input: "what orders do I have", expected: "get_orders" },
    { input: "what orders do i have on binance", expected: "get_orders" },
    { input: "any open orders", expected: "get_orders" },
    { input: "do I have any pending orders", expected: "get_orders" },
    { input: "are there any open orders", expected: "get_orders" },
    // get_orders — ZH
    { input: "查看我的挂单", expected: "get_orders" },
    { input: "查看订单历史", expected: "get_orders" },
    // get_fills — EN
    { input: "show me my latest fills", expected: "get_fills" },
    { input: "trade history please", expected: "get_fills" },
    // get_fills — ZH
    { input: "查看成交记录", expected: "get_fills" },
    // cancel_order — EN
    { input: "cancel my order abc123", expected: "cancel_order" },
    { input: "cancel order 4242", expected: "cancel_order" },
    // cancel_order — plural / batch phrasings.
    // Regression: these were misrouted to get_orders because the
    // old `\border\b` patterns failed on plural "orders" and the
    // "my orders" substring matched the get_orders pattern instead.
    { input: "cancel all my orders", expected: "cancel_order" },
    { input: "cancel all of them", expected: "cancel_order" },
    { input: "cancel all of those orders", expected: "cancel_order" },
    { input: "cancel everything", expected: "cancel_order" },
    { input: "cancel them", expected: "cancel_order" },
    { input: "cancel these", expected: "cancel_order" },
    { input: "cancel both orders", expected: "cancel_order" },
    // cancel_order — ZH
    { input: "取消我的订单 12345", expected: "cancel_order" },
    { input: "取消所有订单", expected: "cancel_order" },
    { input: "全部取消", expected: "cancel_order" },
    { input: "取消这些订单", expected: "cancel_order" },
    // amend_order — EN
    { input: "amend my order abc to limit 70000", expected: "amend_order" },
    { input: "modify order abc to price 70000", expected: "amend_order" },
    // amend_order — ZH
    { input: "修改订单 abc 的价格", expected: "amend_order" },
    // preview_order — EN
    {
        input: "preview an order to buy 0.001 BTC",
        expected: "preview_order",
    },
    { input: "estimate the fees for a 0.5 BTC buy order", expected: "preview_order" },
    // preview_order — ZH
    { input: "预览订单 0.001 BTC", expected: "preview_order" },
    // create_order — EN
    { input: "buy 0.001 BTC at market on Binance", expected: "create_order" },
    { input: "sell 1 ETH at 3000 limit", expected: "create_order" },
    { input: "long 0.1 BTC", expected: "create_order" },
    { input: "place a limit order BTC-USD 70000", expected: "create_order" },
    // create_order — natural-language phrasings reported by users.
    // Regression: "I want to buy <size> of <pair> ..." once mis-classified
    // as cancel_order when the message was concatenated with a stale
    // prior "cancel order ..." turn (combineWithPriorClarificationContext).
    {
        input: "I want to buy 50 usdt of btc/usdt with a price of 60000 with post only",
        expected: "create_order",
        note: "self-sufficient buy phrasing — must not collide with cancel keyword",
    },
    {
        input: "I'd like to sell 0.5 btc-usdt at 65000 limit, IOC",
        expected: "create_order",
    },
    // create_order — ZH
    { input: "买 0.001 BTC 在 Binance 市价单", expected: "create_order" },
    { input: "卖 1 ETH 价格 3000", expected: "create_order" },
    // unclassified
    { input: "hello there", expected: null },
    { input: "what's the weather today?", expected: null },
];

describe("ADK intent classification benchmark", () => {
    for (const c of CASES) {
        it(`classifies "${c.input}" → ${c.expected ?? "null"}`, () => {
            expect(classifyTool(c.input)).toBe(c.expected);
        });
    }

    it("macro-F1 >= 0.92 on benchmark cases", () => {
        const labels = new Set(
            CASES.map((c) => c.expected).filter((v): v is AdkToolName => v !== null),
        );
        let macroSum = 0;
        let denom = 0;
        for (const label of labels) {
            const tp = CASES.filter(
                (c) => c.expected === label && classifyTool(c.input) === label,
            ).length;
            const fp = CASES.filter(
                (c) => c.expected !== label && classifyTool(c.input) === label,
            ).length;
            const fn = CASES.filter(
                (c) => c.expected === label && classifyTool(c.input) !== label,
            ).length;
            const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
            const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
            const f1 = precision + recall === 0
                ? 0
                : (2 * precision * recall) / (precision + recall);
            macroSum += f1;
            denom += 1;
        }
        const macroF1 = denom === 0 ? 0 : macroSum / denom;
        expect(macroF1).toBeGreaterThanOrEqual(0.92);
    });

    it("critical-write precision >= 0.95", () => {
        const writeLabels: AdkToolName[] = ["create_order", "cancel_order", "amend_order"];
        for (const label of writeLabels) {
            const tp = CASES.filter(
                (c) => c.expected === label && classifyTool(c.input) === label,
            ).length;
            const fp = CASES.filter(
                (c) => c.expected !== label && classifyTool(c.input) === label,
            ).length;
            const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
            expect(precision).toBeGreaterThanOrEqual(0.95);
        }
    });

    it("rankToolCandidates returns ordered list", () => {
        const ranked = rankToolCandidates("show my open orders please");
        expect(ranked[0]).toBe("get_orders");
    });
});
