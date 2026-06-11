import { amendOrderTool } from "./amendOrder";
import { cancelOrderTool } from "./cancelOrder";
import { createOrderTool } from "./createOrder";
import { getBalanceTool } from "./getBalance";
import { getFillsTool } from "./getFills";
import { getOrdersTool } from "./getOrders";
import { previewOrderTool } from "./previewOrder";
import type { AdkTool, AdkToolName } from "../types";

export {
    amendOrderTool,
    cancelOrderTool,
    createOrderTool,
    getBalanceTool,
    getFillsTool,
    getOrdersTool,
    previewOrderTool,
};

export const ALL_ADK_TOOLS: AdkTool<unknown>[] = [
    getBalanceTool as AdkTool<unknown>,
    getOrdersTool as AdkTool<unknown>,
    getFillsTool as AdkTool<unknown>,
    createOrderTool as AdkTool<unknown>,
    cancelOrderTool as AdkTool<unknown>,
    amendOrderTool as AdkTool<unknown>,
    previewOrderTool as AdkTool<unknown>,
];

export const ADK_TOOL_BY_NAME: Record<AdkToolName, AdkTool<unknown>> = {
    get_balance: getBalanceTool as AdkTool<unknown>,
    get_orders: getOrdersTool as AdkTool<unknown>,
    get_fills: getFillsTool as AdkTool<unknown>,
    create_order: createOrderTool as AdkTool<unknown>,
    cancel_order: cancelOrderTool as AdkTool<unknown>,
    amend_order: amendOrderTool as AdkTool<unknown>,
    preview_order: previewOrderTool as AdkTool<unknown>,
};
