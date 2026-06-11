import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { AdkGetFillsInput, AdkTool } from "../types";

export const getFillsTool: AdkTool<AdkGetFillsInput> = {
    name: "get_fills",
    canonicalAction: "get_fills",
    stake: "read_only",
    description: "List recent trade fills for the resolved venue.",
    buildIntent({ input, context }) {
        return buildCanonicalIntent({
            action: "get_fills",
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
