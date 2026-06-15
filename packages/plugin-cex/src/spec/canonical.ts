import type {
    CEXActionSchema,
    CEXCanonicalExchangeCapabilities,
    CEXCanonicalSpec,
    cexParamDef,
} from "@elizaos/core";

const INJECTED_USER_ID_PARAM: cexParamDef = {
    type: "string",
    required: true,
    injected: true,
    description: "User id for resolving exchange credentials (injected by the system).",
};

const INJECTED_EXCHANGE_PARAM: cexParamDef = {
    type: "string",
    required: true,
    injected: true,
    description: "Resolved default exchange id (injected by the system).",
};

const ORDER_END_TIME_FIELD: cexParamDef = {
    type: "string",
    required: true,
    description: "Order expiration time (UTC, ISO 8601).",
    format: "iso8601",
    uiControl: "datetime",
    uiConstraints: { minNow: true },
};

const ORDER_CONFIGURATION_PROPERTIES: Record<string, cexParamDef> = {
    market_market_ioc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Market IOC order config.",
        uiLabel: "Market (IOC)",
        properties: {
            base_size: { type: "string", required: "required if quote_size is not provided", description: "Base size." },
            quote_size: { type: "string", required: "required if base_size is not provided", description: "Quote size." },
        },
    },
    market_market_fok: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Market FOK order config.",
        uiLabel: "Market (FOK)",
        properties: {
            base_size: { type: "string", required: "required if quote_size is not provided", description: "Base size." },
            quote_size: { type: "string", required: "required if base_size is not provided", description: "Quote size." },
        },
    },
    limit_limit_gtc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Limit GTC order config.",
        uiLabel: "Limit (GTC)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            limit_price: { type: "string", required: true, description: "Limit price." },
            post_only: { type: "boolean", required: false, description: "Post-only flag." },
            iceberg_qty: {
                type: "string",
                required: false,
                description:
                    "Iceberg visible quantity (Binance Spot LIMIT GTC only). Hides remainder of the order from the book.",
            },
        },
    },
    limit_limit_gtd: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Limit GTD order config.",
        uiLabel: "Limit (GTD)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            limit_price: { type: "string", required: true, description: "Limit price." },
            end_time: ORDER_END_TIME_FIELD,
            post_only: { type: "boolean", required: false, description: "Post-only flag." },
            iceberg_qty: {
                type: "string",
                required: false,
                description: "Iceberg visible quantity (LIMIT GTD only).",
            },
        },
    },
    sor_limit_ioc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "SOR Limit IOC order config.",
        uiLabel: "Limit (IOC, routed)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            limit_price: { type: "string", required: true, description: "Limit price." },
        },
    },
    stop_limit_stop_limit_gtc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Stop-limit GTC order config.",
        uiLabel: "Stop-Limit (GTC)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            stop_price: { type: "string", required: true, description: "Stop trigger price." },
            limit_price: { type: "string", required: true, description: "Limit price." },
            stop_direction: {
                type: "enum",
                required: false,
                description: "Stop direction.",
                enum: ["STOP_DIRECTION_STOP_UP", "STOP_DIRECTION_STOP_DOWN"],
            },
        },
    },
    stop_limit_stop_limit_gtd: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Stop-limit GTD order config.",
        uiLabel: "Stop-Limit (GTD)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            stop_price: { type: "string", required: true, description: "Stop trigger price." },
            limit_price: { type: "string", required: true, description: "Limit price." },
            end_time: ORDER_END_TIME_FIELD,
            stop_direction: {
                type: "enum",
                required: false,
                description: "Stop direction.",
                enum: ["STOP_DIRECTION_STOP_UP", "STOP_DIRECTION_STOP_DOWN"],
            },
        },
    },
    limit_limit_fok: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Limit FOK order config.",
        uiLabel: "Limit (FOK)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size." },
            limit_price: { type: "string", required: true, description: "Limit price." },
        },
    },
    trigger_bracket_gtc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Trigger bracket GTC order config.",
        uiLabel: "Bracket (GTC)",
        properties: {
            limit_price: { type: "string", required: true, description: "Take-profit limit price." },
            stop_trigger_price: { type: "string", required: true, description: "Stop-loss trigger price." },
        },
    },
    trigger_bracket_gtd: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description: "Trigger bracket GTD order config.",
        uiLabel: "Bracket (GTD)",
        properties: {
            limit_price: { type: "string", required: true, description: "Take-profit limit price." },
            stop_trigger_price: { type: "string", required: true, description: "Stop-loss trigger price." },
            end_time: ORDER_END_TIME_FIELD,
        },
    },
    trailing_stop_limit_gtc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description:
            "Trailing-stop limit (basis-point trail). The trail moves with the market; on reversal it triggers a STOP_LIMIT exit.",
        uiLabel: "Trailing Stop",
        properties: {
            base_size: { type: "string", required: true, description: "Base size to sell/buy when the trail is hit." },
            trailing_delta_bps: {
                type: "number",
                required: true,
                description:
                    "Trail distance in basis points (1..2000). 100 bps = 1%. Required by Binance Spot trailing orders.",
            },
            activation_price: {
                type: "string",
                required: false,
                description: "Optional. Price at which the trail starts tracking. If omitted, trailing activates immediately.",
            },
            limit_price: {
                type: "string",
                required: false,
                description: "Optional limit price for the triggered exit; omit to use a market exit.",
            },
            stop_direction: {
                type: "enum",
                required: false,
                description: "Stop direction.",
                enum: ["STOP_DIRECTION_STOP_UP", "STOP_DIRECTION_STOP_DOWN"],
            },
        },
    },
    oco_gtc: {
        type: "object",
        required: "exactly one order_configuration variant key is required",
        description:
            "OCO (One-Cancels-the-Other). Pairs a take-profit LIMIT_MAKER (above the market) with a STOP_LOSS_LIMIT (below the market). When one fills, the other cancels.",
        uiLabel: "OCO (TP + SL)",
        properties: {
            base_size: { type: "string", required: true, description: "Base size for both legs." },
            above_limit_price: { type: "string", required: true, description: "Take-profit LIMIT_MAKER price (above market)." },
            below_stop_price: { type: "string", required: true, description: "Stop-loss trigger price (below market)." },
            below_limit_price: { type: "string", required: true, description: "Stop-loss LIMIT price." },
            below_time_in_force: {
                type: "enum",
                required: false,
                description: "Time-in-force for the stop-loss leg.",
                enum: ["GTC", "IOC", "FOK"],
            },
        },
    },
};

