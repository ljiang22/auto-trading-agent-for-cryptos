import { defineConfig } from "tsup";
import * as path from 'path';
import { fileURLToPath } from 'url';

// Use import.meta.url to get the equivalent of __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"], // Ensure you're targeting CommonJS
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "@elizaos/core",
        // Don't externalize crypto as we're providing a polyfill
    ],
    // Add Node.js compatibility options
    platform: 'node',
    target: 'node18',
    noExternal: [],
    esbuildOptions: (options) => {
        options.alias = {
            // Replace uuid's rng.js with our polyfill
            "uuid/lib/rng.js": path.resolve(__dirname, "./src/uuid-rng-polyfill.ts"),
            // Replace crypto with our polyfill
            "crypto": path.resolve(__dirname, "./src/crypto-polyfill.ts"),
        };
    },
});
