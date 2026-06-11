import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"],
    platform: "node",
    target: "node18",
    bundle: true,
    splitting: true,
    dts: true,
    noExternal: [],
    esbuildOptions(options) {
        options.external = options.external || []
        options.external.push('@aws/*', '@smithy/*', '@aws-sdk/*')
    },
    external: [
        "dotenv",
        "fs",
        "path",
        "http",
        "https",
        "child_process", // Add child_process to external
        "google-auth-library", // Add google-auth-library to external
        "@ai-sdk/google-vertex", // Add AI SDK Google Vertex to external
        "@reflink/reflink",
        "@node-llama-cpp",
        "onnxruntime-node",
        "sharp",
        "csvtojson",
        "form-data",
        "combined-stream",
        "proxy-from-env",
        "follow-redirects",
        "canvas",
        "better-sqlite3",
        "node-fetch",
        "axios",
        "sqlite-vec",
        "puppeteer",
        "playwright",
        "@tavily/core",
        // Add Node.js built-in modules that cause dynamic require issues
        "async_hooks",
        "perf_hooks", 
        "worker_threads",
        "inspector",
        "crypto",
        "os",
        "util",
        "events",
        "stream",
        "buffer",
        "url",
        "querystring",
        "zlib",
        "net",
        "tls",
        "dns",
        "module",
        // AWS Lambda specific modules that cause dynamic require issues
        "@aws/lambda-invoke-store",
        "@aws-sdk/client-lambda", 
        "@aws-sdk/lambda-invoke-store",
        // Additional AWS modules that might cause issues
        "@smithy/types",
        "@smithy/smithy-client",
        "@aws-sdk/types",
        "@smithy/protocol-http",
    ],
}); 