export const CEX_ACTION_SCHEMAS: Record<string, CEXActionSchema> = {
    get_balance: {
        description: "Fetch balances from the exchange account.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            limit: { type: "number", required: false, description: "Max accounts to return." },
            cursor: { type: "string", required: false, description: "Pagination cursor." },
            retail_portfolio_id: { type: "string", required: false, description: "Retail portfolio id (if applicable)." },
            // Issue 4 (post-PR239 hotfix) — declaring `wallet_type` in
            // the schema is the last mile that lets the field survive
            // `sanitizeCEXParamsBySchema` on the read-only fast path.
            // Without this entry, the ADK extractor and projector both
            // set `wallet_type` correctly but the workflow handler
            // stripped it before the venue saw it, so single-action
            // "show my spot balance" queries always fanned out. The
            // enum mirrors the canonical filter values in
            // `GetBalanceParams.wallet_type` and the decomposer template
            // (`cexDecomposeTemplate.ts`).
            wallet_type: {
                type: "enum",
                required: false,
                description:
                    "Scope filter for the balance fan-out. Set 'spot' for spot-only / 'funding' for funding-only / 'margin_cross' for cross-margin / 'margin_isolated' for isolated-margin. Omit (or 'all') to fan out across every available wallet. Mirrors the decomposer template's wallet_type rules so single-action and multi-step plans produce identical venue calls.",
                enum: ["spot", "funding", "margin_cross", "margin_isolated", "all"],
            },
        },
    },
    get_orders: {
        description: "Fetch open or historical orders from the exchange.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            order_ids: { type: "array", itemsType: "string", required: false, description: "Filter by order ids." },
            product_ids: { type: "array", itemsType: "string", required: false, description: "Filter by product ids." },
            order_status: { type: "array", itemsType: "string", required: false, description: "Filter by order status values." },
            limit: { type: "number", required: false, description: "Max orders to return." },
            cursor: { type: "string", required: false, description: "Pagination cursor." },
            start_date: {
                type: "string",
                required: false,
                description: "Start date/time (ISO 8601).",
                format: "iso8601",
                uiControl: "datetime",
                uiConstraints: { maxFromField: "end_date" },
            },
            end_date: {
                type: "string",
                required: false,
                description: "End date/time (ISO 8601).",
                format: "iso8601",
                uiControl: "datetime",
                uiConstraints: { minFromField: "start_date" },
            },
            order_side: { type: "enum", required: false, description: "Order side filter.", enum: ["BUY", "SELL"] },
            order_types: { type: "array", itemsType: "string", required: false, description: "Order type filters." },
            product_type: { type: "string", required: false, description: "Product type filter." },
            margin_type: {
                type: "enum",
                required: false,
                description:
                    "REQUIRED when the user asks about MARGIN orders. Set to 'CROSS' for any mention of 'margin orders' / 'margin position' / 'leverage' / 'borrow' / '杠杆订单' / '杠杆仓' (and the user does not explicitly say 'isolated'). Set to 'ISOLATED' only when the user explicitly says 'isolated'. LEAVE UNDEFINED for spot-order queries (no margin/leverage/borrow mention). This routes to the venue's margin open-orders endpoint instead of spot.",
                enum: ["CROSS", "ISOLATED"],
            },
            // Commit 6 (post-PR238 schema follow-up) — declare `history`
            // so the field survives `sanitizeCEXParamsBySchema`. Without
            // this, the decomposer template's `history: true` hint and
            // any LLM emission of the flag were silently stripped, so
            // "show me my recent orders" prompts that produced no date
            // window dropped into the open-orders path instead of the
            // history fan-out. Mirrors `GetOrdersParams.history`.
            history: {
                type: "boolean",
                required: false,
                description:
                    "Set true when the user asks for HISTORICAL orders (e.g. 'recent orders', 'past orders', 'order history') without specifying a date window — triggers the venue layer's historical-orders fan-out across held base assets. Leave undefined / false for open-orders queries.",
            },
        },
    },
    create_order: {
        description: "Create an order on the exchange.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            client_order_id: { type: "string", required: true, description: "Client-generated idempotency key." },
            product_id: {
                type: "string",
                required: true,
                description:
                    "Product id: hyphenated BASE-QUOTE (e.g. BTC-USDC). If the user gives base+quote in prose, infer this form—do not ask them to confirm the pair name.",
            },
            side: { type: "enum", required: true, description: "Order side.", enum: ["BUY", "SELL"] },
            order_configuration: {
                type: "object",
                required: true,
                description: "Advanced order configuration. Provide exactly one variant object.",
                properties: ORDER_CONFIGURATION_PROPERTIES,
            },
            leverage: { type: "string", required: false, description: "Leverage (if supported)." },
            margin_type: { type: "enum", required: false, description: "Margin type.", enum: ["CROSS", "ISOLATED"] },
            margin_action: {
                type: "enum",
                required: false,
                description:
                    "Margin trade mode. Mirrors Binance UI 'Normal/Borrow/Repay'. AUTO_BORROW lets the venue auto-borrow up to leverage; AUTO_REPAY repays an open margin loan with proceeds. Ignored for spot orders.",
                enum: ["NORMAL", "AUTO_BORROW", "AUTO_REPAY"],
            },
            preview_id: { type: "string", required: false, description: "Preview id (if using preview flows)." },
            retail_portfolio_id: { type: "string", required: false, description: "Retail portfolio id (if applicable)." },
        },
    },
    set_trading_mode: {
        // M5 iter7 (post-PR247): expose `mode` as a canonical parameter so
        // the modal's generic schema renderer surfaces a Mode field that
        // HumanInputDialog can read for the mode-aware title + button label.
        description: "Switch the user's default trading mode between paper (simulated), shadow (logged but not submitted), and live (real orders on the venue).",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            mode: {
                type: "string",
                required: true,
                enum: ["paper", "shadow", "live"],
                description: "Target trading mode.",
            },
        },
    },
    cancel_order: {
        description: "Cancel one or more orders on the exchange. Set order_ids to cancel specific orders, or all_open=true to cancel every currently-open order.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            // M3 iter6 (post-PR246): order_ids becomes OPTIONAL because
            // `all_open: true` bypasses the per-id list. validateApprovedActionParams
            // and the action handler enforce "one of order_ids OR all_open".
            order_ids: { type: "array", itemsType: "string", required: false, description: "Order ids to cancel. Required unless all_open=true." },
            product_id: { type: "string", required: false, description: "Optional product id (some venues require it)." },
            all_open: { type: "boolean", required: false, description: "When true, fan out cancel across every currently-open order for this user on the venue. Mutually exclusive with order_ids — supplying both is allowed but order_ids takes precedence." },
        },
    },
    get_orderbook: {
        description: "Fetch the order book (bid/ask depth) for a single trading pair.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            product_id: {
                type: "string",
                required: true,
                description:
                    "Product id to fetch. Accepts bare base assets (e.g. 'BTC' / 'ETH') — the action auto-completes to the venue-canonical pair (BTCUSDT on Binance, BTC-USDT on Coinbase). Hyphenated and concatenated forms are accepted as-is.",
            },
            depth: {
                type: "number",
                required: false,
                description: "Order book depth (number of price levels per side). Defaults to 10.",
            },
        },
    },
    get_ticker: {
        description: "Fetch ticker / 24hr stats for one or more trading pairs.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            product_ids: {
                type: "array",
                itemsType: "string",
                required: false,
                description:
                    "List of product ids. Accepts bare base assets (e.g. 'BTC') — auto-completed to venue-canonical pairs. Omit to receive the default top-symbols snapshot.",
            },
        },
    },
    get_positions: {
        description: "Fetch open positions across margin / isolated-margin / futures wallets.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            wallet_type: {
                type: "enum",
                required: false,
                description:
                    "Scope filter for the positions fan-out. 'margin_cross' / 'margin_isolated' / 'futures' for a single scope; omit (or 'all') to fan out.",
                enum: ["margin_cross", "margin_isolated", "futures", "all"],
            },
        },
    },
    get_pnl: {
        description: "Fetch realized / unrealized PnL for an optional window and scope.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            scope: {
                type: "enum",
                required: false,
                description:
                    "Filter scope: 'realized' / 'unrealized' / 'all' (default 'all').",
                enum: ["realized", "unrealized", "all"],
            },
            start_date: {
                type: "string",
                required: false,
                description: "Start date/time (ISO 8601). Default: 30 days before end_date.",
                format: "iso8601",
            },
            end_date: {
                type: "string",
                required: false,
                description: "End date/time (ISO 8601). Default: now.",
                format: "iso8601",
            },
        },
    },
    get_trading_mode: {
        description: "Report the user's current trading mode (paper / shadow / live).",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
        },
    },
    arm_strategy: {
        description: "Arm a compiled strategy for paper auto-execution (recovers the last compiled strategy).",
        // No user-editable parameters: arm always targets the user's most
        // recently compiled strategy, so the approval modal shows only the
        // confirm checkbox (no confusing empty 'instance_id' field).
        parameters: {},
    },
    pause_strategy: {
        description: "Pause a running strategy instance.",
        parameters: {
            instance_id: { type: "string", required: false, description: "Strategy instance id (optional when the user has exactly one active)." },
        },
    },
    resume_strategy: {
        description: "Resume a paused strategy instance.",
        parameters: {
            instance_id: { type: "string", required: false, description: "Strategy instance id (optional when the user has exactly one active)." },
        },
    },
    stop_strategy: {
        description: "Stop a strategy instance.",
        parameters: {
            instance_id: { type: "string", required: false, description: "Strategy instance id (optional when the user has exactly one active)." },
        },
    },
    list_strategies: {
        description: "List the user's strategies and their status (read-only).",
        parameters: {},
    },
    get_fills: {
        description: "Fetch fills/trade executions from the exchange.",
        parameters: {
            userId: INJECTED_USER_ID_PARAM,
            exchange: INJECTED_EXCHANGE_PARAM,
            order_ids: { type: "array", itemsType: "string", required: false, description: "Filter by order ids." },
            trade_ids: { type: "array", itemsType: "string", required: false, description: "Filter by trade ids." },
            product_ids: { type: "array", itemsType: "string", required: false, description: "Filter by product ids." },
            limit: { type: "number", required: false, description: "Max fills to return." },
            cursor: { type: "string", required: false, description: "Pagination cursor." },
            start_sequence_timestamp: {
                type: "string",
                required: false,
                description: "Start timestamp (ISO 8601).",
                format: "iso8601",
                uiControl: "datetime",
                uiConstraints: { maxFromField: "end_sequence_timestamp" },
            },
            end_sequence_timestamp: {
                type: "string",
                required: false,
                description: "End timestamp (ISO 8601).",
                format: "iso8601",
                uiControl: "datetime",
                uiConstraints: { minFromField: "start_sequence_timestamp" },
            },
            retail_portfolio_id: { type: "string", required: false, description: "Retail portfolio id (if applicable)." },
        },
    },
};

