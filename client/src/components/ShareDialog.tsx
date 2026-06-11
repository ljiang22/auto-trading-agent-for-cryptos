import * as React from "react";
import {
    AlertCircle,
    Copy,
    Download,
    ExternalLink,
    Image as ImageIcon,
    Link2,
    Loader2,
} from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
    messagesFromComprehensiveSnapshot,
    messagesFromTaskChainSnapshot,
} from "@/components/chat/conversation-utils";
import { apiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// Optional explicit override for the public share origin. When unset (the common case), share URLs
// are auto-detected from `window.location.origin`, which gives the correct public domain in
// staging/production and `http://localhost:<port>` in local dev.
const SHARE_BASE_URL =
    (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SHARE_BASE_URL) ||
    null;

// Dev-only opt-in to allow LinkedIn share with a localhost URL. Gated on `import.meta.env.DEV` so a
// misconfigured staging/production build can never bypass the guard, even if the flag leaks in.
const ALLOW_LOCAL_SHARE =
    typeof import.meta !== "undefined" &&
    (import.meta as any).env?.DEV === true &&
    String((import.meta as any).env?.VITE_ALLOW_LOCAL_SHARE ?? "").toLowerCase() === "true";

export type ShareChoice = "image" | "link" | "linkedin" | "reddit" | "x";

interface ShareDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    context?: { agentId?: string; roomId?: string };
}

type TranscriptMessage = {
    id?: string;
    text: string;
    user: "system" | "user";
    createdAt?: number;
};

/** Snapshot exports set `user: "assistant"` while `userId` is often the human participant. */
const transcriptUserFromSnapshotExtra = (
    extra: { userId?: string; user?: string },
    agentId: string,
): "system" | "user" => {
    const role = typeof extra.user === "string" ? extra.user : "";
    if (role === "assistant" || String(extra.userId) === String(agentId)) {
        return "system";
    }
    return "user";
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
const SHARE_SOCIAL_POST_MESSAGE = "Found this pretty insightful, sharing it here";
const SHARE_SOCIAL_POST_LINE = `${SHARE_SOCIAL_POST_MESSAGE}:`;

const truncateText = (value: string, maxChars: number): string => {
    const normalized = collapseWhitespace(value);
    if (normalized.length <= maxChars) return normalized;

    const truncated = normalized.slice(0, maxChars);
    const lastSpace = truncated.lastIndexOf(" ");
    const safeCut = lastSpace > Math.max(0, maxChars - 30) ? truncated.slice(0, lastSpace) : truncated;
    return `${safeCut.trimEnd()}…`;
};

/** Innermost focused task-chain / comprehensive panel (bottom of thread wins if multiple). */
function getFocusedShareExportEl(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const focused = document.querySelectorAll('[data-share-focused-export="true"]');
    if (focused.length === 0) return null;
    return focused[focused.length - 1] as HTMLElement;
}

/** Prefer the focused panel; otherwise the full chat scroller. */
function getShareExportRoot(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    return (
        getFocusedShareExportEl() ??
        (document.querySelector('[data-share-chat-export="true"]') as HTMLElement | null)
    );
}

/** SVG foreignObject often collapses flex/grid; flatten so task-chain / markdown body isn’t clipped. */
const SHARE_SNAPSHOT_DOM_CSS = `
.share-export-snapshot { display: block !important; box-sizing: border-box !important; width: 100% !important; max-width: 100% !important; }
.share-export-snapshot .sticky { position: relative !important; top: auto !important; }
.share-export-snapshot .flex.flex-col.gap-6.lg\\:flex-row,
.share-export-snapshot .flex.gap-6.lg\\:flex-row { display: block !important; }
.share-export-snapshot .flex { display: block !important; }
.share-export-snapshot .flex-1,
.share-export-snapshot .lg\\:flex-\\[3\\],
.share-export-snapshot .lg\\:flex-\\[1\\] { flex: none !important; width: 100% !important; max-width: 100% !important; }
.share-export-snapshot .min-h-\\[500px\\],
.share-export-snapshot .lg\\:min-h-\\[500px\\] { min-height: 0 !important; }
/* Spinner sits above the iframe in the DOM; hide it for export so rasterized charts aren’t covered. */
.share-export-snapshot .chart-embed-loading-screen { display: none !important; }
`;

/** Same-origin chart HTML is served under `/charts/`; SVG foreignObject cannot paint iframes — rasterize for export. */
function isChartIframeSrc(src: string): boolean {
    if (!src) return false;
    try {
        const u = new URL(src, window.location.href);
        return u.pathname.includes("/charts/");
    } catch {
        return src.includes("/charts/");
    }
}

function chartIframeSameOriginAsPage(src: string): boolean {
    try {
        return new URL(src, window.location.href).origin === window.location.origin;
    } catch {
        return false;
    }
}

/** Chart.js briefly uses the HTML default canvas size before layout; don't snapshot that frame. */
function isUnsetChartCanvas(c: HTMLCanvasElement): boolean {
    const w = c.width;
    const h = c.height;
    if (w < 32 || h < 32) return true;
    return w === 300 && h === 150;
}

/**
 * Chart URLs must hit the SPA origin (Vite proxy). Normalize `iframe.src` so fetch matches what works in Network tab.
 */
function normalizeChartUrlForFetch(iframeSrc: string): string | null {
    try {
        const u = new URL(iframeSrc, window.location.href);
        if (!u.pathname.includes("/charts/")) return null;
        return `${window.location.origin}${u.pathname}${u.search}`;
    } catch {
        return null;
    }
}

/** When markdown images cannot be inlined (CORS), show caption + URL instead of a blank box. */
function makeMarkdownImageExportFallback(imageUrl: string, captionOrAlt: string): HTMLDivElement {
    const wrap = document.createElement("div");
    wrap.className = "share-export-markdown-image-fallback";
    wrap.style.cssText = [
        "box-sizing:border-box",
        "width:100%",
        "max-width:100%",
        "padding:12px 14px",
        "margin:10px 0",
        "border-radius:12px",
        "border:1px solid rgba(148,163,184,0.55)",
        "background:rgba(248,250,252,0.98)",
        "color:#0f172a",
        "font-size:12px",
        "line-height:1.45",
        "word-break:break-word",
        "font-family:ui-sans-serif,system-ui,sans-serif",
    ].join(";");

    const cap = document.createElement("div");
    cap.style.cssText = "font-weight:600;margin-bottom:6px;color:#1e293b";
    cap.textContent = captionOrAlt.trim() || "Image";

    const urlLine = document.createElement("div");
    urlLine.style.cssText = "font-size:11px;opacity:0.92;word-break:break-all;color:#334155";
    urlLine.textContent = imageUrl.trim() || "(Image URL unavailable)";

    wrap.appendChild(cap);
    wrap.appendChild(urlLine);
    return wrap;
}

async function fetchCrossOriginImageAsDataUrl(imageUrl: string): Promise<string | null> {
    try {
        const res = await fetch(imageUrl, { mode: "cors", credentials: "omit", cache: "no-store" });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) return null;
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

/**
 * Embedded export: strip cross-origin CSS urls / img src so html-to-image does not taint.
 */
function scrubDomSubtreeForSvgCanvasExport(root: HTMLElement, transparentPixel: string): void {
    const walk = (node: Element): void => {
        if (node instanceof HTMLElement) {
            const bg = node.style.backgroundImage;
            if (
                bg &&
                /url\s*\(/i.test(bg) &&
                !/url\s*\(\s*["']?data:/i.test(bg) &&
                !/blob:/i.test(bg)
            ) {
                node.style.backgroundImage = "none";
            }
        }
        if (node instanceof HTMLImageElement) {
            const s = node.currentSrc || node.src || "";
            if (s && !s.startsWith("data:") && !s.startsWith("blob:")) {
                node.src = transparentPixel;
                node.removeAttribute("srcset");
            }
            node.removeAttribute("crossorigin");
            node.removeAttribute("crossOrigin");
        }
        for (const child of Array.from(node.children)) {
            walk(child);
        }
    };
    walk(root);
}

/** Poll until the iframe document exists (same-origin) or timeout. */
async function waitForChartIframeDocument(
    iframe: HTMLIFrameElement,
    timeoutMs: number,
): Promise<Document | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const doc = iframe.contentDocument;
            if (doc?.documentElement) {
                return doc;
            }
        } catch {
            return null;
        }
        await new Promise<void>((r) => setTimeout(r, 40));
    }
    try {
        return iframe.contentDocument;
    } catch {
        return null;
    }
}

/** Wait for Plotly / Chart.js instances / real canvas dimensions inside chart HTML. */
async function waitForChartPaint(doc: Document | null, iframeWindow: Window | null, timeoutMs: number): Promise<void> {
    if (!doc?.body) return;
    const win = iframeWindow as Window & { Chart?: { getChart?: (c: HTMLCanvasElement) => unknown } };
    const ChartApi = win?.Chart;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hasPlotly = doc.querySelector(".plotly-graph-div") !== null;

        const canvases = Array.from(doc.querySelectorAll("canvas"));
        let chartJsReady = false;
        if (ChartApi && typeof ChartApi.getChart === "function") {
            for (const c of canvases) {
                if (isUnsetChartCanvas(c)) continue;
                try {
                    const inst = ChartApi.getChart(c);
                    if (inst && c.width * c.height > 8000) {
                        chartJsReady = true;
                        break;
                    }
                } catch {
                    /* noop */
                }
            }
        }

        const sizedCanvas = canvases.some(
            (c) => !isUnsetChartCanvas(c) && c.width * c.height > 8000,
        );

        // Do not treat `.chart-container` alone as ready — it exists before Chart.js resizes the canvas.
        const hasPlotShell =
            hasPlotly ||
            chartJsReady ||
            sizedCanvas ||
            doc.querySelector(".plotly, .js-plotly-plot, svg.main-svg") !== null;

        if (hasPlotShell) {
            await new Promise<void>((r) => setTimeout(r, chartJsReady || sizedCanvas ? 450 : 180));
            return;
        }
        await new Promise<void>((r) => setTimeout(r, 60));
    }
}

/**
 * Load chart HTML via fetch + blob iframe (same-origin read/write). More reliable than rasterizing the live
 * ChartEmbed iframe (loading overlays, race with Chart.js resize).
 */
async function rasterizeChartPageOffscreen(chartPageUrl: string): Promise<string | null> {
    const fetchUrl = normalizeChartUrlForFetch(chartPageUrl);
    if (!fetchUrl) return null;

    let objectUrl: string | null = null;
    let host: HTMLIFrameElement | null = null;
    try {
        const res = await fetch(fetchUrl, { credentials: "include", cache: "no-store" });
        if (!res.ok) {
            console.warn("Share export: fetch chart HTML failed:", res.status, fetchUrl.slice(0, 120));
            return null;
        }
        const html = await res.text();
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        objectUrl = URL.createObjectURL(blob);

        host = document.createElement("iframe");
        host.setAttribute("sandbox", "allow-scripts allow-same-origin");
        host.setAttribute("title", "chart-export");
        host.style.cssText =
            "position:fixed!important;left:-9999px!important;top:0!important;width:1200px!important;height:960px!important;border:0!important;opacity:0!important;pointer-events:none!important;";
        document.body.appendChild(host);

        await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error("chart iframe load timeout")), 25_000);
            host!.onload = () => {
                window.clearTimeout(timer);
                resolve();
            };
            host!.onerror = () => {
                window.clearTimeout(timer);
                reject(new Error("chart iframe error"));
            };
            host!.src = objectUrl!;
        });

        const doc = await waitForChartIframeDocument(host, 18_000);
        const innerWin = host.contentWindow;
        await waitForChartPaint(doc, innerWin ?? null, 14_000);

        if (doc && innerWin) {
            const raster = await tryCaptureIframeChartRaster(host, doc);
            if (raster && raster.length > 300) {
                return raster;
            }
        }

        const target = doc?.documentElement ?? doc?.body;
        if (!target) return null;
        const { toPng } = await import("html-to-image");
        return await toPng(target, {
            pixelRatio: Math.min(2, window.devicePixelRatio || 2),
            cacheBust: true,
            backgroundColor: "#ffffff",
            skipFonts: true,
        });
    } catch (error) {
        console.warn("Share export: offscreen chart render failed:", error);
        return null;
    } finally {
        if (host?.parentNode) {
            host.parentNode.removeChild(host);
        }
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }
    }
}

