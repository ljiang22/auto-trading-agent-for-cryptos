/**
 * Human-editable trading prod case catalog.
 * Edit here → run `pnpm test:trading-prod:generate`
 */

import {
    BINANCE_SUPPORTED_VARIANTS,
    BINANCE_UNSUPPORTED_VARIANTS,
    EXCHANGE,
    PRODUCT_ID,
    PLACEHOLDER_ORDER_ID_A,
    PLACEHOLDER_ORDER_ID_B,
    buildAmendOrderCompose,
    buildCancelOrderCompose,
    buildComposeFromParams,
    buildCreateOrderCompose,
    buildCreateOrderNlText,
    buildGetBalanceNlText,
    buildGetFillsNlText,
    buildGetOrderbookNlText,
    buildGetOrdersNlText,
    buildGetPnlNlText,
    buildGetPositionsNlText,
    buildGetTickerNlText,
    buildGetTradingModeNlText,
    buildListAssetListsNlText,
    buildOrderConfiguration,
    buildPreviewOrderCompose,
    buildSetTradingModeCompose,
    approvalTemplateKeyForCase,
    quoteSize6,
} from "../../lib/tradingFixtures.mjs";

const READ_ONLY_ROWS = [
    {
        id: "ro-balance",
        action: "get_balance",
        title: "Spot + margin balances",
        text: buildGetBalanceNlText(),
    },
    {
        id: "ro-balance-spot",
        action: "get_balance",
        title: "Spot balances only",
        text: buildGetBalanceNlText({ walletType: "spot" }),
    },
    {
        id: "ro-balance-margin-cross",
        action: "get_balance",
        title: "Cross margin balances",
        text: buildGetBalanceNlText({ walletType: "margin_cross" }),
    },
    {
        id: "ro-orders",
        action: "get_orders",
        title: "Open orders",
        text: buildGetOrdersNlText(),
    },
    {
        id: "ro-orders-margin-cross",
        action: "get_orders",
        title: "Cross margin open orders",
        text: buildGetOrdersNlText({ marginType: "CROSS" }),
    },
    {
        id: "ro-orders-history",
        action: "get_orders",
        title: "Order history",
        text: buildGetOrdersNlText({ history: true }),
    },
    {
        id: "ro-fills",
        action: "get_fills",
        title: "Recent fills",
        text: buildGetFillsNlText(),
    },
    {
        id: "ro-fills-by-order",
        action: "get_fills",
        title: "Fills by order id",
        text: buildGetFillsNlText({ orderId: PLACEHOLDER_ORDER_ID_A }),
    },
    {
        id: "ro-ticker",
        action: "get_ticker",
        title: "Ticker",
        text: buildGetTickerNlText(),
    },
    {
        id: "ro-orderbook",
        action: "get_orderbook",
        title: "Order book",
        text: buildGetOrderbookNlText(),
    },
    {
        id: "ro-positions",
        action: "get_positions",
        title: "Margin positions",
        text: buildGetPositionsNlText(),
    },
    {
        id: "ro-pnl",
        action: "get_pnl",
        title: "Realized PnL",
        text: buildGetPnlNlText(),
    },
    {
        id: "ro-pnl-realized",
        action: "get_pnl",
        title: "Realized PnL scoped",
        text: buildGetPnlNlText({ scope: "realized" }),
    },
    {
        id: "ro-trading-mode",
        action: "get_trading_mode",
        title: "Trading mode",
        text: buildGetTradingModeNlText(),
    },
    {
        id: "ro-asset-lists",
        action: "list_asset_lists",
        title: "Asset lists",
        text: buildListAssetListsNlText(),
    },
];

function readOnlyEntries() {
    return READ_ONLY_ROWS.map((row) => ({
        id: row.id,
        title: row.title,
        section: "read_only",
        roomGroup: "read_only",
        tags: ["read_only", "cex", row.action],
        nl: { text: row.text },
        expect: {
            expectedActions: [row.action],
            expectActionExecution: true,
            maxDurationMs: 300_000,
        },
    }));
}

function withDialogApproval(entry) {
    return { ...entry, approvalFormat: "dialog" };
}