export const CEX_EXCHANGE_CAPABILITIES: Record<string, CEXCanonicalExchangeCapabilities> = {
    coinbase: {
        exchange: "coinbase",
        actions: {
            get_orders: { requiresProductIdsWithOrderIds: false },
            get_fills: { requiresProductIds: false },
            cancel_order: { requiresProductIdFallback: false },
            create_order: {
                unsupportedOrderConfigurationVariants: [],
                quoteSizeOnlyForMarketIoc: false,
                postOnlyOnlyForLimitGtc: false,
            },
        },
    },
    binance: {
        exchange: "binance",
        actions: {
            get_orders: { requiresProductIdsWithOrderIds: true },
            // CEX post-PR237 Commit 6 — Binance `get_fills` now
            // supports a fan-out path that enumerates the user's
            // currently-held base assets and queries `spot.myTrades`
            // per candidate pair (`fanOutFills`). Previously this
            // capability flag threw `"product_ids" is required` BEFORE
            // the fan-out could run, which produced a confusing error
            // for the "show my trade history" prompt. Flipping to
            // `false` lets the venue layer trigger the fan-out as
            // designed.
            get_fills: { requiresProductIds: false },
            cancel_order: { requiresProductIdFallback: true },
            create_order: {
                unsupportedOrderConfigurationVariants: [
                    "market_market_fok",
                    "sor_limit_ioc",
                    "trigger_bracket_gtc",
                    "trigger_bracket_gtd",
                ],
                quoteSizeOnlyForMarketIoc: true,
                postOnlyOnlyForLimitGtc: true,
            },
        },
    },
};

