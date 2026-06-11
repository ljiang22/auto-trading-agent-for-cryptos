import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { OrderConfiguration } from "../../types";
import type { AdkCreateOrderInput, AdkTool } from "../types";

function buildOrderConfiguration(input: AdkCreateOrderInput): OrderConfiguration {
    const tif = input.time_in_force ?? (input.order_type === "market" ? "IOC" : "GTC");
    const sizeFields = {
        ...(input.base_size !== undefined ? { base_size: input.base_size } : {}),
        ...(input.quote_size !== undefined ? { quote_size: input.quote_size } : {}),
    };

    switch (input.order_type) {
        case "market":
            if (tif === "FOK") {
                return { market_market_fok: sizeFields };
            }
            return { market_market_ioc: sizeFields };
        case "limit": {
            const limit = {
                ...sizeFields,
                limit_price: input.limit_price ?? "",
                ...(input.post_only !== undefined ? { post_only: input.post_only } : {}),
                ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
            };
            if (tif === "IOC") return { sor_limit_ioc: limit };
            if (tif === "FOK") return { limit_limit_fok: limit };
            if (tif === "GTD") return { limit_limit_gtd: limit };
            return { limit_limit_gtc: limit };
        }
        case "stop_limit": {
            const sl = {
                ...sizeFields,
                stop_price: input.stop_price ?? "",
                limit_price: input.limit_price ?? "",
                ...(input.stop_direction !== undefined
                    ? { stop_direction: input.stop_direction }
                    : {}),
                ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
            };
            if (tif === "GTD") return { stop_limit_stop_limit_gtd: sl };
            return { stop_limit_stop_limit_gtc: sl };
        }
        case "trigger_bracket": {
            const tb = {
                limit_price: input.limit_price ?? "",
                stop_trigger_price: input.stop_trigger_price ?? "",
                ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
            };
            if (tif === "GTD") return { trigger_bracket_gtd: tb };
            return { trigger_bracket_gtc: tb };
        }
    }
}

export const createOrderTool: AdkTool<AdkCreateOrderInput> = {
    name: "create_order",
    canonicalAction: "create_order",
    stake: "write",
    description:
        "Place a market, limit, stop_limit, or trigger_bracket order. Write — gated by risk + approval.",
    buildIntent({ input, context }) {
        const orderConfiguration = buildOrderConfiguration(input);
        return buildCanonicalIntent({
            action: "create_order",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                product_id: input.symbol,
                symbol: input.symbol,
                side: input.side,
                order_configuration: orderConfiguration,
            },
        });
    },
};