function spotCreateEntries() {
    const entries = [];
    for (const variant of BINANCE_SUPPORTED_VARIANTS) {
        const side = variant.includes("oco") || variant.includes("trailing") ? "SELL" : "BUY";
        const id = `spot-${variant}`;
        const compose = buildCreateOrderCompose({ variant, side, mode: "live", caseId: id });
        entries.push({
            id,
            title: `Spot create ${variant}`,
            section: "spot_create",
            roomGroup: "spot",
            tags: ["spot", "write", "live", variant],
            nl: {
                text: buildCreateOrderNlText({ variant, side }),
            },
            compose,
            approvalTemplateKey: approvalTemplateKeyForCase("spot", variant, side),
            hooks: ["cexAutoApprove"],
            expect: { stepsInclude: ["Trading: risk check"], maxDurationMs: 300_000 },
        });
        if (variant === "limit_limit_gtc") {
            const postId = "spot-limit_limit_gtc-postonly";
            const postCompose = buildCreateOrderCompose({
                variant,
                side: "SELL",
                postOnly: true,
                mode: "live",
                caseId: postId,
            });
            entries.push({
                id: postId,
                title: "Spot limit GTC post-only sell",
                section: "spot_create",
                roomGroup: "spot",
                tags: ["spot", "write", "live", variant, "post_only"],
                nl: {
                    text: buildCreateOrderNlText({
                        variant,
                        side: "SELL",
                        postOnly: true,
                    }),
                },
                compose: postCompose,
                approvalTemplateKey: approvalTemplateKeyForCase("spot", variant, "SELL"),
                hooks: ["cexAutoApprove"],
                expect: { stepsInclude: ["Trading: risk check"], maxDurationMs: 300_000 },
            });
        }
    }
    return entries.map(withDialogApproval);
}

function unsupportedEntries() {
    return BINANCE_UNSUPPORTED_VARIANTS.map((variant) => {
        const id = `spot-unsupported-${variant}`;
        const compose = buildCreateOrderCompose({
            variant,
            side: "BUY",
            mode: "live",
            caseId: id,
        });
        return {
            id,
            title: `Unsupported variant ${variant}`,
            section: "unsupported",
            roomGroup: "spot",
            tags: ["spot", "negative", "unsupported", variant],
            nl: { text: buildCreateOrderNlText({ variant, side: "BUY" }) },
            compose,
            hooks: ["cexAutoApprove"],
            expect: {
                unsupportedVariant: true,
                pass: false,
                maxDurationMs: 180_000,
            },
        };
    });
}

function marginCreateEntries() {
    const entries = [];
    const baseVariants = ["market_market_ioc", "limit_limit_gtc", "stop_limit_stop_limit_gtc"];
    const extraCrossVariants = [
        "limit_limit_fok",
        "limit_limit_gtd",
        "trailing_stop_limit_gtc",
        "oco_gtc",
    ];

    for (const marginType of ["CROSS", "ISOLATED"]) {
        const variants =
            marginType === "CROSS"
                ? [...baseVariants, ...extraCrossVariants]
                : baseVariants;

        for (const variant of variants) {
            const side =
                variant.includes("oco") || variant.includes("trailing") ? "SELL" : "BUY";
            const id = `margin-${marginType.toLowerCase()}-${variant}`;
            const compose = buildCreateOrderCompose({
                variant,
                side,
                marginType,
                mode: "live",
                caseId: id,
            });
            entries.push({
                id,
                title: `Margin ${marginType} ${variant}`,
                section: "margin_create",
                roomGroup: "margin",
                tags: ["margin", marginType.toLowerCase(), "write", "live", variant],
                nl: {
                    text: buildCreateOrderNlText({ variant, side, marginType }),
                },
                compose,
                approvalTemplateKey: approvalTemplateKeyForCase(
                    "margin",
                    variant,
                    side,
                    marginType,
                ),
                hooks: ["cexAutoApprove"],
                expect: { stepsInclude: ["Trading: risk check"], maxDurationMs: 300_000 },
            });
        }

        if (marginType === "ISOLATED") {
            const postId = "margin-isolated-limit_limit_gtc-postonly";
            const postCompose = buildCreateOrderCompose({
                variant: "limit_limit_gtc",
                side: "SELL",
                marginType: "ISOLATED",
                postOnly: true,
                mode: "live",
                caseId: postId,
            });
            entries.push({
                id: postId,
                title: "Margin ISOLATED limit GTC post-only sell",
                section: "margin_create",
                roomGroup: "margin",
                tags: ["margin", "isolated", "write", "live", "post_only"],
                nl: {
                    text: buildCreateOrderNlText({
                        variant: "limit_limit_gtc",
                        side: "SELL",
                        marginType: "ISOLATED",
                        postOnly: true,
                    }),
                },
                compose: postCompose,
                approvalTemplateKey: approvalTemplateKeyForCase(
                    "margin",
                    "limit_limit_gtc",
                    "SELL",
                    "ISOLATED",
                ),
                hooks: ["cexAutoApprove"],
                expect: { stepsInclude: ["Trading: risk check"], maxDurationMs: 300_000 },
            });
        }
    }

    const autoBorrowId = "margin-cross-auto-borrow";
    const autoBorrowCompose = buildCreateOrderCompose({
        variant: "market_market_ioc",
        side: "BUY",
        marginType: "CROSS",
        marginAction: "AUTO_BORROW",
        mode: "live",
        caseId: autoBorrowId,
    });
    entries.push({
        id: autoBorrowId,
        title: "Margin CROSS auto-borrow market",
        section: "margin_create",
        roomGroup: "margin",
        tags: ["margin", "cross", "write", "live", "auto_borrow"],
        nl: {
            text: buildCreateOrderNlText({
                variant: "market_market_ioc",
                side: "BUY",
                marginType: "CROSS",
                marginAction: "AUTO_BORROW",
            }),
        },
        compose: autoBorrowCompose,
        approvalTemplateKey: approvalTemplateKeyForCase(
            "margin",
            "market_market_ioc",
            "BUY",
            "CROSS",
        ),
        hooks: ["cexAutoApprove"],
        expect: { stepsInclude: ["Trading: risk check"], maxDurationMs: 300_000 },
    });

    return entries.map(withDialogApproval);
}