export function getCEXCanonicalSpec(): CEXCanonicalSpec {
    return {
        version: "1.0.0",
        schemas: CEX_ACTION_SCHEMAS,
        capabilities: CEX_EXCHANGE_CAPABILITIES,
    };
}

export function getCEXActionSchema(actionName: string): CEXActionSchema | undefined {
    return CEX_ACTION_SCHEMAS[actionName];
}

/**
 * Schema for the human-approval UI. Both Binance and Coinbase now expose
 * the full create_order shape, including `margin_type`, `leverage`, and
 * `margin_action`. Live Binance margin execution is gated downstream
 * (`BinanceOrdersService.createOrder` -> `throwMarginNotImplemented`)
 * until the `/sapi/v1/margin/order` endpoint is wired up.
 */
export function getCEXActionSchemaForApproval(
    actionName: string,
    _exchange: string | null | undefined,
): CEXActionSchema | undefined {
    return CEX_ACTION_SCHEMAS[actionName];
}

function formatNestedParamLine(indent: string, paramKey: string, def: cexParamDef): string {
    const reqLabel =
        def.injected === true
            ? "injected"
            : def.required === true ? "required"
              : def.required === false
                ? "optional"
                : `if: ${def.required}`;
    const enumStr = def.enum ? ` — ${def.enum.map((v) => `"${v}"`).join(" | ")}` : "";
    const itemsStr = def.type === "array" && def.itemsType ? ` — items: ${def.itemsType}` : "";
    return `${indent}- ${paramKey} [${reqLabel}]${enumStr}${itemsStr}`;
}

