import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const launchpadEnvSchema = z.object({
    HUBBLE_API_KEY: z.string().min(1, "HUBBLE API key is required"),
});

export type LaunchpadConfig = z.infer<typeof launchpadEnvSchema>;

export async function validateLaunchpadConfig(
    runtime: IAgentRuntime,
): Promise<LaunchpadConfig> {
    try {
        const config = {
            HUBBLE_API_KEY: runtime.getSetting("HUBBLE_API_KEY"),
        };

        return launchpadEnvSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const reason = error.errors
                .map((issue) => `${issue.path.join(".") || "HUBBLE_API_KEY"}: ${issue.message}`)
                .join("\n");
            throw new Error(`Launchpad configuration validation failed:\n${reason}`);
        }
        throw error;
    }
}