function writeExpansionEntries() {
    const previewCompose = buildPreviewOrderCompose({
        variant: "market_market_ioc",
        side: "BUY",
        caseId: "preview-spot-market",
    });
    const amendCompose = buildAmendOrderCompose({
        orderId: PLACEHOLDER_ORDER_ID_A,
        newLimitPrice: "51000",
    });
    const cancelByIdsCompose = buildCancelOrderCompose({
        caseId: "cancel-by-ids",
        allOpen: false,
        orderIds: [PLACEHOLDER_ORDER_ID_A, PLACEHOLDER_ORDER_ID_B],
    });

    return [
        withDialogApproval({
            id: "preview-spot-market",
            title: "Preview market buy",
            section: "preview",
            roomGroup: "spot",
            tags: ["spot", "preview", "read_only_stake"],
            nl: { text: previewCompose.previewText },
            compose: previewCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                expectedActions: ["preview_order"],
                maxDurationMs: 180_000,
            },
        }),
        {
            id: "amend-spot-limit",
            title: "Amend limit order",
            section: "amend",
            roomGroup: "spot",
            tags: ["spot", "amend", "write"],
            nl: { text: amendCompose.previewText },
            compose: amendCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                expectedActions: ["amend_order"],
                maxDurationMs: 180_000,
            },
        },
        withDialogApproval({
            id: "cancel-by-ids",
            title: "Cancel by order ids",
            section: "cancel",
            roomGroup: "spot",
            tags: ["cancel", "write", "live", "by_ids"],
            nl: { text: cancelByIdsCompose.previewText },
            compose: cancelByIdsCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                expectedActions: ["cancel_order"],
                maxDurationMs: 180_000,
            },
        }),
    ];
}

function tradingModeEntries() {
    const setPaperCompose = buildSetTradingModeCompose({ mode: "paper" });
    const setLiveCompose = buildSetTradingModeCompose({ mode: "live" });
    return [
        {
            id: "set-trading-mode-paper",
            title: "Set trading mode paper",
            section: "trading_mode",
            roomGroup: "read_only",
            tags: ["trading_mode", "write", "set_mode"],
            nl: { text: setPaperCompose.previewText },
            compose: setPaperCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                expectedActions: ["set_trading_mode"],
                maxDurationMs: 120_000,
            },
        },
        {
            id: "set-trading-mode-live",
            title: "Restore trading mode live",
            section: "trading_mode",
            roomGroup: "read_only",
            tags: ["trading_mode", "write", "set_mode", "restore"],
            nl: { text: setLiveCompose.previewText },
            compose: setLiveCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                expectedActions: ["set_trading_mode"],
                maxDurationMs: 120_000,
            },
        },
    ];
}