/** Expands `order_configuration` variant keys and inner fields for the LLM. */
function formatOrderConfigurationForLLM(def: cexParamDef): string[] {
    const out: string[] = [];
    const props = def.properties;
    if (!props || def.type !== "object") return out;
    out.push(
        "    - Structure: a JSON object with exactly ONE top-level key (the variant id). Example: `{ \"limit_limit_gtc\": { \"base_size\": \"0.01\", \"limit_price\": \"95000\" } }`"
    );
    for (const [variantKey, variantDef] of Object.entries(props)) {
        const label = variantDef.uiLabel ? ` — ${variantDef.uiLabel}` : "";
        out.push(`    - Variant key \`${variantKey}\`${label}`);
        const inner = variantDef.properties;
        if (inner) {
            for (const [innerKey, innerDef] of Object.entries(inner)) {
                out.push(formatNestedParamLine("        ", innerKey, innerDef));
            }
        }
    }
    return out;
}

export function formatCEXActionForLLM(
    actionName: string,
    schemas: Record<string, CEXActionSchema>,
    runtimeDescription?: string
): string {
    const schema = schemas[actionName];
    if (!schema) {
        return `**${actionName}**: ${runtimeDescription ?? ""}`;
    }
    const lines: string[] = [];
    for (const [key, def] of Object.entries(schema.parameters)) {
        const reqLabel =
            def.injected === true
                ? "injected"
                : def.required === true
                  ? "required"
                  : def.required === false
                    ? "optional"
                    : `if: ${def.required}`;
        const enumStr = def.enum ? ` — ${def.enum.map((v) => `"${v}"`).join(" | ")}` : "";
        const itemsStr = def.type === "array" && def.itemsType ? ` — items: ${def.itemsType}` : "";

        if (key === "order_configuration" && def.type === "object" && def.properties && Object.keys(def.properties).length > 0) {
            lines.push(`  - ${key} [${reqLabel}] — advanced order shape; see variant keys below`);
            lines.push(...formatOrderConfigurationForLLM(def));
            continue;
        }

        // Include the human description when present so the LLM has the
        // semantic hint needed to extract domain-specific params. Without
        // this, fields like `margin_type` showed up to the model as just
        // `margin_type [optional] — "CROSS" | "ISOLATED"` with no signal
        // that "margin orders" in prose should map to it — staging
        // CloudWatch confirmed the LLM hit the spot endpoint even after
        // the schema field was added.
        const descSuffix = def.description ? `  // ${def.description}` : "";
        lines.push(`  - ${key} [${reqLabel}]${enumStr}${itemsStr}${descSuffix}`);
    }
    return `**${actionName}**: ${schema.description}\n${lines.join("\n")}`;
}

