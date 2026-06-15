import {
    addAllowedAssetAction,
    addBlockedAssetAction,
    listAssetListsAction,
    removeAllowedAssetAction,
    removeBlockedAssetAction,
} from "./assetLists";
import { compileStrategyAction } from "./compileStrategy";
import { createTradeAction } from "./shared";
import { getOrderbookAction } from "./getOrderbook";
import { getPnlAction } from "./getPnl";
import { getPositionsAction } from "./getPositions";
import { getTickerAction } from "./getTicker";
import { getTradingModeAction } from "./getTradingMode";
import {
    armStrategyAction,
    pauseStrategyAction,
    resumeStrategyAction,
    stopStrategyAction,
    listStrategiesAction,
} from "./strategyLifecycle";
import { runBacktestAction } from "./runBacktest";
import { setTradingModeAction } from "./setTradingMode";
import {
    getBalanceErrorTemplate,
    getCancelOrderErrorTemplate,
    getCreateOrderErrorTemplate,
    getFillsErrorTemplate,
    getOrdersErrorTemplate,
} from "../templates/error";
import {
    getBalanceOutputTemplate,
    getCancelOrderOutputTemplate,
    getCreateOrderOutputTemplate,
    getFillsOutputTemplate,
    getOrdersOutputTemplate,
} from "../templates/output";
import {
    validateCancelOrderParams,
    validateCreateOrderParams,
    validateGetBalanceParams,
    validateGetFillsParams,
    validateGetOrdersParams,
} from "./shared";

// Action definitions stay declarative here.
// The shared wrapper owns service init, execution flow, and response formatting.
export const getBalanceAction = createTradeAction({
    name: "get_balance",
    description: "Get balances from a supported exchange account.",
    validateParams: validateGetBalanceParams,
    handler: (service, params) => service.accounts.getBalance(params),
    outputTemplate: getBalanceOutputTemplate,
    errorTemplate: getBalanceErrorTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Show my Coinbase balances" },
            },
            {
                user: "{{user2}}",
                content: { text: "Fetching Coinbase balances now.", action: "get_balance" },
            },
        ],
    ],
});

export const getOrdersAction = createTradeAction({
    name: "get_orders",
    description: "Get open or historical orders from a supported exchange.",
    validateParams: validateGetOrdersParams,
    handler: (service, params) => service.orders.getOrders(params),
    outputTemplate: getOrdersOutputTemplate,
    errorTemplate: getOrdersErrorTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Get my recent Coinbase BTC-USD orders" },
            },
            {
                user: "{{user2}}",
                content: { text: "Pulling the Coinbase order history.", action: "get_orders" },
            },
        ],
    ],
});

export const createOrderAction = createTradeAction({
    name: "create_order",
    description: "Create a market, limit, or stop-limit order on a supported exchange.",
    validateParams: validateCreateOrderParams,
    handler: (service, params) => service.orders.createOrder(params),
    outputTemplate: getCreateOrderOutputTemplate,
    errorTemplate: getCreateOrderErrorTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Buy 0.001 BTC on Coinbase at market" },
            },
            {
                user: "{{user2}}",
                content: { text: "Submitting the order to Coinbase.", action: "create_order" },
            },
        ],
    ],
});

export const cancelOrderAction = createTradeAction({
    name: "cancel_order",
    description: "Cancel one or more open orders on a supported exchange.",
    validateParams: validateCancelOrderParams,
    handler: (service, params) => service.orders.cancelOrder(params),
    outputTemplate: getCancelOrderOutputTemplate,
    errorTemplate: getCancelOrderErrorTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Cancel my Coinbase order 12345" },
            },
            {
                user: "{{user2}}",
                content: { text: "Canceling that Coinbase order now.", action: "cancel_order" },
            },
        ],
    ],
});

export const getFillsAction = createTradeAction({
    name: "get_fills",
    description: "Get fills or trade executions from a supported exchange.",
    validateParams: validateGetFillsParams,
    handler: (service, params) => service.orders.getFills(params),
    outputTemplate: getFillsOutputTemplate,
    errorTemplate: getFillsErrorTemplate,
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Show my latest Coinbase fills" },
            },
            {
                user: "{{user2}}",
                content: { text: "Fetching Coinbase fills.", action: "get_fills" },
            },
        ],
    ],
});

export const tradeActions = [
    getBalanceAction,
    getOrdersAction,
    createOrderAction,
    cancelOrderAction,
    getFillsAction,
    // Phase 4-5 — strategy + backtest + mode toggle. These do NOT
    // require venue credentials; they operate against the user's
    // preferences + the strategy DSL stack inside plugin-cex.
    compileStrategyAction,
    runBacktestAction,
    setTradingModeAction,
    getTradingModeAction,
    // Fix 8 — user-editable asset allowlist + blocklist.
    addBlockedAssetAction,
    removeBlockedAssetAction,
    addAllowedAssetAction,
    removeAllowedAssetAction,
    listAssetListsAction,
    // Fix 13 — per-position view + PnL across futures / margin.
    getPositionsAction,
    getPnlAction,
    // Fix 15 — instant ticker + order-book lookup. READ-ONLY; backed
    // by Binance's PUBLIC endpoints so no user creds are required for
    // the static-default path.
    getTickerAction,
    getOrderbookAction,
    // StrategyEngineService control surface (paper-only auto-execution).
    armStrategyAction,
    pauseStrategyAction,
    resumeStrategyAction,
    stopStrategyAction,
    listStrategiesAction,
];

export {
    addBlockedAssetAction,
    removeBlockedAssetAction,
    addAllowedAssetAction,
    removeAllowedAssetAction,
    listAssetListsAction,
};