/**
 * Prefer native chart APIs / canvas bitmaps. Agent-generated HTML uses Chart.js on &lt;canvas&gt;;
 * html-to-image often captures an empty clone for Chart.js (canvas pixels are not in the DOM snapshot).
 */
async function tryCaptureIframeChartRaster(
    iframe: HTMLIFrameElement,
    doc: Document,
): Promise<string | null> {
    const win = iframe.contentWindow as Window & {
        Plotly?: {
            toImage: (el: HTMLElement, opts: Record<string, unknown>) => Promise<string>;
        };
        Chart?: {
            getChart?: (ctx: HTMLCanvasElement | CanvasRenderingContext2D) =>
                | { update?: (mode?: string) => void }
                | undefined;
        };
    };

    const plotDiv = doc.querySelector(".plotly-graph-div") as HTMLElement | null;
    if (plotDiv && typeof win?.Plotly?.toImage === "function") {
        try {
            const w = Math.max(plotDiv.scrollWidth || plotDiv.offsetWidth || 900, 400);
            const h = Math.max(plotDiv.scrollHeight || plotDiv.offsetHeight || 520, 300);
            const dataUrl = await win.Plotly.toImage(plotDiv, {
                format: "png",
                width: Math.min(w, 2400),
                height: Math.min(h, 2400),
                scale: Math.min(2, window.devicePixelRatio || 2),
            });
            if (typeof dataUrl === "string" && dataUrl.startsWith("data:image")) {
                return dataUrl;
            }
        } catch (error) {
            console.warn("Share export: Plotly.toImage failed:", error);
        }
    }

    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    const canvases = Array.from(doc.querySelectorAll("canvas")).filter(
        (c) => !isUnsetChartCanvas(c) && c.width > 16 && c.height > 16,
    );
    if (canvases.length === 0) {
        return null;
    }

    const ChartApi = win.Chart;
    if (ChartApi && typeof ChartApi.getChart === "function") {
        for (const canvas of canvases) {
            try {
                const chart = ChartApi.getChart(canvas);
                if (chart && typeof chart.update === "function") {
                    chart.update("none");
                }
            } catch {
                /* noop */
            }
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }

    try {
        if (canvases.length === 1) {
            return canvases[0].toDataURL("image/png");
        }

        let maxW = 0;
        let totalH = 0;
        for (const c of canvases) {
            maxW = Math.max(maxW, c.width);
            totalH += c.height;
        }
        const merged = document.createElement("canvas");
        merged.width = maxW;
        merged.height = totalH;
        const ctx = merged.getContext("2d");
        if (!ctx) {
            return canvases[0].toDataURL("image/png");
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, merged.width, merged.height);
        let y = 0;
        for (const c of canvases) {
            ctx.drawImage(c, 0, y);
            y += c.height;
        }
        return merged.toDataURL("image/png");
    } catch (error) {
        console.warn("Share export: canvas bitmap capture failed:", error);
        return null;
    }
}

async function rasterizeChartIframe(iframe: HTMLIFrameElement): Promise<string | null> {
    if (!isChartIframeSrc(iframe.src || "")) return null;
    const src = iframe.src || "";

    const toPngOptions = {
        pixelRatio: Math.min(2, window.devicePixelRatio || 2),
        cacheBust: true,
        backgroundColor: "#ffffff",
        skipFonts: true,
    } as const;

    const runToPng = async (target: HTMLElement): Promise<string> => {
        const { toPng } = await import("html-to-image");
        return await toPng(target, { ...toPngOptions });
    };

    /** Prefer fetch + offscreen iframe — same chart HTML, no React loader / iframe timing issues. */
    const offscreen = await rasterizeChartPageOffscreen(src);
    if (offscreen) {
        return offscreen;
    }

    if (!chartIframeSameOriginAsPage(src)) {
        console.warn(
            "Share export: chart iframe is not same-origin as the app; export cannot read iframe pixels. src=",
            src.slice(0, 160),
        );
        return null;
    }

    try {
        const doc = await waitForChartIframeDocument(iframe, 4500);
        const target = doc?.documentElement ?? doc?.body;
        if (!target) {
            console.warn(
                "Share export: chart iframe has no readable document (cross-origin or still loading). " +
                    "Serve charts from the same origin as the SPA (e.g. Vite proxy /charts in dev). src=",
                src.slice(0, 120),
            );
            return null;
        }

        await waitForChartPaint(doc, iframe.contentWindow ?? null, 4500);

        const bitmapRaster = await tryCaptureIframeChartRaster(iframe, doc!);
        if (bitmapRaster) {
            return bitmapRaster;
        }

        try {
            return await runToPng(target);
        } catch (firstErr) {
            const body = doc!.body;
            if (body && body !== target) {
                try {
                    return await runToPng(body);
                } catch {
                    console.warn("Share export: chart iframe rasterize failed (documentElement and body):", firstErr);
                    return null;
                }
            }
            console.warn("Share export: chart iframe rasterize failed:", firstErr);
            return null;
        }
    } catch (error) {
        console.warn("Share export: chart iframe rasterize failed:", error);
        return null;
    }
}

function makeExportPlaceholder(label: string, heightPx: string): HTMLDivElement {
    const placeholder = document.createElement("div");
    placeholder.textContent = label;
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.justifyContent = "center";
    placeholder.style.width = "100%";
    placeholder.style.height = heightPx;
    placeholder.style.minHeight = heightPx;
    placeholder.style.borderRadius = "12px";
    placeholder.style.border = "1px solid rgba(148, 163, 184, 0.6)";
    placeholder.style.background = "rgba(248, 250, 252, 0.9)";
    placeholder.style.color = "rgba(71, 85, 105, 0.95)";
    placeholder.style.fontSize = "12px";
    placeholder.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    placeholder.style.overflow = "hidden";
    return placeholder;
}

const buildLinkedInShareUrl = (opts: {
    url: string;
}): string => {
    // Staging behavior: legacy endpoint that can prefill title/summary in some LinkedIn flows.
    return `https://www.linkedin.com/shareArticle?mini=true&url=${encodeURIComponent(
        opts.url,
    )}&title=${encodeURIComponent(SHARE_SOCIAL_POST_LINE)}&summary=${encodeURIComponent(
        SHARE_SOCIAL_POST_LINE,
    )}`;
};

const buildXShareUrl = (opts: { url: string }): string => {
    const body = `${SHARE_SOCIAL_POST_LINE}\n`;
    return `https://x.com/intent/tweet?text=${encodeURIComponent(body)}&url=${encodeURIComponent(opts.url)}`;
};

const buildRedditTextShareUrl = (opts: {
    url: string;
}): string => {
    const title = truncateText(SHARE_SOCIAL_POST_LINE, 290);
    // Link post ensures the URL is clickable in the final submission.
    return `https://www.reddit.com/submit?title=${encodeURIComponent(title)}&url=${encodeURIComponent(opts.url)}`;
};

const isLocalhostShareUrl = (url: string): boolean => {
    try {
        const parsed = new URL(url, window.location.origin);
        return (
            parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "0.0.0.0"
        );
    } catch {
        return false;
    }
};

function XLogo({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={cn("h-4 w-4", className)}
            fill="currentColor"
        >
            <path d="M18.244 2H21l-6.5 7.43L22 22h-6.17l-4.83-6.33L5.47 22H2.7l7.05-8.06L2 2h6.33l4.37 5.78L18.244 2Zm-1.08 18h1.71L7.26 3.9H5.43L17.164 20Z" />
        </svg>
    );
}

function LinkedInLogo({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={cn("h-4 w-4", className)}
            fill="currentColor"
        >
            <path d="M22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.21 0 22.23 0ZM7.06 20.45H3.56V9h3.5v11.45ZM5.31 7.43a2.03 2.03 0 1 1 0-4.06 2.03 2.03 0 0 1 0 4.06ZM20.45 20.45h-3.5v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67h-3.5V9h3.36v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.59 0 4.25 2.36 4.25 5.43v6.31Z" />
        </svg>
    );
}

function RedditLogo({ className }: { className?: string }) {
    return (
        <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={cn("h-4 w-4", className)}
            fill="currentColor"
        >
            <path d="M24 12.07a2.66 2.66 0 0 0-4.62-1.77 9.3 9.3 0 0 0-6.75-2.45l1.1-5.18 3.58.76a2.03 2.03 0 1 0 .2-.9l-4.28-.9a.75.75 0 0 0-.89.58L11.05 8a9.34 9.34 0 0 0-6.43 2.33A2.66 2.66 0 1 0 0 12.07c0 1.08.65 2.01 1.58 2.42-.05.23-.08.47-.08.72 0 4.1 4.93 7.43 11 7.43s11-3.33 11-7.43c0-.25-.03-.49-.08-.72.93-.41 1.58-1.34 1.58-2.42ZM7.06 13.6c0-1.07.87-1.94 1.94-1.94s1.94.87 1.94 1.94-.87 1.94-1.94 1.94-1.94-.87-1.94-1.94Zm9.47 5.21c-1.07 1.07-2.79 1.14-3.53 1.14s-2.46-.07-3.53-1.14a.5.5 0 0 1 .71-.71c.62.62 1.76.85 2.82.85s2.2-.23 2.82-.85a.5.5 0 0 1 .71.71Zm-1.53-3.27c-1.07 0-1.94-.87-1.94-1.94s.87-1.94 1.94-1.94 1.94.87 1.94 1.94-.87 1.94-1.94 1.94Z" />
        </svg>
    );
}

export function ShareDialog({ open, onOpenChange, context }: ShareDialogProps) {
    const [selectedNetwork, setSelectedNetwork] = React.useState<
        "linkedin" | "reddit" | "x" | null
    >(null);
    const [networkShareInFlight, setNetworkShareInFlight] = React.useState<
        "linkedin" | "reddit" | "x" | null
    >(null);
    const [isGeneratingLink, setIsGeneratingLink] = React.useState(false);
    const [sharedChatUrl, setSharedChatUrl] = React.useState<string | null>(null);
    const [linkGenerationError, setLinkGenerationError] = React.useState<string | null>(null);
    const [roomName, setRoomName] = React.useState<string | null>(null);
    const [isGeneratingImage, setIsGeneratingImage] = React.useState(false);
    const [imageActionInFlight, setImageActionInFlight] = React.useState<"copy" | "download" | null>(
        null
    );
    const [generatedImageBlob, setGeneratedImageBlob] = React.useState<Blob | null>(null);
    const [generatedImageKey, setGeneratedImageKey] = React.useState<string | null>(null);
    const { toast } = useToast();
    const lastContextKeyRef = React.useRef<string | null>(null);
    const linkGenerationPromiseRef = React.useRef<Promise<string | null> | null>(null);

    const hasChatContext = Boolean(context?.agentId && context?.roomId);
    const isNetworkShareDisabled = !hasChatContext || networkShareInFlight !== null;

    const getShareBaseUrl = React.useCallback((): string => {
        if (typeof window === "undefined") {
            return "";
        }

        // Prefer the explicit override when provided (useful for previews/tunnels), otherwise
        // auto-detect from the current page origin so staging/prod "just work" without any env vars.
        const configured =
            typeof SHARE_BASE_URL === "string" ? SHARE_BASE_URL.trim().replace(/\/+$/, "") : "";
        if (configured.length > 0) {
            return configured;
        }
        return window.location.origin.replace(/\/+$/, "");
    }, []);

    const getRoomName = React.useCallback(async (): Promise<string | null> => {
        const agentId = context?.agentId;
        const roomId = context?.roomId;
        if (!agentId || !roomId) {
            return null;
        }

        try {
            const response = await apiClient.getRooms(agentId);
            const rooms = Array.isArray(response?.rooms) ? response.rooms : [];
            const room = rooms.find((candidate: any) => String(candidate?.id) === String(roomId));
            const name = typeof room?.name === "string" ? room.name.trim() : "";
            return name.length > 0 ? name : null;
        } catch (error) {
            console.warn("Failed to fetch room name for export:", error);
            return null;
        }
    }, [context?.agentId, context?.roomId]);

    const generateLink = React.useCallback(async (): Promise<string | null> => {
        if (linkGenerationPromiseRef.current) {
            return await linkGenerationPromiseRef.current;
        }

        const agentId = context?.agentId;
        const roomId = context?.roomId;

        if (!agentId || !roomId) {
            toast({
                variant: "destructive",
                title: "Open a chat to share",
                description: "Go to a chat room first, then generate a share link.",
            });
            return null;
        }

        const run = async (): Promise<string | null> => {
            try {
                setIsGeneratingLink(true);
                setLinkGenerationError(null);
                const response = await apiClient.createSharedChat(agentId, roomId);
                const shareCode = response?.share?.shareCode;
                if (!shareCode || typeof shareCode !== "string") {
                    throw new Error("Invalid share response");
                }

                const base = getShareBaseUrl();
                const url = base ? `${base}/shared/chat/${shareCode}` : `/shared/chat/${shareCode}`;
                setSharedChatUrl(url);
                return url;
            } catch (error) {
                console.error("Failed to generate shared chat link:", error);
                const message = error instanceof Error ? error.message : "Please try again.";
                const status = (error as Error & { status?: number }).status;

                setSharedChatUrl(null);

                // Do not fall back to `/shared/room/:agentId/:roomId`. That route calls GET /shared-rooms/
                // which requires the viewer to already be a room participant — recipients always get 403.
                let userMessage = message;
                if (status === 403) {
                    userMessage =
                        "Can't create a public link: you must be a participant in this room. Try refreshing, or sign in with the account that owns this chat.";
                } else if (status === 401) {
                    userMessage = "Sign in to create a share link for this chat.";
                } else if (
                    typeof message === "string" &&
                    message.toLowerCase().includes("failed to fetch")
                ) {
                    userMessage =
                        "Could not reach the server. Check that the agent is running and SERVER_BASE_URL is correct.";
                }

                setLinkGenerationError(userMessage);

                toast({
                    variant: "destructive",
                    title: "Could not create share link",
                    description: userMessage,
                });
                return null;
            } finally {
                setIsGeneratingLink(false);
            }
        };

        const pending = run();
        linkGenerationPromiseRef.current = pending;
        try {
            return await pending;
        } finally {
            linkGenerationPromiseRef.current = null;
        }
    }, [
        context?.agentId,
        context?.roomId,
        getShareBaseUrl,
        toast,
    ]);

    React.useEffect(() => {
        if (!open) return;
        if (!hasChatContext) return;
        if (sharedChatUrl) return;
        if (isGeneratingLink) return;
        void generateLink();
    }, [generateLink, hasChatContext, isGeneratingLink, open, sharedChatUrl]);

    React.useEffect(() => {
        if (!open) {
            lastContextKeyRef.current = null;
            return;
        }

        const nextKey = `${context?.agentId ?? ""}:${context?.roomId ?? ""}`;
        const lastKey = lastContextKeyRef.current;
        lastContextKeyRef.current = nextKey;

        if (!lastKey || lastKey === nextKey) {
            return;
        }

        setSelectedNetwork(null);
        setNetworkShareInFlight(null);
        setIsGeneratingLink(false);
        setSharedChatUrl(null);
        setLinkGenerationError(null);
        setRoomName(null);
        setIsGeneratingImage(false);
        setImageActionInFlight(null);
        setGeneratedImageBlob(null);
        setGeneratedImageKey(null);
    }, [context?.agentId, context?.roomId, open]);

    React.useEffect(() => {
        if (!open) return;
        if (!hasChatContext) return;
        if (roomName) return;
        void (async () => {
            const fetched = await getRoomName();
            setRoomName(fetched);
        })();
    }, [getRoomName, hasChatContext, open, roomName]);

    const networkShareUrls = React.useMemo(() => {
        const urlToShare = sharedChatUrl;
        if (!urlToShare) {
            return { linkedIn: null, reddit: null, x: null };
        }

        return {
            linkedIn: buildLinkedInShareUrl({ url: urlToShare }),
            reddit: buildRedditTextShareUrl({ url: urlToShare }),
            x: buildXShareUrl({ url: urlToShare }),
        };
    }, [sharedChatUrl]);

    const copyTextToClipboard = React.useCallback(async (text: string): Promise<boolean> => {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (error) {
                console.error("Failed to write text to clipboard via navigator.clipboard:", error);
            }
        }

        if (typeof document !== "undefined") {
            try {
                const textarea = document.createElement("textarea");
                textarea.value = text;
                textarea.setAttribute("readonly", "");
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                const successful = document.execCommand("copy");
                document.body.removeChild(textarea);
                return successful;
            } catch (error) {
                console.error("Fallback clipboard copy failed:", error);
            }
        }

        return false;
    }, []);

    const createChatLayoutImageBlob = React.useCallback(async (): Promise<Blob> => {
        if (typeof document === "undefined" || typeof window === "undefined") {
            throw new Error("Image export is only available in the browser.");
        }

        const exportNode = getShareExportRoot();
        if (!exportNode) {
            throw new Error("Couldn't find the chat area to export.");
        }

        window.dispatchEvent(
            new CustomEvent<{ roomId?: string }>("sentiedge:prepare-share-export", {
                detail: { roomId: context?.roomId },
            }),
        );
        try {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        const sourceIframes = Array.from(exportNode.querySelectorAll("iframe")) as HTMLIFrameElement[];
        if (sourceIframes.some((f) => isChartIframeSrc(f.src ?? ""))) {
            // Let React paint expanded share layout + chart iframes begin loading before we rasterize.
            await new Promise<void>((r) => setTimeout(r, 400));
        }
        const chartRasterUrls = await Promise.all(sourceIframes.map((iframe) => rasterizeChartIframe(iframe)));

        // Try to match the current on-screen layout width, but export the full scroll height.
        const rect = exportNode.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width || exportNode.clientWidth || 0));

        const clone = exportNode.cloneNode(true) as HTMLElement;

        clone.classList.add("share-export-snapshot");

        // Ensure the clone renders its full content (height finalized after offscreen measure).
        clone.style.width = `${width}px`;
        clone.style.minWidth = `${width}px`;
        clone.style.maxHeight = "none";
        clone.style.overflow = "visible";

        // Preserve form values (if any).
        const sourceElements = [exportNode, ...Array.from(exportNode.querySelectorAll("*"))];
        const targetElements = [clone, ...Array.from(clone.querySelectorAll("*"))];
        for (let index = 0; index < sourceElements.length; index += 1) {
            const sourceElement = sourceElements[index];
            const targetElement = targetElements[index] as Element | undefined;
            if (!sourceElement || !targetElement) continue;

            if (sourceElement instanceof HTMLTextAreaElement && targetElement instanceof HTMLTextAreaElement) {
                targetElement.value = sourceElement.value;
            }
            if (sourceElement instanceof HTMLInputElement && targetElement instanceof HTMLInputElement) {
                targetElement.value = sourceElement.value;
            }
        }

        const cloneIframes = Array.from(clone.querySelectorAll("iframe")) as HTMLIFrameElement[];
        for (let i = 0; i < cloneIframes.length; i++) {
            const sourceIframe = sourceIframes[i];
            const targetIframe = cloneIframes[i];
            if (!targetIframe) continue;

            const raster = chartRasterUrls[i];
            const src = sourceIframe?.src ?? "";

            if (raster) {
                const img = document.createElement("img");
                img.src = raster;
                img.alt = "Chart";
                img.style.width = "100%";
                img.style.height = "auto";
                img.style.display = "block";
                img.style.objectFit = "contain";
                if (sourceIframe) {
                    const iframeRect = sourceIframe.getBoundingClientRect();
                    if (iframeRect.height > 0) {
                        img.style.minHeight = `${Math.round(iframeRect.height)}px`;
                    }
                }
                targetIframe.replaceWith(img);
                continue;
            }

            const computed = sourceIframe ? window.getComputedStyle(sourceIframe) : null;
            const heightPx = computed?.height || "300px";
            const label = isChartIframeSrc(src)
                ? "Chart preview unavailable (wait for charts to load, then retry export)"
                : "Embedded content omitted in export";
            targetIframe.replaceWith(makeExportPlaceholder(label, heightPx));
        }

        // Replace elements that tend to break SVG foreignObject rendering (video, canvas).
        const replaceEmbedded = (
            selector: string,
            label: string
        ) => {
            const sourceNodes = Array.from(exportNode.querySelectorAll(selector));
            const targetNodes = Array.from(clone.querySelectorAll(selector));

            sourceNodes.forEach((sourceNode, index) => {
                const targetNode = targetNodes[index];
                if (!targetNode) return;

                const computed = window.getComputedStyle(sourceNode);
                const placeholder = document.createElement("div");
                placeholder.textContent = label;

                placeholder.style.display = "flex";
                placeholder.style.alignItems = "center";
                placeholder.style.justifyContent = "center";
                placeholder.style.width = "100%";
                placeholder.style.height = computed.height || "300px";
                placeholder.style.minHeight = computed.height || "300px";
                placeholder.style.borderRadius = computed.borderRadius || "12px";
                placeholder.style.border = "1px solid rgba(148, 163, 184, 0.6)";
                placeholder.style.background = "rgba(248, 250, 252, 0.9)";
                placeholder.style.color = "rgba(71, 85, 105, 0.95)";
                placeholder.style.fontSize = "12px";
                placeholder.style.fontFamily =
                    "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
                placeholder.style.overflow = "hidden";

                targetNode.replaceWith(placeholder);
            });
        };

        replaceEmbedded("video", "Embedded video omitted in export");
        replaceEmbedded("canvas", "Canvas content omitted in export");

        // Inline images as data-URLs to avoid cross-origin canvas tainting.
        const transparentPixel =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3f0Z8AAAAASUVORK5CYII=";

        const images = Array.from(exportNode.querySelectorAll("img"));
        const clonedImages = Array.from(clone.querySelectorAll("img"));

        const blobToDataUrl = (blob: Blob): Promise<string> =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = () => reject(new Error("Failed to read image data"));
                reader.readAsDataURL(blob);
            });

        const isSameOrigin = (src: string): boolean => {
            if (src.startsWith("data:") || src.startsWith("blob:")) {
                return true;
            }
            try {
                const url = new URL(src, window.location.href);
                return url.origin === window.location.origin;
            } catch {
                return true;
            }
        };

        await Promise.all(
            images.map(async (img, index) => {
                const target = clonedImages[index];
                if (!target) return;
                // Prevent the browser from choosing a different (possibly cross-origin) source.
                target.removeAttribute("srcset");
                target.removeAttribute("sizes");
                target.setAttribute("crossorigin", "anonymous");
                target.setAttribute("referrerpolicy", "no-referrer");

                const src = img.currentSrc || img.src;
                const alt = img.alt || "";

                if (!src) {
                    target.replaceWith(makeMarkdownImageExportFallback("", alt));
                    return;
                }

                if (!isSameOrigin(src)) {
                    const corsDataUrl = await fetchCrossOriginImageAsDataUrl(src);
                    if (corsDataUrl) {
                        target.src = corsDataUrl;
                        target.removeAttribute("crossorigin");
                        return;
                    }
                    target.replaceWith(makeMarkdownImageExportFallback(src, alt));
                    return;
                }

                try {
                    const response = await fetch(src, { credentials: "same-origin" });
                    if (!response.ok) {
                        target.replaceWith(makeMarkdownImageExportFallback(src, alt));
                        return;
                    }
                    const blob = await response.blob();
                    target.src = await blobToDataUrl(blob);
                } catch (error) {
                    console.warn("Failed to inline image for export:", error);
                    target.replaceWith(makeMarkdownImageExportFallback(src, alt));
                }
            })
        );

        // Sanitize SVG <image> tags (rare, but they can reference external URLs and taint exports).
        const svgImages = Array.from(clone.querySelectorAll("image"));
        for (const svgImage of svgImages) {
            const href =
                svgImage.getAttribute("href") ??
                svgImage.getAttribute("xlink:href") ??
                "";
            if (!href) continue;
            if (!isSameOrigin(href)) {
                svgImage.removeAttribute("href");
                svgImage.removeAttribute("xlink:href");
            }
        }

        scrubDomSubtreeForSvgCanvasExport(clone, transparentPixel);

        const measureShell = document.createElement("div");
        measureShell.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;visibility:hidden;pointer-events:none;`;
        measureShell.appendChild(clone);
        document.body.appendChild(measureShell);
        let exportHeight = Math.max(
            1,
            Math.round(Math.max(clone.scrollHeight, clone.getBoundingClientRect().height))
        );
        document.body.removeChild(measureShell);

        const maxExportHeight = 24000;
        if (exportHeight > maxExportHeight) {
            throw new Error("Chat is too long to export as a single image.");
        }

        clone.style.height = `${exportHeight}px`;
        const height = exportHeight;

        const collectCssText = (): string => {
            const sheets = Array.from(document.styleSheets ?? []);
            const cssParts: string[] = [];
            const urlRegex = /url\s*\(/i;

            for (const sheet of sheets) {
                try {
                    // Accessing cssRules for cross-origin sheets throws.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const rules = Array.from((sheet as any).cssRules ?? []) as CSSRule[];
                    for (const rule of rules) {
                        const cssText = rule?.cssText;
                        if (!cssText) continue;
                        // Avoid URL-based resources (fonts/background images) that can break/taint exports.
                        if (urlRegex.test(cssText)) continue;
                        cssParts.push(cssText);
                    }
                } catch (_error) {
                    // ignore
                }
            }

            return cssParts.join("\n");
        };

        const wrapper = document.createElement("div");
        wrapper.className = document.documentElement.className || "";
        wrapper.style.width = `${width}px`;
        wrapper.style.height = `${height}px`;
        wrapper.style.margin = "0";
        wrapper.style.padding = "0";
        wrapper.style.display = "block";
        const backgroundColor =
            window.getComputedStyle(exportNode).backgroundColor ||
            window.getComputedStyle(document.body).backgroundColor ||
            "#ffffff";
        wrapper.style.backgroundColor = backgroundColor;

        const styleNode = document.createElement("style");
        styleNode.textContent = `${SHARE_SNAPSHOT_DOM_CSS}\n${collectCssText()}\n*{print-color-adjust:exact;-webkit-print-color-adjust:exact;}`;
        wrapper.appendChild(styleNode);
        wrapper.appendChild(clone);

        // Wait for web fonts when available (helps match on-screen layout).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fontsReady = (document as any).fonts?.ready as Promise<unknown> | undefined;
        if (fontsReady) {
            try {
                await fontsReady;
            } catch {
                // ignore
            }
        }

        const maxCanvasDim = 16384;
        if (width > maxCanvasDim || height > maxCanvasDim) {
            throw new Error("Chat is too large to export as a single image.");
        }

        const pixelRatio = Math.min(2, Math.ceil(window.devicePixelRatio || 1));

        const exportHost = document.createElement("div");
        exportHost.style.cssText =
            "position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;z-index:-9999;overflow:visible";
        exportHost.style.width = `${width}px`;
        exportHost.style.minHeight = `${height}px`;
        exportHost.style.backgroundColor = backgroundColor;
        exportHost.appendChild(wrapper);

        document.body.appendChild(exportHost);
        try {
            const { toBlob } = await import("html-to-image");
            const opts = {
                width,
                height,
                backgroundColor,
                pixelRatio,
                skipFonts: true,
                cacheBust: true,
            } as const;

            let blob: Blob | null = null;
            try {
                blob = await toBlob(wrapper, opts);
            } catch (firstErr) {
                console.warn("Share export: html-to-image on wrapper failed:", firstErr);
            }
            if (!blob || blob.size === 0) {
                try {
                    blob = await toBlob(exportHost, opts);
                } catch (secondErr) {
                    console.warn("Share export: html-to-image on export host failed:", secondErr);
                }
            }
            if (!blob || blob.size === 0) {
                throw new Error("Share export produced an empty image.");
            }
            return blob;
        } finally {
            exportHost.remove();
        }
        } finally {
            window.dispatchEvent(new Event("sentiedge:share-export-done"));
        }
    }, [context?.roomId]);

    const getTranscriptMessages = React.useCallback(async (): Promise<TranscriptMessage[]> => {
        const agentId = context?.agentId;
        const roomId = context?.roomId;
        if (!agentId || !roomId) {
            return [];
        }

        const response = await apiClient.getMessages(agentId, roomId);
        const memories = Array.isArray(response?.memories) ? response.memories : [];

        let sourceMemories = memories;
        let focusKey: string | null = null;
        if (typeof document !== "undefined") {
            const lastFocused = getFocusedShareExportEl();
            focusKey = lastFocused?.getAttribute("data-share-focus-key") ?? null;
            if (focusKey) {
                const colonIdx = focusKey.indexOf(":");
                if (colonIdx !== -1) {
                    const phase = focusKey.slice(0, colonIdx);
                    const action = focusKey.slice(colonIdx + 1);
                    if (phase && action && action !== "__phase_all__") {
                        sourceMemories = sourceMemories.filter((memory: any) => {
                            const meta = memory?.content?.metadata ?? memory?.metadata ?? {};
                            const memPhase = typeof meta.phase === "string" ? meta.phase : "";
                            const memAction =
                                typeof meta.action === "string"
                                    ? meta.action
                                    : typeof meta.actionName === "string"
                                      ? meta.actionName
                                      : "";
                            return memPhase === phase && memAction === action;
                        });
                    } else if (phase) {
                        sourceMemories = sourceMemories.filter((memory: any) => {
                            const meta = memory?.content?.metadata ?? memory?.metadata ?? {};
                            return (meta.phase as string) === phase;
                        });
                    }
                } else if (!focusKey.includes(":")) {
                    // Task-chain share: bare task id. Comprehensive uses "phase:action" or ":__phase_all__".
                    sourceMemories = sourceMemories.filter((memory: any) => {
                        const meta = memory?.content?.metadata ?? memory?.metadata ?? {};
                        return meta.taskId === focusKey;
                    });
                }
            }
            // Stored metadata often doesn't match UI phase/action/task ids; empty filter would break image export.
            if (focusKey && sourceMemories.length === 0 && memories.length > 0) {
                sourceMemories = memories;
            }
        }

        const mapped = sourceMemories
            .map((memory: any, index: number) => {
                const rawText =
                    typeof memory?.content?.text === "string" ? (memory.content.text as string) : "";
                const text = rawText.trim().length > 0 ? rawText : "";
                const createdAt =
                    typeof memory?.createdAt === "number"
                        ? (memory.createdAt as number)
                        : undefined;
                return {
                    id: typeof memory?.id === "string" ? (memory.id as string) : undefined,
                    text,
                    user: memory?.userId === agentId ? ("system" as const) : ("user" as const),
                    createdAt,
                    __index: index,
                };
            })
            .filter((message) => message.text.trim().length > 0);

        const seenIds = new Set(
            mapped
                .map((m) => m.id)
                .filter((id): id is string => typeof id === "string" && id.length > 0),
        );

        const syntheticRows: Array<TranscriptMessage & { __index: number }> = [];
        if (memories.length > 0) {
            const isPhaseScopedFocus = Boolean(focusKey && focusKey.includes(":"));
            let synIdx = 0;
            for (const memory of memories) {
                const raw = memory?.content ?? {};
                const source = raw.source;
                if (source !== "task_chain_summary") continue;
                const meta = raw.metadata ?? {};
                const snap = meta.taskChainSnapshot;
                const extras = messagesFromTaskChainSnapshot(snap, {
                    userId: memory.userId,
                    agentId: memory.agentId ?? agentId,
                    roomId: memory.roomId,
                    createdAt: typeof memory.createdAt === "number" ? memory.createdAt : 0,
                });
                for (const extra of extras) {
                    if (isPhaseScopedFocus) continue;
                    if (focusKey && !focusKey.includes(":")) {
                        const tid = (extra as any)?.content?.metadata?.taskId;
                        if (tid !== focusKey) continue;
                    }
                    const eid = extra.id !== undefined && extra.id !== null ? String(extra.id) : "";
                    if (eid && seenIds.has(eid)) continue;
                    const text = (extra.text ?? "").trim();
                    if (!text) continue;
                    syntheticRows.push({
                        id: eid || undefined,
                        text,
                        user: transcriptUserFromSnapshotExtra(extra, agentId),
                        createdAt: extra.createdAt,
                        __index: 1_000_000 + synIdx,
                    });
                    synIdx += 1;
                    if (eid) seenIds.add(eid);
                }
            }

            let compSynIdx = 0;
            for (const memory of memories) {
                const meta = memory?.content?.metadata ?? {};
                const snap = meta.comprehensiveSnapshot;
                if (!snap) continue;
                const extras = messagesFromComprehensiveSnapshot(snap, {
                    userId: memory.userId,
                    agentId: memory.agentId ?? agentId,
                    roomId: memory.roomId,
                    createdAt: typeof memory.createdAt === "number" ? memory.createdAt : 0,
                });
                for (const extra of extras) {
                    const m = (extra as any)?.content?.metadata ?? {};
                    if (focusKey && focusKey.includes(":")) {
                        const colonIdx = focusKey.indexOf(":");
                        const phase = focusKey.slice(0, colonIdx);
                        const action = focusKey.slice(colonIdx + 1);
                        // ":__phase_all__" means all phases; only filter by action when set.
                        if (phase && m.phase !== phase) continue;
                        if (action && action !== "__phase_all__" && m.action !== action && m.actionName !== action) {
                            continue;
                        }
                    } else if (focusKey && !focusKey.includes(":")) {
                        continue;
                    }
                    const eid = extra.id !== undefined && extra.id !== null ? String(extra.id) : "";
                    if (eid && seenIds.has(eid)) continue;
                    const text = (extra.text ?? "").trim();
                    if (!text) continue;
                    syntheticRows.push({
                        id: eid || undefined,
                        text,
                        user: transcriptUserFromSnapshotExtra(extra, agentId),
                        createdAt: extra.createdAt,
                        __index: 2_000_000 + compSynIdx,
                    });
                    compSynIdx += 1;
                    if (eid) seenIds.add(eid);
                }
            }
        }

        const combined = [...mapped, ...syntheticRows];

        combined.sort((a, b) => {
            const aTime = a.createdAt ?? Number.NEGATIVE_INFINITY;
            const bTime = b.createdAt ?? Number.NEGATIVE_INFINITY;
            if (aTime !== bTime) return aTime - bTime;
            return a.__index - b.__index;
        });

        return combined.map(({ __index: _index, ...message }) => message);
    }, [context?.agentId, context?.roomId]);

    const openNetworkShare = React.useCallback(
        async (network: "linkedin" | "reddit" | "x") => {
            try {
                if (!hasChatContext) return;
                if (networkShareInFlight) return;

                setSelectedNetwork(network);
                setNetworkShareInFlight(network);

                const urlToShare = await generateLink();
                if (!urlToShare) return;

                if (
                    network === "linkedin" &&
                    !ALLOW_LOCAL_SHARE &&
                    isLocalhostShareUrl(urlToShare)
                ) {
                    toast({
                        variant: "destructive",
                        title: "LinkedIn share needs a public URL",
                        description:
                            "Set VITE_SHARE_BASE_URL to your public app domain (not localhost), then try again. To bypass for local testing, set VITE_ALLOW_LOCAL_SHARE=true.",
                    });
                    return;
                }
                const url =
                    network === "linkedin"
                        ? buildLinkedInShareUrl({ url: urlToShare })
                        : network === "reddit"
                          ? buildRedditTextShareUrl({ url: urlToShare })
                          : buildXShareUrl({ url: urlToShare });

                // Open the share window synchronously so it stays inside the user-gesture
                // context — Safari and strict popup blockers reject window.open after an await.
                window.open(url, "_blank", "noopener,noreferrer");

                if (network === "linkedin") {
                    const copied = await copyTextToClipboard(`${SHARE_SOCIAL_POST_LINE}\n${urlToShare}`);
                    if (copied) {
                        toast({
                            title: "Copied share text",
                            description: "LinkedIn may not prefill text. Paste the copied message into the post.",
                        });
                    }
                }
            } catch (error) {
                console.error("Failed to open share composer:", error);
                toast({
                    variant: "destructive",
                    title: "Share failed",
                    description: error instanceof Error ? error.message : "Please try again.",
                });
            } finally {
                setNetworkShareInFlight(null);
            }
        },
        [
            copyTextToClipboard,
            generateLink,
            hasChatContext,
            networkShareInFlight,
            toast,
        ]
    );

    const createTranscriptImageBlob = React.useCallback(async (): Promise<Blob> => {
        if (typeof document === "undefined") {
            throw new Error("Image export is only available in the browser.");
        }

        const messages = await getTranscriptMessages();
        if (messages.length === 0) {
            throw new Error("No messages found in this chat yet.");
        }

        const roomName = await getRoomName();

        const exportNode = getShareExportRoot();
        const exportWidth = exportNode?.getBoundingClientRect().width ?? 900;
        const width = Math.max(720, Math.min(1100, Math.round(exportWidth)));

        const outerPadding = 24;
        const bubblePaddingX = 14;
        const bubblePaddingY = 12;
        const bubbleMaxWidth = Math.min(720, width - outerPadding * 2);
        const messageGap = 14;
        const headerHeight = 64;
        const footerHeight = 18;

        const fontBody = "14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        const fontHeading1 = "18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        const fontHeading2 = "16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        const fontCode =
            "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace";

        const lineHeightBody = 20;
        const lineHeightHeading = 22;
        const lineHeightCode = 18;

        const stripInlineMarkdown = (text: string): string =>
            text
                .replace(/\*\*(.*?)\*\*/g, "$1")
                .replace(/__(.*?)__/g, "$1")
                .replace(/\*(.*?)\*/g, "$1")
                .replace(/_(.*?)_/g, "$1")
                .replace(/`([^`]+)`/g, "$1")
                .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1");

        type MarkdownBlock =
            | { type: "heading"; level: number; text: string }
            | { type: "paragraph"; text: string }
            | { type: "code"; text: string }
            | { type: "table"; header: string[]; rows: string[][] };

        const parseMarkdownBlocks = (input: string): MarkdownBlock[] => {
            const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
            const blocks: MarkdownBlock[] = [];

            const isSeparatorLine = (line: string): boolean => {
                const trimmed = line.trim();
                if (!trimmed) return false;
                const withoutPipes = trimmed.replace(/\|/g, "");
                return /^[\s:-]+$/.test(withoutPipes);
            };

            const splitTableRow = (line: string): string[] => {
                const trimmed = line.trim();
                const withoutOuter =
                    trimmed.startsWith("|") && trimmed.endsWith("|")
                        ? trimmed.slice(1, -1)
                        : trimmed;
                return withoutOuter.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
            };

            let i = 0;
            while (i < lines.length) {
                const line = lines[i] ?? "";
                const trimmed = line.trimEnd();
                const leadTrimmed = trimmed.trimStart();

                if (leadTrimmed.startsWith("```")) {
                    const codeLines: string[] = [];
                    i += 1;
                    while (i < lines.length) {
                        const codeLine = lines[i] ?? "";
                        const codeLead = codeLine.trimStart();
                        if (codeLead.startsWith("```")) break;
                        codeLines.push(codeLine);
                        i += 1;
                    }
                    i += 1;
                    blocks.push({ type: "code", text: codeLines.join("\n") });
                    continue;
                }

                /** ATX headings: allow indentation (trimmed), optional space after hashes, non-empty title. */
                const headingMatch = leadTrimmed.match(/^(#{1,6})\s+(.+)$/);
                const headingCompact =
                    !headingMatch && /^#{2,6}/.test(leadTrimmed)
                        ? leadTrimmed.match(/^(#{2,6})([^\s#].*)$/)
                        : null;
                if (headingMatch || headingCompact) {
                    const hashes = headingMatch?.[1] ?? headingCompact?.[1] ?? "#";
                    const rawTitle = headingMatch?.[2] ?? headingCompact?.[2] ?? "";
                    blocks.push({
                        type: "heading",
                        level: Math.min(6, hashes.length),
                        text: stripInlineMarkdown(rawTitle).trim(),
                    });
                    i += 1;
                    continue;
                }

                const next = lines[i + 1] ?? "";
                if (trimmed.includes("|") && isSeparatorLine(next)) {
                    const header = splitTableRow(trimmed);
                    const rows: string[][] = [];
                    i += 2;
                    while (i < lines.length) {
                        const rowLine = (lines[i] ?? "").trim();
                        if (!rowLine || !rowLine.includes("|")) break;
                        rows.push(splitTableRow(rowLine));
                        i += 1;
                    }
                    blocks.push({ type: "table", header, rows });
                    continue;
                }

                if (!leadTrimmed) {
                    i += 1;
                    continue;
                }

                const paragraphLines: string[] = [];
                while (i < lines.length) {
                    const current = lines[i] ?? "";
                    const currentTrim = current.trimEnd();
                    const currentLead = currentTrim.trimStart();
                    const upcoming = lines[i + 1] ?? "";
                    if (!currentLead) break;
                    if (currentLead.startsWith("```")) break;
                    if (/^(#{1,6})\s+/.test(currentLead)) break;
                    if (/^#{2,6}[^\s#]/.test(currentLead)) break;
                    if (currentTrim.includes("|") && isSeparatorLine(upcoming)) break;
                    paragraphLines.push(currentTrim);
                    i += 1;
                }
                blocks.push({
                    type: "paragraph",
                    text: stripInlineMarkdown(paragraphLines.join("\n")).trim(),
                });
            }

            return blocks;
        };

        const wrapText = (
            ctx: CanvasRenderingContext2D,
            text: string,
            maxWidth: number
        ): string[] => {
            const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const paragraphs = normalized.split("\n");
            const lines: string[] = [];

            for (const paragraph of paragraphs) {
                const words = paragraph.split(/\s+/).filter(Boolean);
                if (words.length === 0) {
                    lines.push("");
                    continue;
                }
                let current = words[0] ?? "";
                for (let index = 1; index < words.length; index += 1) {
                    const next = `${current} ${words[index]}`;
                    if (ctx.measureText(next).width <= maxWidth) {
                        current = next;
                        continue;
                    }
                    lines.push(current);
                    current = words[index] ?? "";
                }
                lines.push(current);
            }

            const hardBroken: string[] = [];
            for (const line of lines) {
                if (ctx.measureText(line).width <= maxWidth) {
                    hardBroken.push(line);
                    continue;
                }
                let remaining = line;
                while (remaining.length > 0) {
                    let splitIndex = Math.min(remaining.length, 48);
                    while (
                        splitIndex > 1 &&
                        ctx.measureText(remaining.slice(0, splitIndex)).width > maxWidth
                    ) {
                        splitIndex -= 1;
                    }
                    hardBroken.push(remaining.slice(0, splitIndex));
                    remaining = remaining.slice(splitIndex);
                }
            }

            return hardBroken;
        };

        const drawRoundedRect = (
            ctx: CanvasRenderingContext2D,
            x: number,
            y: number,
            w: number,
            h: number,
            r: number
        ) => {
            const radius = Math.min(r, w / 2, h / 2);
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.arcTo(x + w, y, x + w, y + h, radius);
            ctx.arcTo(x + w, y + h, x, y + h, radius);
            ctx.arcTo(x, y + h, x, y, radius);
            ctx.arcTo(x, y, x + w, y, radius);
            ctx.closePath();
        };

        const measureCanvas = document.createElement("canvas");
        const measureCtx = measureCanvas.getContext("2d");
        if (!measureCtx) {
            throw new Error("Unable to create canvas context");
        }

        const textMaxWidth = bubbleMaxWidth - bubblePaddingX * 2;

        type MeasuredBlock =
            | { type: "heading"; level: number; lines: string[]; height: number }
            | { type: "paragraph"; lines: string[]; height: number }
            | { type: "code"; lines: string[]; height: number }
            | {
                  type: "table";
                  columns: number;
                  colWidths: number[];
                  headerCells: string[][];
                  rowCells: string[][][];
                  rowHeights: number[];
                  height: number;
              };

        const measureTable = (
            header: string[],
            rows: string[][]
        ): Omit<Extract<MeasuredBlock, { type: "table" }>, "type"> => {
            const columns = Math.max(header.length, ...rows.map((r) => r.length), 1);
            const normalizedHeader = Array.from({ length: columns }, (_, idx) => header[idx] ?? "");
            const normalizedRows = rows.map((row) =>
                Array.from({ length: columns }, (_, idx) => row[idx] ?? "")
            );

            const paddingX = 10;
            const paddingY = 8;
            const availableWidth = textMaxWidth;

            measureCtx.font = fontBody;
            const maxCellWidth = 260;
            const minCellWidth = 70;
            const colMax: number[] = Array.from({ length: columns }, () => minCellWidth);

            const considerCell = (value: string, col: number) => {
                const w = Math.min(
                    maxCellWidth,
                    Math.ceil(measureCtx.measureText(value).width) + paddingX * 2
                );
                colMax[col] = Math.max(colMax[col] ?? minCellWidth, w);
            };

            normalizedHeader.forEach((cell, col) => considerCell(cell, col));
            normalizedRows.forEach((row) => row.forEach((cell, col) => considerCell(cell, col)));

            const totalDesired = colMax.reduce((sum, w) => sum + w, 0);
            let colWidths = [...colMax];
            if (totalDesired > availableWidth) {
                const scale = availableWidth / totalDesired;
                colWidths = colMax.map((w) => Math.max(minCellWidth, Math.floor(w * scale)));
                const after = colWidths.reduce((sum, w) => sum + w, 0);
                const diff = availableWidth - after;
                if (diff > 0) {
                    colWidths[columns - 1] = (colWidths[columns - 1] ?? minCellWidth) + diff;
                }
            } else if (totalDesired < availableWidth) {
                colWidths[columns - 1] =
                    (colWidths[columns - 1] ?? minCellWidth) + (availableWidth - totalDesired);
            }

            const wrapCell = (value: string, colWidth: number): string[] => {
                const maxWidth = Math.max(1, colWidth - paddingX * 2 - 2);
                return wrapText(measureCtx, value, maxWidth);
            };

            const headerCells = normalizedHeader.map((cell, idx) =>
                wrapCell(cell, colWidths[idx] ?? minCellWidth)
            );
            const rowCells = normalizedRows.map((row) =>
                row.map((cell, idx) => wrapCell(cell, colWidths[idx] ?? minCellWidth))
            );

            const rowHeights: number[] = [];
            const headerHeight =
                Math.max(1, ...headerCells.map((lines) => lines.length)) * lineHeightBody +
                paddingY * 2;
            rowHeights.push(headerHeight);
            for (const row of rowCells) {
                const maxLines = Math.max(1, ...row.map((lines) => lines.length));
                rowHeights.push(maxLines * lineHeightBody + paddingY * 2);
            }

            const height = rowHeights.reduce((sum, h) => sum + h, 0) + 1;
            return { columns, colWidths, headerCells, rowCells, rowHeights, height };
        };

        const measuredMessages = messages.map((message) => {
            const blocks = parseMarkdownBlocks(message.text);
            const measuredBlocks: MeasuredBlock[] = [];
            let contentHeight = 0;

            for (const block of blocks) {
                if (block.type === "heading") {
                    measureCtx.font = block.level <= 2 ? fontHeading1 : fontHeading2;
                    const lines = wrapText(measureCtx, block.text, textMaxWidth);
                    const height = lines.length * lineHeightHeading + 6;
                    measuredBlocks.push({ type: "heading", level: block.level, lines, height });
                    contentHeight += height + 6;
                    continue;
                }

                if (block.type === "code") {
                    measureCtx.font = fontCode;
                    const lines = block.text
                        .split("\n")
                        .flatMap((l) => wrapText(measureCtx, l, textMaxWidth - 18));
                    const height = Math.max(1, lines.length) * lineHeightCode + 16;
                    measuredBlocks.push({ type: "code", lines, height });
                    contentHeight += height + 8;
                    continue;
                }

                if (block.type === "table") {
                    const tableMeasured = measureTable(block.header, block.rows);
                    measuredBlocks.push({ type: "table", ...tableMeasured });
                    contentHeight += tableMeasured.height + 10;
                    continue;
                }

                measureCtx.font = fontBody;
                const lines = wrapText(measureCtx, block.text, textMaxWidth);
                const height = Math.max(1, lines.length) * lineHeightBody;
                measuredBlocks.push({ type: "paragraph", lines, height });
                contentHeight += height + 6;
            }

            const bubbleHeight = contentHeight + bubblePaddingY * 2;
            return { ...message, measuredBlocks, bubbleHeight };
        });

        let height = outerPadding + headerHeight + messageGap;
        for (const message of measuredMessages) {
            height += message.bubbleHeight + messageGap;
        }
        height += footerHeight + outerPadding;

        const maxCanvasHeight = 24000;
        if (height > maxCanvasHeight) {
            throw new Error("Chat is too long to export as a single image.");
        }

        const desiredScale = 2;
        const maxDim = 16384;
        const maxScaleW = Math.max(1, Math.floor(maxDim / width));
        const maxScaleH = Math.max(1, Math.floor(maxDim / height));
        const scale = Math.max(1, Math.min(desiredScale, maxScaleW, maxScaleH));

        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            throw new Error("Unable to create canvas context");
        }
        ctx.scale(scale, scale);

        const bg = window.getComputedStyle(document.body).backgroundColor || "#ffffff";
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        // Colors from theme (so header/footer stay readable in dark mode)
        const probe = document.createElement("div");
        probe.style.position = "fixed";
        probe.style.left = "-9999px";
        probe.style.top = "-9999px";
        document.body.appendChild(probe);
        const getBgForClass = (className: string): string => {
            probe.className = className;
            return window.getComputedStyle(probe).backgroundColor || "#ffffff";
        };
        const getTextForClass = (className: string): string => {
            probe.className = className;
            return window.getComputedStyle(probe).color || "#0f172a";
        };
        const bubbleSystemFill = getBgForClass("bg-secondary");
        const bubbleSystemText = getTextForClass("text-secondary-foreground");
        const bubbleUserFill = getBgForClass("bg-primary");
        const bubbleUserText = getTextForClass("text-primary-foreground");
        const headerTitleColor = getTextForClass("text-foreground");
        const headerSubColor = getTextForClass("text-muted-foreground");
        document.body.removeChild(probe);

        const fitSingleLine = (
            ctx2: CanvasRenderingContext2D,
            text: string,
            maxWidth: number
        ): string => {
            const trimmed = text.trim();
            if (ctx2.measureText(trimmed).width <= maxWidth) {
                return trimmed;
            }
            const ellipsis = "…";
            let lo = 0;
            let hi = trimmed.length;
            while (lo < hi) {
                const mid = Math.floor((lo + hi) / 2);
                const candidate = `${trimmed.slice(0, mid)}${ellipsis}`;
                if (ctx2.measureText(candidate).width <= maxWidth) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            const cut = Math.max(0, lo - 1);
            return `${trimmed.slice(0, cut)}${ellipsis}`;
        };

        ctx.fillStyle = headerTitleColor;
        ctx.font = fontHeading1;
        const title = roomName ?? "Chat";
        ctx.fillText(fitSingleLine(ctx, title, width - outerPadding * 2), outerPadding, outerPadding + 28);
        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.fillStyle = headerSubColor;
        ctx.fillText("Shareable snapshot", outerPadding, outerPadding + 48);

        let y = outerPadding + headerHeight;
        const bubbleRadius = 16;

        for (const message of measuredMessages) {
            const isSystem = message.user === "system";
            const bubbleWidth = bubbleMaxWidth;
            const x = isSystem ? outerPadding : width - outerPadding - bubbleWidth;

            drawRoundedRect(ctx, x, y, bubbleWidth, message.bubbleHeight, bubbleRadius);
            ctx.fillStyle = isSystem ? bubbleSystemFill : bubbleUserFill;
            ctx.fill();

            let cursorY = y + bubblePaddingY;
            const contentX = x + bubblePaddingX;
            const contentW = bubbleWidth - bubblePaddingX * 2;

            for (const block of message.measuredBlocks as MeasuredBlock[]) {
                if (block.type === "heading") {
                    ctx.fillStyle = isSystem ? bubbleSystemText : bubbleUserText;
                    ctx.font = block.level <= 2 ? fontHeading1 : fontHeading2;
                    cursorY += 2;
                    for (const line of block.lines) {
                        ctx.fillText(line, contentX, cursorY + lineHeightHeading - 6, contentW);
                        cursorY += lineHeightHeading;
                    }
                    cursorY += 8;
                    continue;
                }

                if (block.type === "code") {
                    const codePadX = 10;
                    const codePadY = 8;
                    drawRoundedRect(ctx, contentX, cursorY, contentW, block.height, 12);
                    ctx.fillStyle = "rgba(148, 163, 184, 0.20)";
                    ctx.fill();
                    ctx.font = fontCode;
                    ctx.fillStyle = isSystem ? bubbleSystemText : bubbleUserText;
                    let ty = cursorY + codePadY + lineHeightCode - 6;
                    for (const line of block.lines) {
                        ctx.fillText(line, contentX + codePadX, ty, contentW - codePadX * 2);
                        ty += lineHeightCode;
                    }
                    cursorY += block.height + 10;
                    continue;
                }

                if (block.type === "table") {
                    const paddingX = 10;
                    const paddingY = 8;
                    const border = "rgba(148, 163, 184, 0.55)";
                    const headerBg = "rgba(148, 163, 184, 0.22)";
                    ctx.font = fontBody;

                    let rowY = cursorY;
                    const tableX = contentX;

                    const drawRow = (cells: string[][], rowH: number, isHeader: boolean) => {
                        let colX = tableX;
                        for (let col = 0; col < block.columns; col += 1) {
                            const colW = block.colWidths[col] ?? 80;
                            ctx.fillStyle = isHeader ? headerBg : "rgba(255,255,255,0.0)";
                            ctx.fillRect(colX, rowY, colW, rowH);
                            ctx.strokeStyle = border;
                            ctx.lineWidth = 1;
                            ctx.strokeRect(colX, rowY, colW, rowH);

                            ctx.fillStyle = isSystem ? bubbleSystemText : bubbleUserText;
                            const lines = cells[col] ?? [""];
                            let ty = rowY + paddingY + lineHeightBody - 6;
                            for (const line of lines) {
                                ctx.fillText(line, colX + paddingX, ty, colW - paddingX * 2);
                                ty += lineHeightBody;
                            }
                            colX += colW;
                        }
                        rowY += rowH;
                    };

                    drawRow(block.headerCells, block.rowHeights[0] ?? 36, true);
                    for (let r = 0; r < block.rowCells.length; r += 1) {
                        drawRow(block.rowCells[r] ?? [], block.rowHeights[r + 1] ?? 32, false);
                    }

                    cursorY += block.height + 10;
                    continue;
                }

                ctx.font = fontBody;
                ctx.fillStyle = isSystem ? bubbleSystemText : bubbleUserText;
                for (const line of block.lines) {
                    ctx.fillText(line, contentX, cursorY + lineHeightBody - 6, contentW);
                    cursorY += lineHeightBody;
                }
                cursorY += 6;
            }

            y += message.bubbleHeight + messageGap;
        }

        ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
        ctx.fillStyle = headerSubColor;
        ctx.fillText("sentiedge.ai", outerPadding, height - outerPadding);

        try {
            const transcriptBlob = await new Promise<Blob | null>((resolve) => {
                try {
                    canvas.toBlob((result) => resolve(result), "image/png");
                } catch {
                    resolve(null);
                }
            });
            if (transcriptBlob && transcriptBlob.size > 0) {
                return transcriptBlob;
            }
        } catch {
            /* fall through */
        }

        throw new Error(
            "Could not export transcript image (browser blocked canvas export). Try again or use a different browser.",
        );
    }, [getRoomName, getTranscriptMessages]);

    const createChatImageBlob = React.useCallback(async (): Promise<Blob> => {
        const focused = typeof document !== "undefined" ? getFocusedShareExportEl() : null;
        // Task chain / comprehensive: try DOM snapshot of the viewed panel first.
        if (focused) {
            try {
                return await createChatLayoutImageBlob();
            } catch (error) {
                console.warn(
                    "DOM layout export failed (falling back to transcript canvas):",
                    error
                );
                return await createTranscriptImageBlob();
            }
        }
        // Whole-room chat: prefer DOM snapshot so `/charts/` embeds can be rasterized into the PNG.
        try {
            return await createChatLayoutImageBlob();
        } catch (error) {
            console.warn(
                "DOM layout export failed (falling back to transcript canvas):",
                error
            );
            return await createTranscriptImageBlob();
        }
    }, [createChatLayoutImageBlob, createTranscriptImageBlob]);

    const ensureGeneratedImage = React.useCallback(async (): Promise<Blob> => {
        const agentId = context?.agentId;
        const roomId = context?.roomId;
        if (!agentId || !roomId) {
            throw new Error("Open a chat room first.");
        }

        const focusEl = typeof document !== "undefined" ? getFocusedShareExportEl() : null;
        const focusKey = focusEl?.getAttribute("data-share-focus-key") ?? "full";
        const key = `${agentId}:${roomId}:${focusKey}`;
        if (generatedImageBlob && generatedImageKey === key) {
            return generatedImageBlob;
        }

        setIsGeneratingImage(true);
        try {
            const blob = await createChatImageBlob();
            setGeneratedImageBlob(blob);
            setGeneratedImageKey(key);
            return blob;
        } finally {
            setIsGeneratingImage(false);
        }
    }, [context?.agentId, context?.roomId, createChatImageBlob, generatedImageBlob, generatedImageKey]);

    const copyImageToClipboard = React.useCallback(async () => {
        try {
            setImageActionInFlight("copy");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ClipboardItemCtor = (window as any).ClipboardItem as
                | (new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem)
                | undefined;
            if (!navigator.clipboard?.write || !ClipboardItemCtor) {
                throw new Error("Clipboard image copy is not supported in this browser.");
            }

            // Important: Call `clipboard.write` within the click gesture. Provide a promise for the data.
            await navigator.clipboard.write([
                new ClipboardItemCtor({
                    "image/png": ensureGeneratedImage(),
                }),
            ]);

            toast({
                title: "Copied",
                description: "Chat image copied to clipboard.",
            });
        } catch (error) {
            console.error("Copy image failed:", error);
            toast({
                variant: "destructive",
                title: "Copy failed",
                description: error instanceof Error ? error.message : "Please try again.",
            });
        } finally {
            setImageActionInFlight(null);
        }
    }, [ensureGeneratedImage, toast]);

    const downloadImage = React.useCallback(async () => {
        try {
            setImageActionInFlight("download");
            const blob = await ensureGeneratedImage();
            if (!blob || blob.size === 0) {
                throw new Error("Generated image was empty.");
            }
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "sentiedge-chat.png";
            anchor.rel = "noopener";
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            // Revoke after the browser has picked up the download (immediate revoke can cancel it).
            window.setTimeout(() => URL.revokeObjectURL(url), 250);
        } catch (error) {
            console.error("Download image failed:", error);
            toast({
                variant: "destructive",
                title: "Download failed",
                description: error instanceof Error ? error.message : "Please try again.",
            });
        } finally {
            setImageActionInFlight(null);
        }
    }, [ensureGeneratedImage, toast]);

		    React.useEffect(() => {
		        if (!open) {
		            setSelectedNetwork(null);
		            setIsGeneratingLink(false);
		            setSharedChatUrl(null);
		            setLinkGenerationError(null);
		            setRoomName(null);
		            setIsGeneratingImage(false);
		            setImageActionInFlight(null);
		            setGeneratedImageBlob(null);
		            setGeneratedImageKey(null);
		        }
		    }, [open]);

    const networkCircleClassName =
        "h-12 w-12 rounded-full p-0 border border-slate-200/80 bg-white/40 shadow-sm transition-colors hover:bg-white/60 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10";
    const networkCircleSelectedClassName =
        "ring-2 ring-ring ring-offset-2 ring-offset-background";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>How do you want to share?</DialogTitle>
                    <DialogDescription>
                        Choose a format, or share directly to your network.
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-4 space-y-4">
                    <div className="rounded-2xl border border-slate-200/70 dark:border-white/15 bg-white/35 dark:bg-white/5 p-3">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm font-medium">
                                <Link2 className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                                Share link
                            </div>
                        </div>
                        {!hasChatContext ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                                Open a chat room first to generate a shareable link.
                            </div>
                        ) : null}
                        <div className="mt-2 flex items-center gap-2">
                            <Input
                                readOnly
                                value={isGeneratingLink ? "Generating…" : sharedChatUrl ?? ""}
                                placeholder="Link will appear here"
                                className="h-9 bg-white/50 dark:bg-slate-900/40"
                            />
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-9 w-9"
                                disabled={!sharedChatUrl || isGeneratingLink}
                                onClick={async () => {
                                    if (!sharedChatUrl) return;
                                    const didCopy = await copyTextToClipboard(sharedChatUrl);
                                    toast({
                                        title: didCopy ? "Copied" : "Copy failed",
                                        description: didCopy
                                            ? "Link copied to clipboard."
                                            : "Please copy it manually.",
                                    });
                                }}
                                aria-label="Copy link"
                            >
                                <Copy className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="outline"
                                size="icon"
                                className="h-9 w-9"
                                disabled={!sharedChatUrl || isGeneratingLink}
                                onClick={() => {
                                    if (!sharedChatUrl) return;
                                    window.open(sharedChatUrl, "_blank", "noopener,noreferrer");
                                }}
                                aria-label="Open link"
                            >
                                <ExternalLink className="h-4 w-4" />
                            </Button>
	                        </div>
	                        <div className="mt-2 text-xs text-muted-foreground">
	                            {sharedChatUrl
	                                ? "Copy or open this link to share this chat."
	                                : isGeneratingLink
	                                    ? "Generating a shareable link for this chat."
	                                    : "Share link will appear here once ready."}
	                        </div>
	                        {linkGenerationError ? (
	                            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
	                                {linkGenerationError}
	                            </div>
	                        ) : null}
	                        {isGeneratingLink ? (
	                            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
	                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
	                                Generating…
	                            </div>
	                        ) : null}
	                    </div>

	                    <div className="rounded-2xl border border-slate-200/70 dark:border-white/15 bg-white/35 dark:bg-white/5 p-3">
	                        <div className="flex items-center justify-between gap-2">
	                            <div className="flex items-center gap-2 text-sm font-medium">
	                                <ImageIcon className="h-4 w-4 text-blue-600 dark:text-blue-300" />
	                                Share image
                            </div>
                        </div>
                        {!hasChatContext ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                                Open a chat room first to generate a shareable image.
                            </div>
                        ) : null}
                        <div className="mt-2 grid grid-cols-2 gap-2">
                            <Button
                                variant="outline"
                                disabled={!hasChatContext || isGeneratingImage}
                                onClick={() => {
                                    void copyImageToClipboard();
                                }}
                            >
                                {imageActionInFlight === "copy" ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                                {imageActionInFlight === "copy" ? "Copying…" : "Copy image"}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={!hasChatContext || isGeneratingImage}
                                onClick={() => {
                                    void downloadImage();
                                }}
                            >
                                {imageActionInFlight === "download" ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Download className="h-4 w-4" />
                                )}
                                {imageActionInFlight === "download" ? "Downloading…" : "Download"}
                            </Button>
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                            Generate an image of this chat you can copy or download.
                        </div>
                    </div>

                    <Separator className="bg-slate-200/70 dark:bg-white/10" />

                    <div className="space-y-2">
                        <div className="text-sm font-medium text-foreground">
                            Share with your network
                        </div>
                        <div className="flex w-full items-center justify-center gap-4 pt-1">
	                            <a
	                                href={networkShareUrls.linkedIn ?? "#"}
	                                target="_blank"
	                                rel="noreferrer noopener"
	                                aria-label="Share to LinkedIn"
	                                title="LinkedIn"
	                                aria-disabled={
	                                    isNetworkShareDisabled
	                                }
	                                className={cn(
	                                    networkCircleClassName,
	                                    "inline-flex items-center justify-center",
	                                    selectedNetwork === "linkedin" && networkCircleSelectedClassName,
	                                    isNetworkShareDisabled &&
	                                        "pointer-events-none opacity-50"
	                                )}
	                                onClick={(event) => {
	                                    event.preventDefault();
	                                    if (isNetworkShareDisabled) return;
	                                    void openNetworkShare("linkedin");
	                                }}
	                            >
                                {networkShareInFlight === "linkedin" ? (
                                    <Loader2 className="h-5 w-5 animate-spin text-[#0A66C2] dark:text-[#7ab7ff]" />
                                ) : (
                                    <LinkedInLogo className="h-5 w-5 text-[#0A66C2] dark:text-[#7ab7ff]" />
                                )}
	                            </a>
	                            <a
	                                href={networkShareUrls.reddit ?? "#"}
	                                target="_blank"
	                                rel="noreferrer noopener"
	                                aria-label="Share to Reddit"
	                                title="Reddit"
	                                aria-disabled={
	                                    isNetworkShareDisabled
	                                }
	                                className={cn(
	                                    networkCircleClassName,
	                                    "inline-flex items-center justify-center",
	                                    selectedNetwork === "reddit" && networkCircleSelectedClassName,
	                                    isNetworkShareDisabled &&
	                                        "pointer-events-none opacity-50"
	                                )}
	                                onClick={(event) => {
	                                    event.preventDefault();
	                                    if (isNetworkShareDisabled) return;
	                                    void openNetworkShare("reddit");
	                                }}
	                            >
                                {networkShareInFlight === "reddit" ? (
                                    <Loader2 className="h-5 w-5 animate-spin text-[#ff4500] dark:text-[#ff8a5d]" />
                                ) : (
                                    <RedditLogo className="h-5 w-5 text-[#ff4500] dark:text-[#ff8a5d]" />
                                )}
	                            </a>
	                            <a
	                                href={networkShareUrls.x ?? "#"}
	                                target="_blank"
	                                rel="noreferrer noopener"
	                                aria-label="Share to X"
	                                title="X"
	                                aria-disabled={
	                                    isNetworkShareDisabled
	                                }
	                                className={cn(
	                                    networkCircleClassName,
	                                    "inline-flex items-center justify-center",
	                                    selectedNetwork === "x" && networkCircleSelectedClassName,
	                                    isNetworkShareDisabled &&
	                                        "pointer-events-none opacity-50"
	                                )}
	                                onClick={(event) => {
	                                    event.preventDefault();
	                                    if (isNetworkShareDisabled) return;
	                                    void openNetworkShare("x");
	                                }}
	                            >
                                {networkShareInFlight === "x" ? (
                                    <Loader2 className="h-5 w-5 animate-spin text-slate-900 dark:text-white" />
                                ) : (
                                    <XLogo className="h-5 w-5 text-slate-900 dark:text-white" />
                                )}
	                            </a>
	                        </div>
                    </div>

                    <div className="flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/60 p-2 text-xs font-semibold text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <div>
                            Take a moment to review the content for any personal, private, or sensitive information
                            (names, emails, phone numbers, addresses, or account details) before sharing.
                        </div>
                    </div>

                </div>
            </DialogContent>
        </Dialog>
    );
}
