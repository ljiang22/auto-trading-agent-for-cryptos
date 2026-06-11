import type { Plugin } from "@elizaos/core";
import { PlotChartAction } from "./actions/advanced_chart";
import { GetFearIndexAction } from "./actions/get_fear_index";
import { FearIndexImageAction } from "./actions/image";
export * as actions from "./actions/index";

export const ChartsPlugin: Plugin = {
    name: "ChartsPlugin",
    description: "Plugin for visualizing cryptocurrency price charts and analysis",
    actions: [
        //FearIndexImageAction,
        PlotChartAction,
    ],
};
export default ChartsPlugin;
