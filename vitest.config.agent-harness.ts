import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/agent-harness/__tests__/**/*.test.mjs"],
        environment: "node",
        globals: true,
        testTimeout: 10000,
    },
});
