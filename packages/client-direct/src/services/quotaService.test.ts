import { describe, expect, it, vi } from "vitest";
import { getUserQuotaTier } from "./quotaService.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function createRuntime({
    account,
    latestTier,
}: {
    account: Record<string, unknown> | null;
    latestTier?: "free" | "plus" | "pro" | "enterprise" | null;
}) {
    const findOne = vi.fn().mockResolvedValue(
        latestTier ? { tier: latestTier } : null
    );

    return {
        databaseAdapter: {
            getAccountById: vi.fn().mockResolvedValue(account),
            db: {
                collection: vi.fn(() => ({
                    findOne,
                })),
            },
        },
        findOne,
    } as any;
}

describe("getUserQuotaTier", () => {
    it("uses the backend-aware tier resolution in Mongo-compatible mode", async () => {
        const runtime = createRuntime({
            account: {
                email: "user@example.com",
                details: {},
            },
            latestTier: "plus",
        });

        await expect(getUserQuotaTier(runtime, USER_ID as any)).resolves.toEqual({
            tier: "plus",
            isFreeUser: false,
            isUnlimited: false,
        });
        expect(runtime.findOne).toHaveBeenCalledTimes(1);
    });

    it("keeps anonymous users on the free quota path", async () => {
        const runtime = createRuntime({
            account: {
                email: `${USER_ID}@anonymous.local`,
                details: { source: "ip" },
            },
            latestTier: "enterprise",
        });

        await expect(getUserQuotaTier(runtime, USER_ID as any)).resolves.toEqual({
            tier: "free",
            isFreeUser: true,
            isUnlimited: false,
        });
        expect(runtime.findOne).not.toHaveBeenCalled();
    });
});
