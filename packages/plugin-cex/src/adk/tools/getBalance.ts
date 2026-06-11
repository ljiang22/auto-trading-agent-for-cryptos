import { buildCanonicalIntent } from "../../intent/intentBuilder";
import type { AdkGetBalanceInput, AdkTool } from "../types";

export const getBalanceTool: AdkTool<AdkGetBalanceInput> = {
    name: "get_balance",
    canonicalAction: "get_balance",
    stake: "read_only",
    description:
        "Get spot balances from the user's exchange account. Read-only, no approval needed.",
    buildIntent({ input, context }) {
        return buildCanonicalIntent({
            action: "get_balance",
            venue: context.venue,
            userId: context.userId,
            locale: context.locale,
            mode: context.mode,
            params: {
                userId: context.userId as never,
                product_id: input.symbol,
                symbol: input.symbol,
            },
        });
    },
};