function rejectionEntries() {
    const spotCompose = buildCreateOrderCompose({
        variant: "market_market_ioc",
        side: "BUY",
        mode: "live",
        caseId: "spot-reject-l1",
    });
    const marginCompose = buildCreateOrderCompose({
        variant: "limit_limit_gtc",
        side: "BUY",
        marginType: "CROSS",
        mode: "live",
        caseId: "margin-reject-l1",
    });
    return [
        {
            id: "spot-reject-l1",
            title: "Spot L1 approval rejection",
            section: "rejection",
            roomGroup: "spot",
            tags: ["spot", "rejection", "approval"],
            nl: {
                text: buildCreateOrderNlText({
                    variant: "market_market_ioc",
                    side: "BUY",
                }),
            },
            compose: spotCompose,
            approvalTemplateKey: approvalTemplateKeyForCase("spot", "market_market_ioc", "BUY"),
            hooks: ["cexAutoReject"],
            approvalDecision: "rejected",
            expect: { approvalRejected: true, maxDurationMs: 180_000 },
        },
        {
            id: "margin-reject-l1",
            title: "Margin L1 approval rejection",
            section: "rejection",
            roomGroup: "margin",
            tags: ["margin", "rejection", "approval"],
            nl: {
                text: buildCreateOrderNlText({
                    variant: "limit_limit_gtc",
                    side: "BUY",
                    marginType: "CROSS",
                }),
            },
            compose: marginCompose,
            approvalTemplateKey: approvalTemplateKeyForCase(
                "margin",
                "limit_limit_gtc",
                "BUY",
                "CROSS",
            ),
            hooks: ["cexAutoReject"],
            approvalDecision: "rejected",
            expect: { approvalRejected: true, maxDurationMs: 180_000 },
        },
    ];
}

function riskDenyEntries() {
    const riskMaxCompose = buildComposeFromParams("create_order", {
        exchange: EXCHANGE,
        product_id: PRODUCT_ID,
        side: "BUY",
        mode: "live",
        order_configuration: { market_market_ioc: { quote_size: "2000.00" } },
        client_order_id: "harness-risk-max-size",
    });
    const riskLunaCompose = buildComposeFromParams("create_order", {
        exchange: EXCHANGE,
        product_id: "LUNA-USDT",
        side: "BUY",
        mode: "live",
        order_configuration: { market_market_ioc: { quote_size: quoteSize6() } },
        client_order_id: "harness-risk-luna",
    });
    const riskMinCompose = buildComposeFromParams("create_order", {
        exchange: EXCHANGE,
        product_id: PRODUCT_ID,
        side: "BUY",
        mode: "live",
        order_configuration: {
            limit_limit_gtc: { base_size: "0", limit_price: "50000" },
        },
        client_order_id: "harness-risk-min-size",
    });
    const riskLeverageCompose = buildComposeFromParams("create_order", {
        exchange: EXCHANGE,
        product_id: PRODUCT_ID,
        side: "BUY",
        mode: "live",
        margin_type: "CROSS",
        margin_action: "NORMAL",
        leverage: "20",
        order_configuration: buildOrderConfiguration("market_market_ioc", {
            side: "BUY",
        }),
        client_order_id: "harness-risk-leverage",
    });

    return [
        {
            id: "risk-max-order-size",
            title: "Risk deny: max order size",
            section: "risk_deny",
            roomGroup: "spot",
            tags: ["spot", "risk_deny", "maxOrderSize"],
            nl: { text: riskMaxCompose.previewText },
            compose: riskMaxCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                riskDecision: "deny",
                riskDecisionOptional: true,
                stepsInclude: ["Trading: risk check"],
                maxDurationMs: 180_000,
            },
        },
        {
            id: "risk-asset-allowlist",
            title: "Risk deny: asset allowlist",
            section: "risk_deny",
            roomGroup: "spot",
            tags: ["spot", "risk_deny", "assetAllowlist"],
            nl: { text: riskLunaCompose.previewText },
            compose: riskLunaCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                riskDecision: "deny",
                riskDecisionOptional: true,
                stepsInclude: ["Trading: risk check"],
                maxDurationMs: 180_000,
            },
        },
        {
            id: "risk-min-order-size",
            title: "Risk deny: min order size",
            section: "risk_deny",
            roomGroup: "spot",
            tags: ["spot", "risk_deny", "minOrderSize"],
            nl: { text: riskMinCompose.previewText },
            compose: riskMinCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                riskDecision: "deny",
                riskDecisionOptional: true,
                stepsInclude: ["Trading: risk check"],
                maxDurationMs: 180_000,
            },
        },
        {
            id: "risk-leverage-cap",
            title: "Risk deny: leverage cap",
            section: "risk_deny",
            roomGroup: "margin",
            tags: ["margin", "risk_deny", "leverageCap"],
            nl: { text: riskLeverageCompose.previewText },
            compose: riskLeverageCompose,
            hooks: ["cexAutoApprove"],
            expect: {
                riskDecision: "deny",
                riskDecisionOptional: true,
                stepsInclude: ["Trading: risk check"],
                maxDurationMs: 180_000,
            },
        },
    ];
}

