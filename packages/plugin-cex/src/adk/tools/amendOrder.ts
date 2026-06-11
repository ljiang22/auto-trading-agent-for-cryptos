import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { OrderConfiguration } from "../../types";
import type { AdkAmendOrderInput, AdkTool } from "../types";

export const amendOrderTool: AdkTool<AdkAmendOrderInput> = {
    name: "amend_order",
    canonicalAction: "amend_order",
    stake: "write",
    description:
        "Amend an open limit order's price and/or size. Write — gated by risk + approval.",
    buildIntent({ input, context }) {
        const limit: NonNullable<OrderConfiguration["limit_limit_gtc"]> = {
            limit_price: input.new_limit_price ?? "",
            ...(input.new_base_size !== undefined
                ? { base_size: input.new_base_size }
                : {}),
        };
        const orderConfiguration: OrderConfiguration = {
            limit_limit_gtc: limit,
        };
        return buildCanonicalIntent({
            action: "amend_order",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                product_id: input.symbol,
                symbol: input.symbol,
                amend_order_id: input.order_id,
                order_configuration: orderConfiguration,
            },
        });
    },
};
