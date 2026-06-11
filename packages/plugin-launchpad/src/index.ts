import type { Plugin } from "@elizaos/core";
import { launchpadGeneralDataAction } from "./actions/getGeneralLaunchpadData";
import { launchpadPrecisionDataAction } from "./actions/getPrecisionLaunchpadData";

export const launchpadPlugin: Plugin = {
    name: "launchpad",
    description: "Hubble Launchpad API plugin exposing general metadata and precise hourly metrics for emerging Solana tokens.",
    actions: [launchpadGeneralDataAction, launchpadPrecisionDataAction],
    evaluators: [],
    providers: [],
};

export default launchpadPlugin;