function cancelEntries() {
    const compose = buildCancelOrderCompose({ caseId: "cancel-compose-all-open" });
    return [
        withDialogApproval({
            id: "cancel-nl",
            title: "Cancel all open (NL)",
            section: "cancel",
            roomGroup: "spot",
            tags: ["cancel", "write", "live"],
            nl: { text: compose.previewText },
            hooks: ["cexAutoApprove"],
            approvalTemplateKey: "cancel_all_open_btc",
            expect: {
                expectedActions: ["cancel_order"],
                expectActionExecution: true,
                maxDurationMs: 180_000,
            },
        }),
        withDialogApproval({
            id: "cancel-compose-all-open",
            title: "Cancel all open (compose)",
            section: "cancel",
            roomGroup: "spot",
            tags: ["cancel", "write", "live", "compose"],
            nl: { text: compose.previewText },
            compose,
            hooks: ["cexAutoApprove"],
            approvalTemplateKey: "cancel_all_open_btc",
            expect: {
                expectedActions: ["cancel_order"],
                expectActionExecution: true,
                maxDurationMs: 180_000,
            },
        }),
    ];
}

/** Teardown steps documented for humans — executed by teardown.mjs, not as suite cases. */
export const TEARDOWN_DOC = {
    section: "teardown",
    steps: [
        "Resolve venue order_ids for harness create_order cases (get_orders fallback)",
        "Cancel only harness-placed BTC-USDT spot orders (by order_ids)",
        "Cancel only harness-placed CROSS / ISOLATED margin orders (by order_ids)",
        "Verify harness client_order_ids are not still open (spot)",
        "Verify harness margin client_order_ids have no open positions",
    ],
};

/**
 * Maps canonical intent dimensions to catalog case ids (pre-mirror).
 */
