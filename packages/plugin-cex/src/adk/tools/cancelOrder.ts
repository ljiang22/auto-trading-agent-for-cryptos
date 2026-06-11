import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { AdkCancelOrderInput, AdkTool } from "../types";

export const cancelOrderTool: AdkTool<AdkCancelOrderInput> = {
    name: "cancel_order",
    canonicalAction: "cancel_order",
    stake: "write",
    description: "Cancel one or more open orders by venue-side order_id. Write — gated by risk + approval.",
    buildIntent({ input, context }) {
        return buildCanonicalIntent({
            action: "cancel_order",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                product_id: input.symbol,
                symbol: input.symbol,
                cancel_order_id: input.order_ids[0],
                order_ids: input.order_ids,
            },
        });
    },
};
