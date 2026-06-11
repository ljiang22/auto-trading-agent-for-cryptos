import { describe, expect, it, vi } from "vitest";
import { resolveModelClass } from "../src/ai/generation.ts";
import { ModelClass, ModelProviderName } from "../src/core/types.ts";

describe("resolveModelClass", () => {
    const createRuntime = () =>
        ({
            modelProvider: ModelProviderName.OPENAI,
            getSetting: vi.fn().mockReturnValue(undefined),
            databaseAdapter: {
                getAccountById: vi.fn().mockResolvedValue({
                    email: "user@example.com",
                    details: null,
                }),
            },
        }) as any;

    it("forces free users to the small model class by default", async () => {
        const runtime = createRuntime();

        const resolved = await resolveModelClass(
            runtime,
            ModelClass.LARGE,
            "user-1"
        );

        expect(resolved).toBe(ModelClass.SMALL);
    });

    it("preserves the requested model class when downgrade bypass is enabled", async () => {
        const runtime = createRuntime();

        const resolved = await resolveModelClass(
            runtime,
            ModelClass.LARGE,
            "daily-analysis-scheduler",
            {
                bypassModelClassDowngrades: true,
            }
        );

        expect(resolved).toBe(ModelClass.LARGE);
    });
});
