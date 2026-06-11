import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { ANALYTICS_API_BASE_URL, apiClient } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

function sendWithBeacon(payload: object): boolean {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
        return false;
    }
    try {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        return navigator.sendBeacon(`${ANALYTICS_API_BASE_URL}/analytics/page-session`, blob);
    } catch {
        return false;
    }
}

export default function AnalyticsTracker() {
    const { isAuthenticated, user } = useAuth();
    const location = useLocation();
    const sessionRef = useRef<{
        path: string;
        startTime: number;
        clickCount: number;
        referrer: string | null;
    } | null>(null);
    const lastPathRef = useRef<string | null>(null);
    const userId = isAuthenticated && user?.id ? user.id : null;
    const userEmail = isAuthenticated && user?.email ? user.email : null;
    const userName = isAuthenticated
        ? [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() || null
        : null;

    const flushSession = (fallbackToApi: boolean) => {
        const current = sessionRef.current;
        if (!current) {
            return;
        }
        const endTime = Date.now();
        const durationMs = Math.max(0, endTime - current.startTime);
        const payload = {
            path: current.path,
            referrer: current.referrer,
            durationMs,
            clickCount: current.clickCount,
            startedAt: current.startTime,
            isAuthenticated,
            userId,
            userEmail,
            userName,
        };

        const sent = sendWithBeacon(payload);
        if (!sent && fallbackToApi) {
            apiClient.sendPageSession(payload).catch(() => undefined);
        }
        // End the current session immediately so hidden/pagehide/cleanup
        // cannot report the same session more than once.
        sessionRef.current = null;
    };

    const startSession = (path: string) => {
        const now = Date.now();
        const referrer = lastPathRef.current
            ? `${window.location.origin}${lastPathRef.current}`
            : document.referrer || null;

        sessionRef.current = {
            path,
            startTime: now,
            clickCount: 0,
            referrer,
        };
    };

    useEffect(() => {
        const handleClick = () => {
            if (sessionRef.current) {
                sessionRef.current.clickCount += 1;
            }
        };
        document.addEventListener("click", handleClick, { capture: true });
        return () => {
            document.removeEventListener("click", handleClick, { capture: true });
        };
    }, []);

    useEffect(() => {
        startSession(location.pathname);
        lastPathRef.current = location.pathname;

        return () => {
            flushSession(true);
        };
    }, [location.pathname, isAuthenticated, userId, userEmail, userName]);

    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === "hidden") {
                flushSession(false);
                return;
            }
            if (!sessionRef.current) {
                startSession(location.pathname);
                lastPathRef.current = location.pathname;
            }
        };

        const handlePageHide = () => {
            flushSession(false);
        };

        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("pagehide", handlePageHide);

        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("pagehide", handlePageHide);
        };
    }, [location.pathname, isAuthenticated, userId, userEmail, userName]);

    return null;
}