function selectedOrderVariant(orderConfiguration: unknown): string | undefined {
    if (!orderConfiguration || typeof orderConfiguration !== "object" || Array.isArray(orderConfiguration)) return undefined;
    const variants = Object.keys(orderConfiguration as Record<string, unknown>);
    return variants.length === 1 ? variants[0] : undefined;
}

export function preflightValidateForExchange(actionName: string, params: Record<string, unknown>): void {
    const exchange = typeof params.exchange === "string" ? params.exchange.toLowerCase() : undefined;
    if (!exchange) return;
    const capability = CEX_EXCHANGE_CAPABILITIES[exchange];
    if (!capability) return;

    if (actionName === "get_orders" && capability.actions.get_orders?.requiresProductIdsWithOrderIds) {
        const orderIds = Array.isArray(params.order_ids) ? params.order_ids : [];
        const productIds = Array.isArray(params.product_ids) ? params.product_ids : [];
        if (orderIds.length > 0 && productIds.length === 0) {
            throw new Error(`"product_ids" is required for ${exchange} when "order_ids" are provided`);
        }
    }

    if (actionName === "get_fills" && capability.actions.get_fills?.requiresProductIds) {
        const productIds = Array.isArray(params.product_ids) ? params.product_ids : [];
        if (productIds.length === 0) {
            throw new Error(`"product_ids" is required for ${exchange} get_fills requests`);
        }
    }

    if (actionName === "cancel_order" && capability.actions.cancel_order?.requiresProductIdFallback) {
        // M4b iter7 (post-PR247): the preflight blocked explicit-id
        // cancels with the "trading pair required" message even though
        // BinanceOrdersService.cancelOrder already maps order_id →
        // symbol via the current open-orders snapshot. That snapshot
        // is fetched at execute time and handles per-id symbol lookup
        // for all CURRENTLY OPEN orders. The check is only meaningful
        // when the user supplies neither order_ids NOR all_open, which
        // is already covered by the validators.
        // M3 iter6 also added `all_open: true` which bypasses this
        // entirely (fan-out reads symbols from the snapshot).
        const orderIds = Array.isArray(params.order_ids) ? params.order_ids : [];
        const allOpen = params.all_open === true || params.all_open === "true";
        const productId = typeof params.product_id === "string" ? params.product_id.trim() : "";
        // Only throw when there are NO ids AND no all_open flag (truly nothing to cancel).
        if (orderIds.length === 0 && !allOpen && productId.length === 0) {
            throw new Error(
                `${exchange} cancel_order requires either order_ids, all_open=true, or a product_id. Please rephrase.`,
            );
        }
    }

    if (actionName === "create_order") {
        const createCaps = capability.actions.create_order;
        if (!createCaps) return;
        const variant = selectedOrderVariant(params.order_configuration);
        if (!variant) return;
        if (createCaps.unsupportedOrderConfigurationVariants.includes(variant)) {
            throw new Error(`"order_configuration.${variant}" is not supported for ${exchange} create_order`);
        }
        const payload = (params.order_configuration as Record<string, Record<string, unknown>>)[variant];
        const quoteSize = payload?.quote_size;
        if (createCaps.quoteSizeOnlyForMarketIoc && variant !== "market_market_ioc" && typeof quoteSize === "string" && quoteSize.trim().length > 0) {
            throw new Error(`"order_configuration.${variant}.quote_size" is not supported for ${exchange}`);
        }
        const postOnly = payload?.post_only;
        if (createCaps.postOnlyOnlyForLimitGtc && postOnly === true && variant !== "limit_limit_gtc") {
            throw new Error(`"order_configuration.${variant}.post_only" is not supported for ${exchange}`);
        }

        const marginAction = typeof params.margin_action === "string" ? params.margin_action.toUpperCase() : undefined;
        if (marginAction && !["NORMAL", "AUTO_BORROW", "AUTO_REPAY"].includes(marginAction)) {
            throw new Error(`"margin_action" must be one of NORMAL, AUTO_BORROW, AUTO_REPAY (got "${params.margin_action}")`);
        }
        const marginType = typeof params.margin_type === "string" ? params.margin_type.toUpperCase() : undefined;
        if (marginAction && marginAction !== "NORMAL" && !marginType) {
            throw new Error(`"margin_action=${marginAction}" requires "margin_type" (CROSS or ISOLATED)`);
        }
    }
}

