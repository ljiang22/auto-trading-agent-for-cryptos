import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import viteCompression from "vite-plugin-compression";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
    const envDir = path.resolve(__dirname, "..");
    const env = loadEnv(mode, envDir, "");
    const serverPort = env.SERVER_PORT || "3000";
    // When unset, the client would use `window.location.origin` (e.g. Vite :5173) and every API call 404s.
    // In dev, default to the agent URL so `pnpm start` + `pnpm start:client` work without editing .env.
    const serverBaseUrl =
        (env.SERVER_BASE_URL && env.SERVER_BASE_URL.trim()) ||
        (mode === "development" ? `http://localhost:${serverPort}` : "");
    const chartProxyTarget = serverBaseUrl || `http://localhost:${serverPort}`;
    const chartAndReportProxy = {
        "/charts": {
            target: chartProxyTarget,
            changeOrigin: true,
        },
        "/reports": {
            target: chartProxyTarget,
            changeOrigin: true,
        },
        // Same-origin as SPA in dev so ChartEmbed fetch(..., credentials) sends session cookies.
        "/s3-files": {
            target: chartProxyTarget,
            changeOrigin: true,
        },
    };
    return {
        plugins: [
            react(),
            viteCompression({
                algorithm: "brotliCompress",
                ext: ".br",
                threshold: 1024,
            }),
        ],
        clearScreen: false,
        envDir,
        define: {
            "import.meta.env.VITE_SERVER_PORT": JSON.stringify(
                env.SERVER_PORT || "3000"
            ),
            "import.meta.env.VITE_SERVER_URL": JSON.stringify(
                env.SERVER_URL || "http://localhost"
            ),
            "import.meta.env.VITE_SERVER_BASE_URL": JSON.stringify(serverBaseUrl),
            "import.meta.env.VITE_PUBLIC_ACCESS_MODE": JSON.stringify(
                env.VITE_PUBLIC_ACCESS_MODE || "0"
            ),
        },
        root: '.',
        base: '/',
        build: {
            outDir: "dist",
            emptyOutDir: true,
            minify: true,
            cssMinify: true,
            sourcemap: false,
            cssCodeSplit: true,
        },
        resolve: {
            alias: {
                "@": "/src",
                "@elizaos-plugins/plugin-cex/nl": path.resolve(
                    __dirname,
                    "../packages/plugin-cex/src/nl/orderNl.ts"
                ),
            },
        },
        // Same-origin chart/report URLs (SPA origin) so ChartEmbed can be rasterized for share export.
        // Proxied to the agent for `vite` and `vite preview` against a local backend.
        server: {
            proxy: chartAndReportProxy,
        },
        preview: {
            proxy: chartAndReportProxy,
        },
    };
});