export const CANONICAL_COVERAGE_MATRIX = [
    { action: "get_balance", dimension: "all_wallets", caseId: "ro-balance" },
    { action: "get_balance", dimension: "wallet_type=spot", caseId: "ro-balance-spot" },
    { action: "get_balance", dimension: "wallet_type=margin_cross", caseId: "ro-balance-margin-cross" },
    { action: "get_orders", dimension: "open_spot", caseId: "ro-orders" },
    { action: "get_orders", dimension: "margin_type=CROSS", caseId: "ro-orders-margin-cross" },
    { action: "get_orders", dimension: "history=true", caseId: "ro-orders-history" },
    { action: "get_fills", dimension: "recent", caseId: "ro-fills" },
    { action: "get_fills", dimension: "order_ids", caseId: "ro-fills-by-order" },
    { action: "get_ticker", dimension: "product_ids", caseId: "ro-ticker" },
    { action: "get_orderbook", dimension: "product_id", caseId: "ro-orderbook" },
    { action: "get_positions", dimension: "margin", caseId: "ro-positions" },
    { action: "get_pnl", dimension: "all", caseId: "ro-pnl" },
    { action: "get_pnl", dimension: "scope=realized", caseId: "ro-pnl-realized" },
    { action: "get_trading_mode", dimension: "read", caseId: "ro-trading-mode" },
    { action: "list_asset_lists", dimension: "read", caseId: "ro-asset-lists" },
    { action: "preview_order", dimension: "market_buy", caseId: "preview-spot-market" },
    { action: "amend_order", dimension: "limit_price", caseId: "amend-spot-limit" },
    { action: "cancel_order", dimension: "all_open", caseId: "cancel-nl" },
    { action: "cancel_order", dimension: "order_ids", caseId: "cancel-by-ids" },
    { action: "set_trading_mode", dimension: "mode=paper", caseId: "set-trading-mode-paper" },
    { action: "set_trading_mode", dimension: "mode=live", caseId: "set-trading-mode-live" },
    ...BINANCE_SUPPORTED_VARIANTS.map((variant) => ({
        action: "create_order",
        dimension: `spot/${variant}`,
        caseId: `spot-${variant}`,
    })),
    {
        action: "create_order",
        dimension: "spot/limit_limit_gtc/post_only",
        caseId: "spot-limit_limit_gtc-postonly",
    },
    ...BINANCE_UNSUPPORTED_VARIANTS.map((variant) => ({
        action: "create_order",
        dimension: `unsupported/${variant}`,
        caseId: `spot-unsupported-${variant}`,
    })),
    { action: "create_order", dimension: "margin/CROSS/auto_borrow", caseId: "margin-cross-auto-borrow" },
    {
        action: "create_order",
        dimension: "margin/ISOLATED/limit_limit_gtc/post_only",
        caseId: "margin-isolated-limit_limit_gtc-postonly",
    },
];

const WRITE_STAKE_TAG_SIGNALS = new Set([
    "write",
    "cancel",
    "rejection",
    "risk_deny",
    "amend",
    "preview",
    "set_mode",
]);

function tagWriteStakeEntries(entries) {
    return entries.map((entry) => {
        const tags = [...(entry.tags || [])];
        const isWriteStake = tags.some((t) =>
            WRITE_STAKE_TAG_SIGNALS.has(String(t).toLowerCase()),
        );
        if (!isWriteStake || tags.includes("write_stake")) {
            return entry;
        }
        return { ...entry, tags: [...tags, "write_stake"] };
    });
}

/**
 * All catalog entries (one per logical test, before implicit mirroring).
 */
export function getCatalogEntries() {
    const marginMatrix = [];
    for (const marginType of ["CROSS", "ISOLATED"]) {
        const variants =
            marginType === "CROSS"
                ? [
                      "market_market_ioc",
                      "limit_limit_gtc",
                      "stop_limit_stop_limit_gtc",
                      "limit_limit_fok",
                      "limit_limit_gtd",
                      "trailing_stop_limit_gtc",
                      "oco_gtc",
                  ]
                : ["market_market_ioc", "limit_limit_gtc", "stop_limit_stop_limit_gtc"];
        for (const variant of variants) {
            marginMatrix.push({
                action: "create_order",
                dimension: `margin/${marginType}/${variant}`,
                caseId: `margin-${marginType.toLowerCase()}-${variant}`,
            });
        }
    }

    return tagWriteStakeEntries([
        ...readOnlyEntries(),
        ...spotCreateEntries(),
        ...unsupportedEntries(),
        ...marginCreateEntries(),
        ...writeExpansionEntries(),
        ...cancelEntries(),
        ...rejectionEntries(),
        ...riskDenyEntries(),
        ...tradingModeEntries(),
    ]);
}

/** Full coverage matrix including dynamic margin rows. */
export function getCanonicalCoverageMatrix() {
    const marginRows = [];
    for (const marginType of ["CROSS", "ISOLATED"]) {
        const variants =
            marginType === "CROSS"
                ? [
                      "market_market_ioc",
                      "limit_limit_gtc",
                      "stop_limit_stop_limit_gtc",
                      "limit_limit_fok",
                      "limit_limit_gtd",
                      "trailing_stop_limit_gtc",
                      "oco_gtc",
                  ]
                : ["market_market_ioc", "limit_limit_gtc", "stop_limit_stop_limit_gtc"];
        for (const variant of variants) {
            marginRows.push({
                action: "create_order",
                dimension: `margin/${marginType}/${variant}`,
                caseId: `margin-${marginType.toLowerCase()}-${variant}`,
            });
        }
    }
    return [...CANONICAL_COVERAGE_MATRIX, ...marginRows];
}
