import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { AdkGetOrdersInput, AdkTool } from "../types";

export const getOrdersTool: AdkTool<AdkGetOrdersInput> = {
    name: "get_orders",
    canonicalAction: "get_orders",
    stake: "read_only",
    description: "List open or historical orders for the resolved venue.",
    buildIntent({ input, context }) {
        return buildCanonicalIntent({
            action: "get_orders",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                symbol: input.symbol,
                product_id: input.symbol,
            },
        });
    },
};
