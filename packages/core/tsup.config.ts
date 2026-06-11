import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"], // Ensure you're targeting CommonJS
    platform: "node",
    target: "node18",
    bundle: true,
    splitting: true, // Add this for better code splitting
    dts: true, // Generate declaration files
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "http",
        "https",
        "child_process", // Add child_process to external
        "google-auth-library", // Add google-auth-library to external
        "@ai-sdk/google-vertex", // Add AI SDK Google Vertex to external
        // Add other modules you want to externalize
        "onnxruntime-node",
        "sharp",
    ],
});
