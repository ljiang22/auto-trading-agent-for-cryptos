import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { OrderConfiguration } from "../../types";
import type { AdkPreviewOrderInput, AdkTool } from "../types";

function buildOrderConfiguration(
    input: AdkPreviewOrderInput,
): OrderConfiguration {
    const tif = input.time_in_force ?? (input.order_type === "market" ? "IOC" : "GTC");
    const sizeFields = {
        ...(input.base_size !== undefined ? { base_size: input.base_size } : {}),
        ...(input.quote_size !== undefined ? { quote_size: input.quote_size } : {}),
    };
    switch (input.order_type) {
        case "market":
            if (tif === "FOK") return { market_market_fok: sizeFields };
            return { market_market_ioc: sizeFields };
        case "limit": {
            const limit = {
                ...sizeFields,
                limit_price: input.limit_price ?? "",
            };
            if (tif === "IOC") return { sor_limit_ioc: limit };
            if (tif === "FOK") return { limit_limit_fok: limit };
            if (tif === "GTD") return { limit_limit_gtd: limit };
            return { limit_limit_gtc: limit };
        }
        case "stop_limit":
            return {
                stop_limit_stop_limit_gtc: {
                    ...sizeFields,
                    stop_price: input.stop_price ?? "",
                    limit_price: input.limit_price ?? "",
                },
            };
        case "trigger_bracket":
            return {
                trigger_bracket_gtc: {
                    limit_price: input.limit_price ?? "",
                    stop_trigger_price: input.stop_trigger_price ?? "",
                },
            };
    }
}

export const previewOrderTool: AdkTool<AdkPreviewOrderInput> = {
    name: "preview_order",
    canonicalAction: "preview_order",
    stake: "write",
    description:
        "Compute estimated fees, slippage, and notional for a hypothetical order. Routes through risk pre-check for parity with create_order.",
    buildIntent({ input, context }) {
        return buildCanonicalIntent({
            action: "preview_order",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                product_id: input.symbol,
                symbol: input.symbol,
                side: input.side,
                order_configuration: buildOrderConfiguration(input),
            },
        });
    },
};
