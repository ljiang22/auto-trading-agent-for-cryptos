import type { UUID, Character } from "@elizaos/core";
import type { ProcessingStep, ResearchReport, TrendingSentiscoreResponse } from "../types";
import { ACCESS_TOKEN_KEY } from "./constants";
import { getCookie } from "./cookieUtils";

export type FavoriteTaskChainPayload = {
    favoriteId?: string;
    id?: string;
    name?: string;
    originalName?: string;
    description?: string;
    taskChain?: unknown;
    createdAt?: number;
    lastUsedAt?: number;
    [key: string]: unknown;
};

const BASE_URL =
    import.meta.env.VITE_SERVER_BASE_URL ||
    window.location.origin;
export const API_BASE_URL = BASE_URL;
const LOCAL_ANALYTICS_BASE_URL =
    import.meta.env.VITE_ANALYTICS_BASE_URL ||
    BASE_URL;
export const ANALYTICS_API_BASE_URL = LOCAL_ANALYTICS_BASE_URL;

// Helper function to get CSRF token from cookies
const getCsrfToken = (): string | null => {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrftoken') {
            return value;
        }
    }
    return null;
};

// Pull the Django-issued access_token out of the JS-readable cookie so we can
// attach it as `Authorization: Bearer <token>`. The Node agent's auth path
// (packages/client-direct/src/auth/verifyJwt.ts after the JWT-RS256 rollout)
// reads this header and ignores cookies, so this is the load-bearing piece —
// without it every requireAuth route returns 401 once the cookie identity
// path is removed server-side.
const buildAuthHeader = (): Record<string, string> => {
    const token = getCookie(ACCESS_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
};

const fetcher = async ({
    url,
    method,
    body,
    headers,
    baseUrl,
}: {
    url: string;
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    body?: object | FormData;
    headers?: HeadersInit;
    baseUrl?: string;
}) => {
    // Prepare headers with CSRF token for POST/PUT/DELETE requests
    let requestHeaders: HeadersInit = headers
        ? headers
        : {
              Accept: "application/json",
              "Content-Type": "application/json",
          };

    // Attach Authorization: Bearer <access_token> when the cookie is present.
    // Required by the Node agent's verifyJwt path; safe to send to other
    // backends (Django ignores headers it doesn't authenticate against).
    requestHeaders = {
        ...requestHeaders,
        ...buildAuthHeader(),
    };

    // Add CSRF token for non-GET requests
    if (method && method !== "GET") {
        const csrfToken = getCsrfToken();
        if (csrfToken) {
            requestHeaders = {
                ...requestHeaders,
                "X-CSRFToken": csrfToken,
            };
        }
    }

    const options: RequestInit = {
        method: method ?? "GET",
        credentials: "include", // Include cookies for authentication
        headers: requestHeaders,
    };

    if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
        if (body instanceof FormData) {
            if (options.headers && typeof options.headers === "object") {
                // Create new headers object without Content-Type
                options.headers = Object.fromEntries(
                    Object.entries(
                        options.headers as Record<string, string>
                    ).filter(([key]) => key !== "Content-Type")
                );
            }
            options.body = body;
        } else {
            options.body = JSON.stringify(body);
        }
    }

    const requestBaseUrl = baseUrl || BASE_URL;
    return fetch(`${requestBaseUrl}${url}`, options).then(async (resp) => {
        const contentType = resp.headers.get("Content-Type");
        if (contentType === "audio/mpeg") {
            return await resp.blob();
        }

        if (!resp.ok) {
            const errorText = await resp.text();

            let errorMessage = "An error occurred.";
            let errorReason: string | undefined;
            try {
                const errorObj = JSON.parse(errorText);
                errorMessage =
                    (typeof errorObj?.message === "string" && errorObj.message) ||
                    (typeof errorObj?.error === "string" && errorObj.error) ||
                    (typeof errorObj?.detail === "string" && errorObj.detail) ||
                    errorMessage;
                // Server-supplied scrubbed reason code (e.g. "11000",
                // "ECONNRESET"). Append to the message so the toast / console
                // shows it without per-call wiring, and attach as a typed
                // property for callers that want finer-grained handling.
                if (typeof errorObj?.reason === "string" && errorObj.reason) {
                    errorReason = errorObj.reason;
                    errorMessage = `${errorMessage} (code: ${errorReason})`;
                }
            } catch {
                errorMessage = errorText || errorMessage;
            }

            const error: Error & {
                status?: number;
                statusText?: string;
                reason?: string;
            } = new Error(errorMessage);
            error.status = resp.status;
            error.statusText = resp.statusText;
            if (errorReason) error.reason = errorReason;
            throw error;
        }

        return resp.json();
    });
};

