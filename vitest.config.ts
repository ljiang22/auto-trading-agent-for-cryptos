import { defineConfig } from "vitest/config";
import path from "path";

const root = path.resolve(__dirname);

export default defineConfig({
    resolve: {
        // Directly map workspace packages to their TypeScript source so vitest
        // doesn't need a dist/ build. Add entries here if new workspace packages
        // are imported by tests.
        alias: [
            { find: "@elizaos/core", replacement: path.join(root, "packages/core/src/index.ts") },
            { find: "@elizaos/client-direct", replacement: path.join(root, "packages/client-direct/src/index.ts") },
        ],
    },
    test: {
        environment: "node",
        globals: false,
        testTimeout: 30000,
    },
});
