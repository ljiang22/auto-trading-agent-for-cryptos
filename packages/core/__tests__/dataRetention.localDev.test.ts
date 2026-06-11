import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("getLocalDevDataRetentionOverride", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...ORIGINAL_ENV };
        delete process.env.LOCAL_DEV_MODE;
        delete process.env.LOCAL_DEV_SUBSCRIPTION_TIER;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("returns null when LOCAL_DEV_MODE is unset", async () => {
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toBeNull();
    });

    it("returns null when LOCAL_DEV_MODE is not 1", async () => {
        process.env.LOCAL_DEV_MODE = "true";
        process.env.LOCAL_DEV_SUBSCRIPTION_TIER = "plus";
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toBeNull();
    });

    it("returns null when tier is missing", async () => {
        process.env.LOCAL_DEV_MODE = "1";
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toBeNull();
    });

    it("maps plus to 180 days", async () => {
        process.env.LOCAL_DEV_MODE = "1";
        process.env.LOCAL_DEV_SUBSCRIPTION_TIER = "plus";
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toEqual({
            dataRetentionDays: 180,
        });
    });

    it("maps enterprise to no limit (0)", async () => {
        process.env.LOCAL_DEV_MODE = "1";
        process.env.LOCAL_DEV_SUBSCRIPTION_TIER = "enterprise";
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toEqual({
            dataRetentionDays: 0,
        });
    });

    it("ignores invalid tier", async () => {
        process.env.LOCAL_DEV_MODE = "1";
        process.env.LOCAL_DEV_SUBSCRIPTION_TIER = "vip";
        const { getLocalDevDataRetentionOverride } = await import(
            "../src/utils/dataRetention.ts"
        );
        expect(getLocalDevDataRetentionOverride()).toBeNull();
    });
});

describe("getDataRetentionConfig with local dev override", () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("skips DB and returns plus window when override is active", async () => {
        process.env.LOCAL_DEV_MODE = "1";
        process.env.LOCAL_DEV_SUBSCRIPTION_TIER = "plus";
        const { getDataRetentionConfig } = await import("../src/utils/dataRetention.ts");
        const runtime = {
            databaseAdapter: {
                getAccountById: vi.fn(),
            },
        };
        await expect(
            getDataRetentionConfig(runtime as any, "any-uuid" as any)
        ).resolves.toEqual({ dataRetentionDays: 180 });
        expect(runtime.databaseAdapter.getAccountById).not.toHaveBeenCalled();
    });
});