export const apiClient = {
    getAgents: () => fetcher({ url: "/agents" }),
    getAgent: (agentId: string): Promise<{ id: UUID; character: Character }> =>
        fetcher({ url: `/agents/${agentId}` }),
    tts: (agentId: string, text: string) =>
        fetcher({
            url: `/${agentId}/tts`,
            method: "POST",
            body: {
                text,
            },
            headers: {
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
                "Transfer-Encoding": "chunked",
            },
        }),
    whisper: async (agentId: string, audioBlob: Blob) => {
        const formData = new FormData();
        formData.append("file", audioBlob, "recording.wav");
        return fetcher({
            url: `/${agentId}/whisper`,
            method: "POST",
            body: formData,
        });
    },
    getChartUrl: (chartPath: string) => {
        if (!chartPath) return '';
        // Per-segment URL encoding: chart filenames may contain reserved chars
        // like '&' (e.g. "fear&greed-index-chart-btc-…html"). Without this the
        // browser parses everything past '&' as a query string, the proxy gets
        // a truncated S3 key, S3 returns NoSuchKey, the iframe errors, and
        // <ChartEmbed> silently returns null.
        const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

        // S3 proxy path — use the SPA origin (see /charts) so dev uses Vite's /s3-files proxy and
        // credentials on fetch/iframes stay same-origin as the app. Using BASE_URL alone breaks
        // when the UI is 127.0.0.1:5173 but VITE_* points at localhost:3001 (cross-site, no cookies).
        if (chartPath.startsWith('/s3-files/')) {
            const origin =
                typeof window !== 'undefined' && typeof window.location?.origin === 'string'
                    ? window.location.origin
                    : BASE_URL;
            return `${origin}${encodePath(chartPath)}`;
        }
        if (chartPath.startsWith('http')) return chartPath;

        // Legacy local path — strip saved_data prefix and serve via /charts
        let relativePath = chartPath.replace(/^\/+/, '').replace(/\\/g, '/');
        if (relativePath.startsWith('saved_data/Charts/')) {
            relativePath = relativePath.substring('saved_data/Charts/'.length);
        } else if (relativePath.startsWith('saved_data/')) {
            relativePath = relativePath.substring('saved_data/'.length);
        }

        // Use the SPA origin so chart iframes are same-origin — required for share export (html-to-image
        // needs iframe.contentDocument). In dev, Vite proxies /charts to the agent (vite.config.ts).
        const origin =
            typeof window !== "undefined" && typeof window.location?.origin === "string"
                ? window.location.origin
                : BASE_URL;
        return `${origin}/charts/${encodePath(relativePath)}`;
    },
    getReportUrl: (reportPath: string) => {
        // Remove leading slash and convert to server URL
        let relativePath = reportPath.replace(/^\/+/, '');
        // Replace backslashes with forward slashes for web URLs
        relativePath = relativePath.replace(/\\/g, '/');

        // Remove 'saved_data/' prefix since /reports serves saved_data/ directory
        if (relativePath.startsWith('saved_data/')) {
            relativePath = relativePath.substring('saved_data/'.length);
        }

        const origin =
            typeof window !== "undefined" && typeof window.location?.origin === "string"
                ? window.location.origin
                : BASE_URL;
        return `${origin}/reports/${relativePath}`;
    },
    getWeeklyReports: async (): Promise<{ success: boolean; reports: ResearchReport[] }> => {
        const response = (await fetcher({
            url: "/research-reports",
        })) as { success: boolean; reports?: ResearchReport[] };

        const reports = (response.reports ?? []).map((report) => {
            const normalizedPath = report.downloadPath?.startsWith("/")
                ? report.downloadPath
                : `/${report.downloadPath ?? ""}`;

            return {
                ...report,
                downloadUrl: report.downloadUrl || `${BASE_URL}${normalizedPath}`,
            };
        });

        return { success: response.success, reports };
    },
		    getTrendingSentiscores: (): Promise<TrendingSentiscoreResponse> =>
		        fetcher({
		            url: "/trending-sentiscores",
		        }),
		    getCoinMarketCapPrice: (symbol: string, convert = "USD") => {
		        const qs = new URLSearchParams({ symbol, convert });
		        return fetcher({
		            url: `/market/coinmarketcap/price?${qs.toString()}`,
		            method: "GET",
		        });
		    },
		    deleteFile: (filePath: string, agentId?: string, roomId?: string): Promise<{ success: boolean; message: string }> =>
		        fetcher({
		            url: "/files",
		            method: "DELETE",
            body: { filePath, agentId, roomId },
        }),
    stopProcessing: (agentId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/agents/${agentId}/stop`,
            method: "POST",
            body: {},
        }),
    /**
     * Probe whether any server-side workflow (comprehensive analysis,
     * task-chain approval, CEX approval) is still in flight for the given
     * room. Used at chat mount time to rehydrate the Stop button across
     * page refresh.
     */
    getActiveWorkflow: (
        agentId: string,
        roomId: string,
    ): Promise<{
        active: boolean;
        kind?: "comprehensive" | "task_chain" | "cex";
        startedAt?: number;
    }> =>
        fetcher({
            url: `/agents/${agentId}/${roomId}/active-workflow`,
            method: "GET",
        }),
    /**
     * Refresh the order-editor account snapshot for a pair the user
     * just typed in. The server re-derives `baseAsset`/`quoteAsset` from
     * the query so the response always matches the requested pair.
     * Returns `null` on 503 (no credentials, rate-limited, or no
     * provider) — caller should fall back to hiding the Avbl/Max block.
     */
    getCexAccountSnapshot: async (
        agentId: string,
        params: { venue: string; base: string; quote: string },
    ): Promise<{
        baseAvailable: string;
        quoteAvailable: string;
        baseAsset: string;
        quoteAsset: string;
        feeBps?: number;
    } | null> => {
        const qs = new URLSearchParams({
            venue: params.venue,
            base: params.base,
            quote: params.quote,
        });
        try {
            const r = (await fetcher({
                url: `/agents/${agentId}/cex/account-snapshot?${qs.toString()}`,
                method: "GET",
            })) as { snapshot?: {
                baseAvailable: string;
                quoteAvailable: string;
                baseAsset: string;
                quoteAsset: string;
                feeBps?: number;
            }; error?: string };
            return r.snapshot ?? null;
        } catch {
            return null;
        }
    },
    /**
     * F10.3 — live market snapshot for a symbol. Returns the same
     * `{ market_snapshot?, symbol_verification }` shape the approval
     * modal already consumes via the SSE `human_input_required`
     * payload, plus an `est_fill_price` / `slippage_vs_limit_bps` pair
     * when `side` + `limit_price` are supplied. Polled by
     * `useMarketSnapshot` every 5 s while a dialog is open so bid /
     * ask / 24 h stats / depth stay live. Returns `null` on any error
     * so the panel falls back to hiding the block rather than blocking
     * the user.
     */
    getMarketSnapshot: async (
        agentId: string,
        params: {
            symbol: string;
            venue?: string;
            side?: "BUY" | "SELL";
            limit_price?: string;
            action_name?: string;
        },
    ): Promise<{
        market_snapshot?: {
            symbol: string;
            bid?: string;
            bid_qty?: string;
            ask?: string;
            ask_qty?: string;
            spread_bps?: number;
            price_change_pct?: string;
            high_24h?: string;
            low_24h?: string;
            volume_24h?: string;
            quote_volume_24h?: string;
            depth_bids?: Array<{ price: string; qty: string }>;
            depth_asks?: Array<{ price: string; qty: string }>;
            est_fill_price?: number;
            slippage_vs_limit_bps?: number;
            fetched_at_ms: number;
        };
        symbol_verification: {
            matches: boolean;
            extracted_symbol: string;
            user_text_asset_mentions: string[];
            quote_currency_mismatch?: boolean;
            reason?: string;
        };
    } | null> => {
        const qs = new URLSearchParams({ symbol: params.symbol });
        if (params.venue) qs.set("venue", params.venue);
        if (params.side) qs.set("side", params.side);
        if (params.limit_price) qs.set("limit_price", params.limit_price);
        if (params.action_name) qs.set("action_name", params.action_name);
        try {
            const r = await fetcher({
                url: `/agents/${agentId}/cex/market-snapshot?${qs.toString()}`,
                method: "GET",
            });
            // The endpoint always returns { market_snapshot?, symbol_verification }
            // on a 200 — the response is shaped by `buildMarketSnapshot()`. The
            // outer catch handles 4xx / 5xx by returning null so the panel falls
            // back to its empty state.
            return r as {
                market_snapshot?: {
                    symbol: string;
                    bid?: string;
                    bid_qty?: string;
                    ask?: string;
                    ask_qty?: string;
                    spread_bps?: number;
                    price_change_pct?: string;
                    high_24h?: string;
                    low_24h?: string;
                    volume_24h?: string;
                    quote_volume_24h?: string;
                    depth_bids?: Array<{ price: string; qty: string }>;
                    depth_asks?: Array<{ price: string; qty: string }>;
                    est_fill_price?: number;
                    slippage_vs_limit_bps?: number;
                    fetched_at_ms: number;
                };
                symbol_verification: {
                    matches: boolean;
                    extracted_symbol: string;
                    user_text_asset_mentions: string[];
                    quote_currency_mismatch?: boolean;
                    reason?: string;
                };
            };
        } catch {
            return null;
        }
    },
    /**
     * List of tradable spot products on `venue` (USDT/USDC/USD-quoted).
     * Backs the Pair combobox in the order editor; client should
     * SWR-cache for ~5 min. Returns `null` if the upstream public
     * endpoint is unavailable — caller falls back to the free-text
     * Pair input.
     */
    getCexTradableProducts: async (
        agentId: string,
        venue: string,
        marginType?: "cross" | "isolated",
    ): Promise<{
        venue: string;
        products: Array<{ product_id: string; base_asset: string; quote_asset: string }>;
        fetched_at_ms: number;
    } | null> => {
        const qs = new URLSearchParams({ venue });
        if (marginType) qs.set("marginType", marginType);
        try {
            return (await fetcher({
                url: `/agents/${agentId}/cex/products?${qs.toString()}`,
                method: "GET",
            })) as {
                venue: string;
                products: Array<{ product_id: string; base_asset: string; quote_asset: string }>;
                fetched_at_ms: number;
            };
        } catch {
            return null;
        }
    },
    getAnalyticsSummary: (): Promise<{
        success: boolean;
        generatedAt: number;
        dailyLabels: string[];
        totals: {
            usage: { activeUsers: number; messageCount: number };
            usageSegments: {
                anonymous: { activeUsers: number; messageCount: number };
                free: { activeUsers: number; messageCount: number };
                plus: { activeUsers: number; messageCount: number };
                pro: { activeUsers: number; messageCount: number };
            };
            main: { sessions: number; visitors: number; avgDurationMs: number };
            signup: { sessions: number; visitors: number; avgDurationMs: number };
            register: { sessions: number; visitors: number; avgDurationMs: number };
            mainAnonymousVisitors: { visitors: number };
            registerAnonymousVisitors: { visitors: number };
            registrations: { registrations: number };
            signupLinkSends: { linkSends: number };
            mainAuth: {
                loggedInVisitors: number;
                loggedInAvgDurationMs: number;
                anonymousVisitors: number;
                anonymousAvgDurationMs: number;
            };
        };
        usage: Array<{ day: string; activeUsers: number; messageCount: number }>;
        usageSegments: {
            anonymous: Array<{ day: string; activeUsers: number; messageCount: number }>;
            free: Array<{ day: string; activeUsers: number; messageCount: number }>;
            plus: Array<{ day: string; activeUsers: number; messageCount: number }>;
            pro: Array<{ day: string; activeUsers: number; messageCount: number }>;
        };
        main: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        signup: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        register: Array<{ day: string; sessions: number; visitors: number; avgDurationMs: number }>;
        mainAnonymousVisitors: Array<{ day: string; visitors: number }>;
        registerAnonymousVisitors: Array<{ day: string; visitors: number }>;
        loggedInVisitors: Array<{ day: string; visitors: number }>;
        registrations: Array<{ day: string; registrations: number }>;
        signupLinkSends: Array<{ day: string; linkSends: number }>;
        mainAuth: Array<{
            day: string;
            loggedInVisitors: number;
            loggedInAvgDurationMs: number;
            anonymousVisitors: number;
            anonymousAvgDurationMs: number;
        }>;
        hourlyMain: Array<{ hour: string; sessions: number; visitors: number; avgDurationMs: number }>;
    }> =>
        fetcher({
            url: "/analytics/summary",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    sendPageSession: (payload: {
        path: string;
        referrer?: string | null;
        durationMs: number;
        clickCount: number;
        startedAt: number;
        isAuthenticated?: boolean;
        userId?: string | null;
        userEmail?: string | null;
        userName?: string | null;
    }): Promise<{ success: boolean }> =>
        fetcher({
            url: "/analytics/page-session",
            method: "POST",
            body: payload,
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    getReferralCodesToday: (): Promise<{
        success: boolean;
        generatedAt: number;
        date: string;
        summary: {
            totalCodes: number;
            totalPending: number;
            totalCompleted: number;
        };
        data: Array<{
            referralCode: string;
            pendingCount: number;
            completedCount: number;
        }>;
    }> =>
        fetcher({
            url: "/analytics/referral-codes-today",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),
    getReferralCodesLast30Days: (): Promise<{
        success: boolean;
        generatedAt: number;
        range: {
            from: string;
            to: string;
        };
        summary: {
            totalCodes: number;
            totalPending: number;
            totalCompleted: number;
        };
        data: Array<{
            referralCode: string;
            pendingCount: number;
            completedCount: number;
        }>;
    }> =>
        fetcher({
            url: "/analytics/referral-codes-last-30-days",
            baseUrl: ANALYTICS_API_BASE_URL,
        }),

    // Room management endpoints
    createRoom: (agentId: string, name?: string): Promise<{ success: boolean; room: { id: string; name: string; createdAt: number } }> =>
        fetcher({
            url: `/agents/${agentId}/rooms`,
            method: "POST",
            body: { name },
        }),
    
    getRooms: (agentId: string): Promise<{ success: boolean; rooms: Array<{ id: string; name: string; createdAt: number; lastMessage: { text: string; createdAt: number } | null; messageCount: number }> }> =>
        fetcher({
            url: `/agents/${agentId}/rooms`,
            method: "GET",
        }),
    
    deleteRoom: (agentId: string, roomId: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}`,
            method: "DELETE",
        }),

    batchDeleteRooms: (agentId: string, roomIds: string[]): Promise<{
        success: boolean;
        message: string;
        results: Array<{ roomId: string; success: boolean; error?: string }>;
    }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/batch-delete`,
            method: "POST",
            body: { roomIds },
        }),

    renameRoom: (agentId: string, roomId: string, name: string): Promise<{ success: boolean; message: string; room: { id: string; name: string } }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}`,
            method: "PUT",
            body: { name },
        }),

    getFavoriteTaskChains: (agentId: string): Promise<{ success: boolean; favorites: any[] }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains`,
            method: "GET",
        }),

    addFavoriteTaskChain: (
        agentId: string,
        payload: {
            chainId: string;
            name: string;
            originalName?: string;
            description?: string;
            taskChain: unknown;
            isPublic?: boolean;
        }
    ): Promise<{ success: boolean; favorite: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains`,
            method: "POST",
            body: payload,
        }),

    updateFavoriteTaskChainVisibility: (
        agentId: string,
        favoriteId: string,
        isPublic: boolean
    ): Promise<{ success: boolean; favorite: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/visibility`,
            method: "PATCH",
            body: { isPublic },
        }),

    deleteFavoriteTaskChain: (
        agentId: string,
        favoriteId: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}`,
            method: "DELETE",
        }),

    updateFavoriteTaskChainName: (
        agentId: string,
        favoriteId: string,
        name: string
    ): Promise<{ success: boolean; favoriteId: string; name: string }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}`,
            method: "PATCH",
            body: { name },
        }),

    markFavoriteTaskChainUsed: (
        agentId: string,
        favoriteId: string,
        timestamp?: number
    ): Promise<{ success: boolean; favoriteId: string; lastUsedAt: number }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/use`,
            method: "POST",
            body: { timestamp },
        }),

    shareFavoriteTaskChain: (
        agentId: string,
        favoriteId: string,
    ): Promise<{ success: boolean; share: any }> =>
        fetcher({
            url: `/agents/${agentId}/favorite-taskchains/${favoriteId}/share`,
            method: "POST",
        }),

    getSharedTaskChainByCode: (
        shareCode: string
    ): Promise<{ success: boolean; share: any }> =>
        fetcher({
            url: `/shared-taskchains/${shareCode}`,
            method: "GET",
        }),

    createSharedChat: (
        agentId: string,
        roomId: string,
    ): Promise<{ success: boolean; share: { shareCode: string } }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}/shared-chat`,
            method: "POST",
        }),

    getShareSummary: (
        agentId: string,
        roomId: string,
    ): Promise<{ success: boolean; title?: string; summary: string }> =>
        fetcher({
            url: `/agents/${agentId}/rooms/${roomId}/share-summary`,
            method: "POST",
        }),

    getSharedChatByCode: (
        shareCode: string
    ): Promise<{
        success: boolean;
        share: { shareCode: string; agentId: string; roomId: string; createdAt: number };
        memories: Array<{
            id: string;
            userId: string;
            agentId: string;
            createdAt: number;
            content: {
                text: string;
                action?: unknown;
                source?: unknown;
                url?: unknown;
                inReplyTo?: unknown;
                metadata?: unknown;
                actionData?: unknown;
                actionResults?: unknown;
                attachments?: Array<{
                    id?: string;
                    url: string;
                    title?: string;
                    source?: string;
                    description?: string;
                    text?: string;
                    contentType?: string;
                }>;
            };
            roomId: string;
        }>;
    }> =>
        fetcher({
            url: `/shared-chats/${shareCode}`,
            method: "GET",
        }),

    getSharedRoom: (
        agentId: string,
        roomId: string
    ): Promise<{
        success: boolean;
        agentId: string;
        roomId: string;
        room?: { id: string; name?: string; createdAt?: string | number | null } | null;
        shareAgentId?: string;
        memories: Array<{
            id: string;
            userId: string;
            agentId: string;
            createdAt: number;
            content: {
                text: string;
                action?: unknown;
                source?: unknown;
                url?: unknown;
                inReplyTo?: unknown;
                metadata?: unknown;
                actionData?: unknown;
                actionResults?: unknown;
                attachments?: Array<{
                    id?: string;
                    url: string;
                    title?: string;
                    source?: string;
                    description?: string;
                    text?: string;
                    contentType?: string;
                }>;
            };
            roomId: string;
        }>;
    }> =>
        fetcher({
            url: `/shared-rooms/${agentId}/${roomId}`,
            method: "GET",
        }),

    // Authentication endpoints
    login: (email: string, password: string): Promise<{ user?: any; message?: string }> =>
        fetcher({
            url: "/authentication/validation/",
            method: "POST",
            body: { email, password },
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    sendSignUpToken: (email: string): Promise<{ message: string }> =>
        fetcher({
            url: "/authentication/enrollment/token/",
            method: "POST",
            body: { email },
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    createAccount: (regToken: string, formData: object): Promise<{ message: string }> =>
        fetcher({
            url: `/authentication/creation/${regToken}/`,
            method: "POST",
            body: formData,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    validateToken: (regToken: string): Promise<any> =>
        fetcher({
            url: `/authentication/creation/${regToken}/`,
            method: "GET",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    logout: (): Promise<{ message: string }> =>
        fetcher({
            url: "/authentication/logout/",
            method: "POST",
            body: {},
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    refreshToken: (): Promise<{ user?: any }> =>
        fetcher({
            url: "/authentication/refresh/",
            method: "POST",
            body: {},
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                credentials: "include",
            },
        }),
    getMe: (): Promise<{ user: any }> =>
        fetcher({
            url: "/authentication/me/",
            method: "GET",
            headers: {
                Accept: "application/json",
                credentials: "include",
            },
        }),
    getReferralCode: (): Promise<{ referralCode: string; referralLink: string; totalInvites: number }> =>
        fetcher({
            url: "/authentication/referral-code/",
            method: "GET",
            headers: {
                Accept: "application/json",
                credentials: "include",
            },
        }),

    // Get historical messages for a room
    getMessages: (
        agentId: string,
        roomId: string,
        params?: { limit?: number; before?: string }
    ): Promise<{ agentId?: string; roomId?: string; memories?: any[]; messages?: any[]; hasMore?: boolean; oldestId?: string }> => {
        const qs = params
            ? '?' + new URLSearchParams(
                Object.entries(params)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, String(v)])
              ).toString()
            : '';
        return fetcher({
            url: `/agents/${agentId}/${roomId}/memories${qs}`,
            method: "GET",
        });
    },
    getSubscriptionStatus: (email?: string): Promise<{
        success: boolean;
        email: string;
        planName: "Plus" | "Pro" | "Enterprise" | null;
        // Canonical tier field for all user classification logic.
        resolvedTier: "free" | "plus" | "pro" | "enterprise";
        primarySubscriptionId: string | null;
        primarySubscriptionNickname: string | null;
        primarySubscription: {
            id: string;
            status: string;
            cancelAtPeriodEnd: boolean;
            currentPeriodStart: number | null;
            currentPeriodEnd: number | null;
            items: Array<{
                id: string;
                priceId: string | null;
                productId: string | null;
                nickname: string | null;
                currency: string | null;
                unitAmount: number | null;
                interval: string | null;
                intervalCount: number | null;
            }>;
            latestInvoiceId: string | null;
        } | null;
        customers: Array<{
            customerId: string;
            customerEmail: string | null;
            subscriptions: Array<{
                id: string;
                status: string;
                cancelAtPeriodEnd: boolean;
                currentPeriodStart: number | null;
                currentPeriodEnd: number | null;
                items: Array<{
                    id: string;
                    priceId: string | null;
                    productId: string | null;
                    nickname: string | null;
                    currency: string | null;
                    unitAmount: number | null;
                    interval: string | null;
                    intervalCount: number | null;
                }>;
                latestInvoiceId: string | null;
            }>;
        }>;
    }> =>
        fetcher({
            url:
                email && email.trim().length > 0
                    ? `/billing/subscription?email=${encodeURIComponent(email.trim())}`
                    : "/billing/subscription",
            method: "GET",
        }),
    clearAnonymousHistory: (options?: { force?: boolean }): Promise<{ success: boolean; cleaned: boolean }> =>
        fetcher({
            url: "/anonymous/cleanup",
            method: "POST",
            body: options ?? {},
        }),
    submitFeedback: (feedback: string): Promise<{ success: boolean; message: string }> =>
        fetcher({
            url: "/feedback",
            method: "POST",
            body: { feedback },
        }),
    submitChainApproval: (
        agentId: string,
        threadId: string,
        decision: 'approved' | 'rejected',
        taskChain: unknown,
        feedback?: string
    ): Promise<{ success: boolean; message: string; chainId: string; chainName: string }> =>
        fetcher({
            url: `/agents/${agentId}/task-chain/approval`,
            method: "POST",
            body: { threadId, decision, feedback, taskChain },
        }),
    getQuotaStatus: (agentId: string): Promise<{
        success: boolean;
        isUnlimited: boolean;
        isFreeUser: boolean;
        isLimitedUser?: boolean;
        quotaTier?: "free" | "plus" | "unlimited";
        quotaStatus?: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            inputLimit: number;
            outputLimit: number;
            inputPercentage: number;
            outputPercentage: number;
            isQuotaExceeded: boolean;
            warningLevel: "none" | "warning" | "critical" | "exceeded";
            percentageTier: number;
            resetDate: string;
            daysUntilReset: number;
        };
        error?: string;
    }> => fetcher({ url: `/${agentId}/quota/status`, method: "GET" }),
    // Exchange registry (list of supported CEX exchanges).
    getExchanges: () =>
        fetcher({
            url: `/trading/exchanges`,
            method: "GET",
        }) as Promise<{
            success: boolean;
            exchanges: Array<{
                id: string;
                name: string;
                defaultAuthType: string | null;
                authTypes: Array<{
                    type: string;
                    fields: Array<{
                        id: string;
                        label: string;
                        type: "string" | "secret";
                        required: boolean;
                        description?: string;
                        placeholder?: string;
                    }>;
                }>;
            }>;
        }>,
    // Exchange credential storage (user-specific auths). Matches client-direct API:
    // GET with no authType returns full exchangeAuths for that exchange (all auth types).
    // GET with authType returns single auth type's fieldPresent/fieldPreview/updatedAt.
    getExchangeAuths: (exchangeId: string, authType?: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}${authType != null && authType !== "" ? `?authType=${encodeURIComponent(authType)}` : ""}`,
            method: "GET",
        }) as Promise<
            | {
                  success: boolean;
                  exchangeId: string;
                  isDefault?: boolean;
                  exchangeAuths: Record<
                      string,
                      {
                          fieldPresent: Record<string, boolean>;
                          fieldPreview: Record<string, string | null>;
                          updatedAt: number | null;
                      }
                  >;
              }
            | {
                  success: boolean;
                  exchangeId: string;
                  fieldPresent: Record<string, boolean>;
                  fieldPreview: Record<string, string | null>;
                  updatedAt: number | null;
                  isDefault?: boolean;
              }
        >,
    // PUT body: exchangeAuths array; each entry must have authType and field id -> value.
    // If server returns "No valid fields provided" (legacy server expecting flat body), retry with flat body for single entry.
    setExchangeAuths: async (
        exchangeId: string,
        exchangeAuths: Array<{ authType: string; [fieldId: string]: string | undefined }>
    ): Promise<{ success: boolean }> => {
        try {
            return await fetcher({
                url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}`,
                method: "PUT",
                body: { exchangeAuths },
            }) as Promise<{ success: boolean }>;
        } catch (firstErr) {
            const msg = (firstErr as Error)?.message ?? "";
            const isLegacyError = typeof msg === "string" && msg.includes("No valid fields provided");
            if (isLegacyError && exchangeAuths.length === 1) {
                const entry = exchangeAuths[0];
                const flatBody: Record<string, string> = { authType: entry.authType };
                for (const [k, v] of Object.entries(entry)) {
                    if (k !== "authType" && typeof v === "string" && v.trim() !== "") flatBody[k] = v;
                }
                return await fetcher({
                    url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}`,
                    method: "PUT",
                    body: flatBody,
                }) as Promise<{ success: boolean }>;
            }
            throw firstErr;
        }
    },
    // Optional authType: delete only that auth type for the exchange; else delete entire exchange auth.
    deleteExchangeAuths: (exchangeId: string, authType?: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}${authType != null && authType !== "" ? `?authType=${encodeURIComponent(authType)}` : ""}`,
            method: "DELETE",
            body: {},
        }) as Promise<{ success: boolean }>,
    setDefaultExchange: (exchangeId: string) =>
        fetcher({
            url: `/user/exchange-auths/${encodeURIComponent(exchangeId)}/default`,
            method: "PUT",
            body: {},
        }) as Promise<{ success: boolean }>,
    getTradingEnabled: () =>
        fetcher({
            url: "/user/trading/enabled",
            method: "GET",
        }) as Promise<{ success: boolean; enabled: boolean }>,
    setTradingEnabled: (enableTrading: boolean) =>
        fetcher({
            url: "/user/trading/enabled",
            method: "PUT",
            body: { enableTrading },
        }) as Promise<{ success: boolean; enabled: boolean }>,
    submitCEXWorkflowApproval: (
        agentId: string,
        threadId: string,
        decision: 'approved' | 'rejected',
        confirmationLevel: 1 | 2,
        parameters?: Record<string, unknown>,
        approvalId?: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/cex-workflow/approval`,
            method: "POST",
            body: { threadId, approvalId, decision, confirmationLevel, parameters },
        }),
    submitHumanInputApproval: (
        agentId: string,
        threadId: string,
        decision: "approved" | "rejected",
        confirmationLevel: 1 | 2,
        parameters?: Record<string, unknown>,
        approvalId?: string
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/agents/${agentId}/human-input/approval`,
            method: "POST",
            body: { threadId, approvalId, decision, confirmationLevel, parameters },
        }),

    // §7.1 — fetch the user's trading preferences (mode badge + risk limits source of truth).
    getTradingPreferences: (): Promise<{
        success: boolean;
        preferences:
            | (Record<string, unknown> & {
                  default_mode?: "live" | "paper" | "shadow";
                  kill_switch_active?: boolean;
              })
            | null;
    }> =>
        fetcher({
            url: `/user/trading/preferences`,
        }),

    // §7.3 — patch trading preferences.
    setTradingPreferences: (
        patch: Record<string, unknown>,
    ): Promise<{ success: boolean; code?: string; message?: string }> =>
        fetcher({
            url: `/user/trading/preferences`,
            method: "PUT",
            body: patch,
        }),

    // §7.2 — kill-switch toggle.
    setKillSwitch: (
        active: boolean,
        reason?: string,
    ): Promise<{ success: boolean; kill_switch_active: boolean }> =>
        fetcher({
            url: `/user/trading/kill-switch`,
            method: "PUT",
            body: { active, reason },
        }),

    // §7.6 — list a user's orders.
    listOrders: (params?: {
        limit?: number;
        venue?: string;
        state?: string;
    }): Promise<{ success: boolean; orders: Array<Record<string, unknown>> }> => {
        const qs = new URLSearchParams();
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.venue) qs.set("venue", params.venue);
        if (params?.state) qs.set("state", params.state);
        const q = qs.toString();
        return fetcher({ url: `/user/orders${q ? `?${q}` : ""}` });
    },

    // §7.7 — list strategies.
    listStrategies: (): Promise<{
        success: boolean;
        strategies: Array<Record<string, unknown>>;
    }> => fetcher({ url: `/user/strategies` }),

    setStrategyStatus: (
        id: string,
        status: "active" | "paused" | "stopped",
    ): Promise<{ success: boolean; status: string }> =>
        fetcher({
            url: `/user/strategies/${id}/status`,
            method: "PUT",
            body: { status },
        }),

    // §7.8 — consent.
    getConsent: (
        consentType: string,
        version = "v1",
    ): Promise<{ success: boolean; consent: Record<string, unknown> | null }> =>
        fetcher({
            url: `/user/consent/${consentType}?version=${encodeURIComponent(version)}`,
        }),

    recordConsent: (
        consentType: string,
        version = "v1",
    ): Promise<{ success: boolean }> =>
        fetcher({
            url: `/user/consent`,
            method: "POST",
            body: { consent_type: consentType, version, accepted: true },
        }),

    // §7.9 — notifications.
    listNotifications: (params?: {
        limit?: number;
        unreadOnly?: boolean;
    }): Promise<{
        success: boolean;
        notifications: Array<Record<string, unknown>>;
    }> => {
        const qs = new URLSearchParams();
        if (params?.limit) qs.set("limit", String(params.limit));
        if (params?.unreadOnly) qs.set("unreadOnly", "true");
        const q = qs.toString();
        return fetcher({ url: `/user/notifications${q ? `?${q}` : ""}` });
    },
    markNotificationRead: (id: string): Promise<{ success: boolean }> =>
        fetcher({
            url: `/user/notifications/${id}/read`,
            method: "POST",
        }),
};

/** True when the browser/proxy tore down a fetch in a way typical of user abort or HTTP/2 reset. */
function isLikelyStreamAbortError(err: unknown): boolean {
    if (err == null) return false;
    if (err instanceof DOMException && err.name === "AbortError") return true;
    if (!(err instanceof Error)) return false;
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === "AbortError") return true;
    if (msg.includes("user aborted")) return true;
    if (msg.includes("network error")) return true;
    if (msg.includes("failed to fetch")) return true;
    if (msg.includes("load failed")) return true;
    if (msg.includes("http2") || msg.includes("err_http2")) return true;
    return false;
}

export class StreamingApiClient {
    private activeStreams = new Map<string, AbortController>();
    /**
     * Agents for which Stop was clicked while a stream is live. The flag is
     * consumed by `finishAsUserStopIfNeeded` in the stream's catch/end paths
     * so browser/proxy teardown (HTTP/2 reset, AbortError, "network error",
     * etc.) is classified as an intentional stop instead of "Analysis Error".
     *
     * Contract:
     * - Set only when there is at least one active stream for the agent.
     * - Cleared on [DONE], on successful user-stop handling, and when a new
     *   stream starts for that agent (so stale intent never leaks into an
     *   unrelated future stream).
     */
    private userStoppedAgentIds = new Set<string>();

    private hasActiveStreamForAgent(agentId: string): boolean {
        for (const key of this.activeStreams.keys()) {
            if (key.startsWith(agentId)) return true;
        }
        return false;
    }

    /**
     * Mark that the user intentionally stopped processing for this agent.
     * Only sticks if there is actually an in-flight stream to protect; this
     * prevents the flag from leaking into an unrelated future stream when the
     * user clicks Stop in an edge state (no active stream).
     */
    registerUserStopIntent(agentId: string): void {
        if (this.hasActiveStreamForAgent(agentId)) {
            this.userStoppedAgentIds.add(agentId);
        }
    }

    // Cancel all active streams
    cancelAllStreams() {
        for (const [key, controller] of this.activeStreams.entries()) {
            controller.abort();
            this.activeStreams.delete(key);
        }
    }

    // Cancel specific stream by agent ID
    cancelStreamForAgent(agentId: string) {
        let aborted = false;
        for (const [key, controller] of this.activeStreams.entries()) {
            if (key.startsWith(agentId)) {
                controller.abort();
                this.activeStreams.delete(key);
                aborted = true;
            }
        }
        if (aborted) {
            this.userStoppedAgentIds.add(agentId);
        }
    }
    
    async sendMessageStream(
        agentId: string,
        message: string,
        roomId: string,
        onStep: (step: ProcessingStep) => void,
        onActionResponse: (response: any) => void,
        onIntermediateResponse: (response: any) => void,
        onFinalResponse: (responses: any[]) => void,
        onRoomUpdate: ((room: { id: string; name: string }) => void) | undefined,
        onError: (error: string | { code?: string; message?: string }) => void,
        onComplete?: () => void,
        /**
         * Live LLM-token mirror for long-running actions. Receives the
         * cumulative buffered text for a given streaming key (default
         * 'pending') each time a new `token` SSE event arrives. Use it to
         * paint a ghost bubble that grows as the model streams.
         */
        onStreamingUpdate?: (params: { key: string; text: string }) => void,
        favoriteTaskChain?: FavoriteTaskChainPayload,
        selectedFiles?: File[],
        messageClassification?: "TASK_CHAIN_MESSAGE",
        language?: string,
        /**
         * F10 — structured manual-compose payload. When set, the server's
         * CEX workflow handler short-circuits the LLM and uses these
         * parameters verbatim (still subject to risk gates + approval).
         *
         * F10.2 — `preApproved` opts the payload into the one-click compose
         * flow: the compose dialog already collected the explicit "I
         * confirm…" gate, so the server skips emitting a redundant
         * `human_input_required` approval modal. Risk gating, dep-health,
         * idempotency, per-symbol lock, and quote-freshness recheck all
         * still run server-side; only the UI double-confirm is elided.
         */
        composed?: { action: string; parameters: Record<string, unknown>; preApproved?: boolean },
        retryCount = 0,
    ) {
        // Create unique key for request deduplication (userId determined server-side from auth/IP)
        const favoriteKeySegment = favoriteTaskChain
            ? String(
                  favoriteTaskChain.favoriteId
                      ?? favoriteTaskChain.id
                      ?? favoriteTaskChain.name
                      ?? ""
              ).substring(0, 50)
            : "";
        const classificationKeySegment = messageClassification ?? "";
        const requestKey = `${agentId}-${roomId}-${message.substring(0, 50)}-${favoriteKeySegment}-${classificationKeySegment}`;
        
        // Cancel any existing request with the same key
        if (this.activeStreams.has(requestKey)) {
            this.activeStreams.get(requestKey)?.abort();
            this.activeStreams.delete(requestKey);
        }

        // A fresh user-initiated stream supersedes any prior "user stop" intent
        // for this agent. Without this, a stale flag (e.g. Stop clicked with no
        // active stream, or a prior stream that ended without consuming the
        // flag) could silently swallow a real error on the new stream.
        // Retry paths set retryCount > 0 — keep the flag in that case so a
        // user stop during retries still classifies correctly.
        if (retryCount === 0) {
            this.userStoppedAgentIds.delete(agentId);
        }

        // Create new AbortController for this request
        const abortController = new AbortController();
        this.activeStreams.set(requestKey, abortController);
        
        // Clean up on completion
        const cleanup = () => {
            this.activeStreams.delete(requestKey);
        };
        
        // Create FormData for file uploads or JSON for text-only
        let body: FormData | string;
        let headers: HeadersInit;

        if (selectedFiles && selectedFiles.length > 0) {
            // Use FormData for file uploads (userId determined server-side from auth/IP)
            const formData = new FormData();
            formData.append("text", message);
            formData.append("roomId", roomId);

            if (favoriteTaskChain) {
                formData.append("favoriteTaskChain", JSON.stringify(favoriteTaskChain));
            }

            if (messageClassification) {
                formData.append("messageClassification", messageClassification);
            }

            if (language) {
                formData.append("language", language);
            }

            if (composed) {
                formData.append("composedAction", composed.action);
                formData.append("composedParams", JSON.stringify(composed.parameters));
                if (composed.preApproved) {
                    formData.append("composedPreApproved", "true");
                }
            }

            // Append each file with the same field name to create an array
            selectedFiles.forEach((file) => {
                formData.append("files", file);
            });
            
            body = formData;
            headers = {}; // Let browser set Content-Type with boundary for multipart/form-data
        } else {
            // Use JSON for text-only messages (userId determined server-side from auth/IP)
            const payload: Record<string, unknown> = {
                text: message,
                roomId,
            };

            if (favoriteTaskChain) {
                payload.favoriteTaskChain = favoriteTaskChain;
            }

            if (messageClassification) {
                payload.messageClassification = messageClassification;
            }

            if (language) {
                payload.language = language;
            }

            if (composed) {
                payload.composedAction = composed.action;
                payload.composedParams = composed.parameters;
                if (composed.preApproved) {
                    payload.composedPreApproved = true;
                }
            }

            body = JSON.stringify(payload);
            headers = {
                'Content-Type': 'application/json',
            };
        }

        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

        const finishAsUserStopIfNeeded = (): boolean => {
            if (!this.userStoppedAgentIds.has(agentId)) {
                return false;
            }
            this.userStoppedAgentIds.delete(agentId);
            cleanup();
            onComplete?.();
            return true;
        };

        try {
            // Merge in Authorization: Bearer so the Node agent's requireAuth
            // gate accepts the request once the server-side cookie identity
            // path is removed (JWT-RS256 rollout).
            const headersWithAuth: HeadersInit = {
                ...(headers as Record<string, string>),
                ...buildAuthHeader(),
            };
            const response = await fetch(`${BASE_URL}/${agentId}/message/stream`, {
                method: 'POST',
                headers: headersWithAuth,
                body,
                credentials: 'include', // Include cookies for authentication
                // Use combined signal for both timeout and manual abort
                signal: AbortSignal.any([
                    AbortSignal.timeout(600000), // 10 minute timeout for comprehensive analysis
                    abortController.signal,
                ]),
            });

            if (!response.body) {
                throw new Error('No response body');
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            // Per-stream token accumulator. Keyed by `actionId` when the server
            // tags a stream, otherwise 'pending' for the in-flight assistant
            // response. The buffer is flushed via onStreamingUpdate so the chat
            // can paint a ghost bubble that grows as the model streams.
            const tokenBuffers = new Map<string, string>();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            this.userStoppedAgentIds.delete(agentId);
                            cleanup();
                            if (onComplete) onComplete();
                            return;
                        }
                        if (!data) continue;

                        try {
                            const parsed = JSON.parse(data);

                            switch (parsed.type) {
                                case 'step':
                                    onStep(parsed.step);
                                    break;
                                case 'token': {
                                    const key = typeof parsed.actionId === 'string' && parsed.actionId
                                        ? parsed.actionId
                                        : 'pending';
                                    const next = (tokenBuffers.get(key) ?? '') + (parsed.text ?? '');
                                    tokenBuffers.set(key, next);
                                    onStreamingUpdate?.({ key, text: next });
                                    break;
                                }
                                case 'action_response':
                                    onActionResponse(parsed.response);
                                    break;
                                case 'intermediate_response':
                                    onIntermediateResponse(parsed.response);
                                    break;
                                case 'final_response':
                                    onFinalResponse(parsed.responses);
                                    break;
                                case 'room_update':
                                    if (onRoomUpdate && parsed.room) {
                                        onRoomUpdate(parsed.room);
                                    }
                                    break;
                                case 'room_created':
                                    if (onRoomUpdate && parsed.roomId && parsed.roomName !== undefined) {
                                        onRoomUpdate({ id: parsed.roomId, name: parsed.roomName });
                                    }
                                    break;
                                case 'error':
                                    onError(parsed.error);
                                    break;
                            }
                        } catch (e) {
                            if (typeof data === "string" && data.length > 50_000) {
                                console.warn(
                                    "[StreamingApiClient] SSE JSON parse failed for large payload",
                                    e,
                                );
                            }
                        }
                    }
                }
            }

            if (buffer.trim()) {
                const lines = buffer.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            this.userStoppedAgentIds.delete(agentId);
                            cleanup();
                            if (onComplete) onComplete();
                            return;
                        }
                        if (data && data !== '[DONE]') {
                            try {
                                const parsed = JSON.parse(data);

                                switch (parsed.type) {
                                    case 'step':
                                        onStep(parsed.step);
                                        break;
                                    case 'token': {
                                        const key = typeof parsed.actionId === 'string' && parsed.actionId
                                            ? parsed.actionId
                                            : 'pending';
                                        const next = (tokenBuffers.get(key) ?? '') + (parsed.text ?? '');
                                        tokenBuffers.set(key, next);
                                        onStreamingUpdate?.({ key, text: next });
                                        break;
                                    }
                                    case 'action_response':
                                        onActionResponse(parsed.response);
                                        break;
                                    case 'intermediate_response':
                                        onIntermediateResponse(parsed.response);
                                        break;
                                    case 'final_response':
                                        onFinalResponse(parsed.responses);
                                        break;
                                    case 'room_update':
                                        if (onRoomUpdate && parsed.room) {
                                            onRoomUpdate(parsed.room);
                                        }
                                        break;
                                    case 'room_created':
                                        if (onRoomUpdate && parsed.roomId && parsed.roomName !== undefined) {
                                            onRoomUpdate({ id: parsed.roomId, name: parsed.roomName });
                                        }
                                        break;
                                    case 'error':
                                        onError(parsed.error);
                                        break;
                                }
                            } catch (e) {
                                if (typeof data === "string" && data.length > 50_000) {
                                    console.warn(
                                        "[StreamingApiClient] SSE JSON parse failed for large payload",
                                        e,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            // Reader finished without `[DONE]` (proxy reset, user stop, crash, etc.).
            if (finishAsUserStopIfNeeded()) {
                return;
            }
            onError({
                code: 'STREAM_ENDED',
                message: 'Connection closed before response completed. Please try again.',
            });
        } catch (streamError: unknown) {
            // 1. User-stop short-circuit: if the user clicked Stop, any
            //    teardown (AbortError, HTTP/2 reset, "network error",
            //    "Load failed", etc.) is intentional. Finish as complete,
            //    skip the error toast, skip retries.
            if (finishAsUserStopIfNeeded()) {
                return;
            }

            // 2. Abort / timeout classification. An AbortError with
            //    abortController.signal.aborted=true means a same-request-key
            //    dedup replaced this stream (not a user stop, because user
            //    stop is handled in step 1); report it as stopped to let the
            //    caller no-op cleanly. Combined-signal timeouts show up as
            //    AbortError with signal.aborted=false and as TimeoutError.
            if (
                streamError instanceof DOMException ||
                streamError instanceof Error
            ) {
                const name = streamError.name;
                if (name === "AbortError") {
                    if (abortController.signal.aborted) {
                        onError("Processing was stopped as requested");
                    } else {
                        onError(
                            "Request timed out during analysis. The analysis may be too complex - please try a simpler request.",
                        );
                    }
                    return;
                }
                if (name === "TimeoutError") {
                    onError(
                        "Request timed out during analysis. The analysis may be too complex - please try a simpler request.",
                    );
                    return;
                }
            }

            // 3. Retry transient network errors BEFORE the generic soft-error
            //    classifier below — otherwise "Load failed" / HTTP/2 reset
            //    would be shown to the user immediately instead of being
            //    retried with exponential backoff.
            const isRetryableError =
                streamError instanceof TypeError && streamError.message.includes('Load failed');

            if (isRetryableError && retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000;

                onStep({
                    id: 'retry_connection',
                    name: 'Connection Retry',
                    status: 'in_progress',
                    message: `Connection lost, retrying (${retryCount + 1}/3)...`,
                    timestamp: Date.now(),
                });

                setTimeout(() => {
                    this.sendMessageStream(
                        agentId,
                        message,
                        roomId,
                        onStep,
                        onActionResponse,
                        onIntermediateResponse,
                        onFinalResponse,
                        onRoomUpdate,
                        onError,
                        onComplete,
                        onStreamingUpdate,
                        favoriteTaskChain,
                        selectedFiles,
                        messageClassification,
                        language,
                        composed,
                        retryCount + 1,
                    );
                }, delay);
                return;
            }

            // 4. Soft "streaming error" surface for browser/proxy teardown
            //    (HTTP/2 reset, generic "network error") that was NOT a user
            //    stop and NOT a retryable "Load failed" TypeError. Chat-level
            //    handler shows a non-destructive toast so the user sees a
            //    clear signal but is not shown a full "Analysis Error".
            if (isLikelyStreamAbortError(streamError)) {
                onError(`Streaming error: ${streamError instanceof Error ? streamError.message : 'network error'}`);
                return;
            }

            if (streamError instanceof TypeError && streamError.message.includes('Load failed')) {
                onError(
                    `Network connection lost during analysis after ${retryCount} retries. Please check your connection and try again.`,
                );
            } else {
                const errorMessage = streamError instanceof Error ? streamError.message : 'Unknown error';
                onError(`Streaming error: ${errorMessage}`);
            }
        } finally {
            cleanup();
            try {
                reader?.releaseLock();
            } catch {
                /* reader may already be released */
            }
        }
    }
}
