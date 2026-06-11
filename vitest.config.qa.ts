import { defineConfig } from "vitest/config";

// Standalone config for QA/script tests living outside the package
// monorepo (e.g. scripts/qa/__tests__/*.test.mjs).
export default defineConfig({
    test: {
        include: [
            "scripts/qa/__tests__/**/*.test.mjs",
        ],
        environment: "node",
        globals: true,
        testTimeout: 30000,
    },
});
