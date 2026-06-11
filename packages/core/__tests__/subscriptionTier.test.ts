import { describe, expect, it, vi } from "vitest";
import {
    getLatestTierFromHistory,
    resolveEffectiveSubscriptionTierFromAdapter,
} from "../src/utils/subscriptionTier.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";

function createMongoAdapter({
    account,
    latestRow,
}: {
    account?: Record<string, unknown> | null;
    latestRow?: Record<string, unknown> | null;
}) {
    const findOne = vi.fn().mockResolvedValue(latestRow ?? null);
    return {
        getAccountById: vi.fn().mockResolvedValue(account ?? null),
        db: {
            collection: vi.fn(() => ({
                findOne,
            })),
        },
        findOne,
    };
}

describe("subscription tier resolution", () => {
    it("reads subscription tier history from a Mongo-compatible collection", async () => {
        const adapter = createMongoAdapter({
            latestRow: { tier: "pro" },
        });

        await expect(getLatestTierFromHistory(adapter as any, USER_ID as any)).resolves.toBe("pro");
        expect(adapter.db.collection).toHaveBeenCalledWith("user_subscription_tier_history");
        expect(adapter.findOne).toHaveBeenCalled();
    });

    it("prefers account details over history when details already contain the current tier", async () => {
        const adapter = createMongoAdapter({
            account: {
                email: "user@example.com",
                details: {
                    subscriptionTier: {
                        currentTier: "plus",
                    },
                },
            },
            latestRow: { tier: "pro" },
        });

        await expect(
            resolveEffectiveSubscriptionTierFromAdapter(adapter as any, USER_ID as any)
        ).resolves.toBe("plus");
        expect(adapter.findOne).not.toHaveBeenCalled();
    });

    it("falls back to free only when neither account details nor history provide a tier", async () => {
        const adapter = createMongoAdapter({
            account: {
                email: "user@example.com",
                details: {},
            },
            latestRow: null,
        });

        await expect(
            resolveEffectiveSubscriptionTierFromAdapter(adapter as any, USER_ID as any)
        ).resolves.toBe("free");
        expect(adapter.findOne).toHaveBeenCalledTimes(1);
    });
});