/**
 * Recursively normalizes any `symbol` / `product_id` field value in a
 * venue response payload to the canonical hyphenated form
 * (e.g., "BTCUSDT" → "BTC-USDT"). This is the single point of
 * standardization for chat-output and ledger storage. Venue REST
 * adapters denormalize back when needed.
 */
function normalizeSymbolFieldsInPlace(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map(normalizeSymbolFieldsInPlace);
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (
                (k === "symbol" || k === "product_id" || k === "productId") &&
                typeof v === "string" &&
                v.length > 0
            ) {
                out[k] = canonicalizeSymbol(v);
            } else {
                out[k] = normalizeSymbolFieldsInPlace(v);
            }
        }
        return out;
    }
    return value;
}

const QUOTE_SUFFIXES_LOCAL = [
    "USDC", "USDT", "FDUSD", "TUSD", "BUSD", "USDP", "USDD", "DAI", "PYUSD",
    "USDE", "USD", "EUR", "GBP", "JPY", "TRY", "BRL", "AUD", "CAD",
] as const;

function canonicalizeSymbol(raw: string): string {
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return trimmed;
    if (trimmed.includes("-")) return trimmed.replace(/\//g, "-").replace(/_/g, "-");
    for (const q of QUOTE_SUFFIXES_LOCAL) {
        if (trimmed.endsWith(q) && trimmed.length > q.length) {
            const base = trimmed.slice(0, -q.length);
            if (/^[A-Z0-9]+$/.test(base)) return `${base}-${q}`;
        }
    }
    return trimmed;
}

export function normalizeCEXResultEnvelope(
    exchange: string,
    action: string,
    rawResult: unknown
): Record<string, unknown> {
    return {
        exchange,
        action,
        status: "ok",
        result: normalizeSymbolFieldsInPlace(rawResult),
    };
}

export function normalizeCEXErrorEnvelope(
    exchange: string | undefined,
    action: string,
    error: unknown
): { exchange?: string; action: string; status: "error"; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    return {
        exchange,
        action,
        status: "error",
        message,
    };
}
