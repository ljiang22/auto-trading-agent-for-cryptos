import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Joyride, {
    ACTIONS,
    EVENTS,
    STATUS,
    type CallBackProps,
    type Step,
    type TooltipRenderProps,
} from "react-joyride";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    ONBOARDING_DEMO_ACTIVE_KEY,
    ONBOARDING_DEMO_ASK_EVENT,
    ONBOARDING_DEMO_QUESTION,
    ONBOARDING_DEMO_SELECT_TAB_EVENT,
    ONBOARDING_PENDING_EMAIL_KEY,
    ONBOARDING_TOUR_PAUSED_KEY,
    getOnboardingCompletedKey,
    type OnboardingTourId,
    type OnboardingTourPauseState,
} from "@/lib/onboarding";

const readLocalStorage = (key: string): string | null => {
    if (typeof window === "undefined") {
        return null;
    }
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
};

const writeLocalStorage = (key: string, value: string) => {
    if (typeof window === "undefined") {
        return;
    }
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // ignore storage failures (private mode, blocked, etc.)
    }
};

const removeLocalStorage = (key: string) => {
    if (typeof window === "undefined") {
        return;
    }
    try {
        window.localStorage.removeItem(key);
    } catch {
        // ignore
    }
};

const targetNeedsSidebar = (target: string) => {
    return target.includes("sidebar-");
};

export default function OnboardingTour() {
    const location = useLocation();
    const navigate = useNavigate();
    const { user, isAuthenticated } = useAuth();
    const { theme } = useTheme();
    const { isMobile, open, setOpen, openMobile, setOpenMobile } = useSidebar();

    const [run, setRun] = useState(false);
    const [stepIndex, setStepIndex] = useState(0);
    const [activeTour, setActiveTour] = useState<OnboardingTourId>("main");
    const [pendingStartTour, setPendingStartTour] = useState<OnboardingTourId | null>(null);
    const [joyrideKey, setJoyrideKey] = useState(0);
    const delayedStepTimerRef = useRef<number | null>(null);
    const pausedStateRef = useRef<OnboardingTourPauseState | null>(null);
    const pendingResumeRef = useRef<OnboardingTourPauseState | null>(null);
    const targetNotFoundRetryRef = useRef<Record<string, number>>({});

    const [continueDialogOpen, setContinueDialogOpen] = useState(false);
    const [completedDialogOpen, setCompletedDialogOpen] = useState(false);
    const completedDialogLastStepIndexRef = useRef(0);
    const [mode, setMode] = useState<"normal" | "demo">("normal");
    const [demoAnswerIndex, setDemoAnswerIndex] = useState<0 | 1 | 2>(0);
    const [demoReady, setDemoReady] = useState(false);

    const scrollTargetIntoView = (selector: string) => {
        if (typeof window === "undefined" || !selector) {
            return;
        }

        const element = window.document.querySelector(selector);
        if (!element) {
            return;
        }

        const rect = element.getBoundingClientRect();
        const isInViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;
        if (isInViewport) {
            return;
        }

        const sidebarTarget = targetNeedsSidebar(selector);
        element.scrollIntoView?.({
            block: sidebarTarget ? "nearest" : "center",
            inline: "nearest",
        });
    };

    useEffect(() => {
        return () => {
            if (delayedStepTimerRef.current && typeof window !== "undefined") {
                window.clearTimeout(delayedStepTimerRef.current);
                delayedStepTimerRef.current = null;
            }
        };
    }, []);

    const mainCompletedKey = user?.id ? getOnboardingCompletedKey(user.id, "main") : null;
    const activeCompletedKey = user?.id ? getOnboardingCompletedKey(user.id, activeTour) : null;

    const mainSteps: Step[] = useMemo(
        () => [
            {
                target: "body",
                placement: "center",
                title: "Welcome",
                content: "Quick tour — We will show you around so you can get started quickly.",
            },
            {
                target: "[data-tour='landing-search']",
                placement: "bottom",
                title: "Search",
                content: "Type a question here to start a new crypto research chat.",
            },
            {
                target: "[data-tour='landing-attach']",
                placement: "bottom",
                title: "Attach",
                content: "Attach files (images, PDFs, docs) to give the agent more context.",
            },
            {
                target: "[data-tour='landing-favorites']",
                placement: "bottom",
                title: "Favorites",
                content: "Open your favorite task chains and reuse them in a new chat.",
            },
            {
                target: "[data-tour='landing-voice']",
                placement: "bottom",
                title: "Voice",
                content: "Start voice input.",
            },
            {
                target: "[data-tour='landing-ask']",
                placement: "left",
                title: "Ask",
                content: "Click Ask to create a chat room and send your first message.",
            },
            {
                target: "[data-tour='sidebar-toggle']",
                placement: "right",
                title: "Sidebar",
                content: "Collapse/expand the sidebar.",
            },
            {
                target: "[data-tour='sidebar-share']",
                placement: "right",
                title: "Share",
                content: "Invite friends and share your referral link.",
            },
            {
                target: "[data-tour='sidebar-feedback']",
                placement: "right",
                title: "Feedback",
                content: "Send feedback to the team from inside the app.",
            },
            {
                target: "[data-tour='sidebar-faq']",
                placement: "right",
                title: "FAQ",
                content: "Open FAQs and quick help in a new tab.",
            },
            {
                target: "[data-tour='chat-share']",
                placement: "left",
                title: "Share chat",
                content: "Share a chat as a link or image export.",
            },
            {
                target: "[data-tour='user-menu']",
                placement: "left",
                title: "Account",
                content: "Upgrade, theme, settings, and sign out here.",
            },
        ],
        []
    );

    const chatSteps: Step[] = useMemo(
        () => [
            {
                target: "body",
                placement: "center",
                title: "Chat tour",
                content: "Quick tour of the chat controls.",
            },
            {
                target: "[data-tour='chat-input']",
                placement: "top",
                title: "Message box",
                content: "Type your message here.",
            },
            {
                target: "[data-tour='chat-attach']",
                placement: "top",
                title: "Attach",
                content: "Attach files to your message.",
            },
            {
                target: "[data-tour='chat-favorites']",
                placement: "top",
                title: "Favorites",
                content: "Insert a saved task chain into the chat.",
            },
            {
                target: "[data-tour='chat-send']",
                placement: "top",
                title: "Send",
                content: "Send your message to the agent.",
            },
            {
                target: "[data-tour='sidebar-toggle']",
                placement: "right",
                title: "Sidebar",
                content: "Collapse/expand the sidebar (and open it on mobile).",
            },
            {
                target: "[data-tour='sidebar-feedback']",
                placement: "right",
                title: "Feedback",
                content: "Send feedback from inside the app.",
            },
            {
                target: "[data-tour='sidebar-faq']",
                placement: "right",
                title: "FAQ",
                content: "Open FAQs in a new tab.",
            },
            {
                target: "[data-tour='chat-share']",
                placement: "left",
                title: "Share",
                content: "Share this chat as a link or image export.",
            },
            {
                target: "[data-tour='user-menu']",
                placement: "left",
                title: "Account",
                content: "Upgrade, theme, settings, and sign out.",
            },
        ],
        []
    );

    const steps = activeTour === "chat" ? chatSteps : mainSteps;
    const primaryColor = theme === "dark" ? "#60a5fa" : "#2563eb";
    const tooltipBackground = theme === "dark" ? "#0b1220" : "#ffffff";
    const tooltipTextColor = theme === "dark" ? "#e5e7eb" : "#111827";
    const tooltipBorderColor = theme === "dark" ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)";

    const startDemoAskInChat = () => {
        if (typeof window === "undefined") {
            return;
        }
        const resumeStepIndex = stepIndex + 1;
        const pauseState: OnboardingTourPauseState = {
            tourId: activeTour,
            resumeStepIndex,
            startedAt: Date.now(),
            reason: "demo",
            returnPath: location.pathname,
        };
        writeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY, JSON.stringify(pauseState));
        pausedStateRef.current = pauseState;

        try {
            window.localStorage.setItem(ONBOARDING_DEMO_ACTIVE_KEY, "1");
        } catch {
            // ignore
        }

        // Pause the current tour, navigate to chat, and start the demo mini-tour there.
        setRun(false);
        setMode("demo");
        setDemoAnswerIndex(0);
        setDemoReady(false);

        window.dispatchEvent(
            new CustomEvent(ONBOARDING_DEMO_ASK_EVENT, {
                detail: { question: ONBOARDING_DEMO_QUESTION },
            })
        );
    };

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        if (mode !== "demo" || !location.pathname.startsWith("/chat")) {
            setDemoReady(false);
            return;
        }

        let intervalId: number | null = null;
        const checkReady = () => {
            const element = window.document.querySelector("[data-tour='demo-compare']");
            if (!element) {
                return;
            }
            setDemoReady(true);
            if (intervalId) {
                window.clearInterval(intervalId);
                intervalId = null;
            }
        };

        // Check immediately, then poll briefly while the chat thread renders.
        checkReady();
        intervalId = window.setInterval(checkReady, 250);

        return () => {
            if (intervalId) {
                window.clearInterval(intervalId);
            }
        };
    }, [location.pathname, mode]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }
        if (mode !== "demo" || !location.pathname.startsWith("/chat")) {
            return;
        }

        const tabForIndex: "regular" | "comprehensive" | "task-chain" =
            demoAnswerIndex === 1 ? "comprehensive" : demoAnswerIndex === 2 ? "task-chain" : "regular";

        try {
            window.dispatchEvent(
                new CustomEvent(ONBOARDING_DEMO_SELECT_TAB_EVENT, { detail: { tab: tabForIndex } })
            );
        } catch {
            // ignore
        }
    }, [demoAnswerIndex, location.pathname, mode]);

    useEffect(() => {
        const pendingResume = pendingResumeRef.current;
        if (!pendingResume) {
            return;
        }
        if (pendingResume.returnPath && location.pathname !== pendingResume.returnPath) {
            return;
        }

        pendingResumeRef.current = null;
        pausedStateRef.current = null;
        removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);

        setContinueDialogOpen(false);
        setActiveTour(pendingResume.tourId);
        setStepIndex(Math.max(0, pendingResume.resumeStepIndex));
        setJoyrideKey((value) => value + 1);
        setRun(true);
    }, [location.pathname]);

    const resumePausedTour = () => {
        const stored = readLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
        let parsedStored: Partial<OnboardingTourPauseState> | null = null;
        if (stored && stored.trim().length > 0) {
            try {
                parsedStored = JSON.parse(stored) as Partial<OnboardingTourPauseState>;
            } catch {
                parsedStored = null;
            }
        }

        const paused = pausedStateRef.current ?? (parsedStored as OnboardingTourPauseState | null);
        if (!paused) {
            setContinueDialogOpen(false);
            return;
        }

        // If we need to go back to a different screen (e.g., resume main tour on landing),
        // navigate first, then resume once the route matches.
        if (paused.returnPath && location.pathname !== paused.returnPath) {
            pendingResumeRef.current = paused;
            setRun(false);
            setContinueDialogOpen(false);
            navigate(paused.returnPath, { replace: false });
            return;
        }

        removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
        pausedStateRef.current = null;

        setContinueDialogOpen(false);
        setActiveTour(paused.tourId);
        setStepIndex(Math.max(0, paused.resumeStepIndex));
        setJoyrideKey((value) => value + 1);
        setRun(true);
    };

    const resumePausedTourInPlace = () => {
        const stored = readLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
        let parsedStored: Partial<OnboardingTourPauseState> | null = null;
        if (stored && stored.trim().length > 0) {
            try {
                parsedStored = JSON.parse(stored) as Partial<OnboardingTourPauseState>;
            } catch {
                parsedStored = null;
            }
        }

        const paused = pausedStateRef.current ?? (parsedStored as OnboardingTourPauseState | null);
        if (!paused) {
            setContinueDialogOpen(false);
            return;
        }

        removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
        pausedStateRef.current = null;

        setContinueDialogOpen(false);
        setActiveTour(paused.tourId);
        setStepIndex(Math.max(0, paused.resumeStepIndex));
        setJoyrideKey((value) => value + 1);
        setRun(true);
    };

    const endPausedTour = () => {
        if (!user?.id) {
            setContinueDialogOpen(false);
            removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
            pausedStateRef.current = null;
            return;
        }

        const paused = pausedStateRef.current;
        const tourId = paused?.tourId ?? activeTour;
        writeLocalStorage(getOnboardingCompletedKey(user.id, tourId), "1");
        writeLocalStorage(getOnboardingCompletedKey(user.id, "chat"), "1");

        removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
        pausedStateRef.current = null;
        setContinueDialogOpen(false);
        setRun(false);
        setStepIndex(0);
    };

    function TourTooltip(props: TooltipRenderProps) {
        const {
            tooltipProps,
            step,
            index,
            size,
            backProps,
            primaryProps,
            skipProps,
            closeProps,
            isLastStep,
        } = props;

        const containerStyle: CSSProperties = {
            background: tooltipBackground,
            color: tooltipTextColor,
            padding: 14,
            borderRadius: 12,
            border: `1px solid ${tooltipBorderColor}`,
            boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
            maxWidth: 360,
        };

        const secondaryButtonStyle = (disabled?: boolean) =>
            ({
                border: `1px solid ${tooltipBorderColor}`,
                background: "transparent",
                color: tooltipTextColor,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                fontSize: 13,
                lineHeight: "13px",
            }) as const;

        const primaryButtonStyle =
            ({
                border: `1px solid ${primaryColor}`,
                background: primaryColor,
                color: "#ffffff",
                padding: "8px 12px",
                borderRadius: 10,
                cursor: "pointer",
                fontSize: 13,
                lineHeight: "13px",
                fontWeight: 600,
            }) as const;

        const backDisabled = Boolean((backProps as { disabled?: boolean }).disabled);
        const isLandingAskStep = typeof step.target === "string" && step.target === "[data-tour='landing-ask']";

        return (
            <div {...tooltipProps} style={containerStyle}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {typeof step.title === "string" ? step.title : "Tour"}
                    </div>
                    <button
                        {...closeProps}
                        type="button"
                        style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            fontSize: 18,
                            lineHeight: "18px",
                            padding: 0,
                            opacity: 0.8,
                            color: tooltipTextColor,
                        }}
                        aria-label="Close tour"
                    >
                        ×
                    </button>
                </div>

                <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.45 }}>
                    {isLandingAskStep ? (
                        <div>
                            <div>{step.content}</div>
                            <div style={{ marginTop: 10 }}>
                                View how the same question produces different responses in Regular, Comprehensive, and
                                Task Chain styles.
                            </div>
                            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                                <button
                                    type="button"
                                    onClick={startDemoAskInChat}
                                    style={{
                                        border: `1px solid ${primaryColor}`,
                                        background: primaryColor,
                                        color: "#ffffff",
                                        padding: "10px 12px",
                                        borderRadius: 10,
                                        cursor: "pointer",
                                        textAlign: "left",
                                        fontWeight: 700,
                                        fontSize: 13,
                                    }}
                                >
                                    Send demo question in chat
                                </button>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>
                                    Demo question: “{ONBOARDING_DEMO_QUESTION}”
                                </div>
                            </div>
                        </div>
                    ) : (
                        step.content
                    )}
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 12 }}>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>
                        {index + 1}/{size}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button {...backProps} type="button" style={secondaryButtonStyle(backDisabled)}>
                            Back
                        </button>
                        <button {...primaryProps} type="button" style={primaryButtonStyle}>
                            {isLastStep ? "Finish" : "Next"}
                        </button>
                        <button {...skipProps} type="button" style={secondaryButtonStyle(false)}>
                            Skip
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const startTour = useCallback((tourId: OnboardingTourId) => {
        setActiveTour(tourId);
        setStepIndex(0);
        setJoyrideKey((value) => value + 1);
        setRun(true);
    }, []);

    useEffect(() => {
        if (!isAuthenticated || !user?.id || run) {
            return;
        }
        if (!mainCompletedKey) {
            return;
        }

        // If the tour was intentionally paused (e.g., user jumped into chat to run an example),
        // do not auto-start any tour until they choose to resume or end it.
        if (readLocalStorage(ONBOARDING_TOUR_PAUSED_KEY)) {
            return;
        }

        const pendingEmail = readLocalStorage(ONBOARDING_PENDING_EMAIL_KEY);
        const normalizedPendingEmail = pendingEmail?.trim().toLowerCase() ?? null;
        const normalizedUserEmail = user.email?.trim().toLowerCase() ?? "";
        const shouldForceMain = !!normalizedPendingEmail && normalizedPendingEmail === normalizedUserEmail;

        const mainCompleted = readLocalStorage(mainCompletedKey) === "1";

        if (pendingStartTour) {
            const waitingForLanding = pendingStartTour === "main" && location.pathname === "/";
            const waitingForChat = pendingStartTour === "chat" && location.pathname.startsWith("/chat");
            if (waitingForLanding || waitingForChat) {
                setPendingStartTour(null);
                startTour(pendingStartTour);
            }
            return;
        }

        if (shouldForceMain) {
            if (location.pathname !== "/") {
                setPendingStartTour("main");
                navigate("/", { replace: true });
                return;
            }
            if (!mainCompleted) {
                removeLocalStorage(ONBOARDING_PENDING_EMAIL_KEY);
                startTour("main");
            }
            return;
        }

        if (location.pathname === "/" && !mainCompleted) {
            startTour("main");
            return;
        }
    }, [
        isAuthenticated,
        location.pathname,
        mainCompletedKey,
        navigate,
        pendingStartTour,
        run,
        startTour,
        user,
    ]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const handler = (event: Event) => {
            if (!isAuthenticated || !user?.id) {
                return;
            }
            const detail = (event as CustomEvent<{ tourId?: OnboardingTourId }>).detail;
            const tourId: OnboardingTourId = detail?.tourId ?? "main";

            removeLocalStorage(getOnboardingCompletedKey(user.id, tourId));
            removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);

            if (tourId === "main" && location.pathname !== "/") {
                setPendingStartTour("main");
                navigate("/", { replace: false });
                return;
            }

            startTour(tourId);
        };

        window.addEventListener("sentiedge:onboarding:start", handler as EventListener);
        return () => {
            window.removeEventListener("sentiedge:onboarding:start", handler as EventListener);
        };
    }, [isAuthenticated, location.pathname, navigate, startTour, user]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const handler = (event: Event) => {
            if (!isAuthenticated || !user?.id) {
                return;
            }

            const detail = (event as CustomEvent<{ tourId?: OnboardingTourId; stepIndex?: number }>).detail;
            const stored = readLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
            let parsedStored: Partial<OnboardingTourPauseState> | null = null;
            if (stored && stored.trim().length > 0) {
                try {
                    parsedStored = JSON.parse(stored) as Partial<OnboardingTourPauseState>;
                } catch {
                    parsedStored = null;
                }
            }

            const tourId = (detail?.tourId ?? parsedStored?.tourId ?? "main") as OnboardingTourId;
            const resumeIndexRaw = detail?.stepIndex ?? parsedStored?.resumeStepIndex;
            const resumeIndex = typeof resumeIndexRaw === "number" ? resumeIndexRaw : 0;

            removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);

            setActiveTour(tourId);
            setStepIndex(Math.max(0, resumeIndex));
            setJoyrideKey((value) => value + 1);
            setRun(true);
        };

        window.addEventListener("sentiedge:onboarding:resume", handler as EventListener);
        return () => {
            window.removeEventListener("sentiedge:onboarding:resume", handler as EventListener);
        };
    }, [isAuthenticated, user]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const handler = (event: Event) => {
            if (!isAuthenticated || !user?.id) {
                return;
            }

            const detail = (event as CustomEvent<{ tourId?: OnboardingTourId }>).detail;
            const tourId = (detail?.tourId ?? "main") as OnboardingTourId;

            // End means: mark the tour as completed so it doesn't auto-start again.
            writeLocalStorage(getOnboardingCompletedKey(user.id, tourId), "1");

            // If we ended from within chat, also mark the chat tour as completed to prevent immediate auto-start.
            writeLocalStorage(getOnboardingCompletedKey(user.id, "chat"), "1");

            removeLocalStorage(ONBOARDING_TOUR_PAUSED_KEY);
            setRun(false);
            setStepIndex(0);
        };

        window.addEventListener("sentiedge:onboarding:end", handler as EventListener);
        return () => {
            window.removeEventListener("sentiedge:onboarding:end", handler as EventListener);
        };
    }, [isAuthenticated, user]);

    useEffect(() => {
        if (!run) {
            return;
        }

        const currentTarget = steps[stepIndex]?.target;
        const target = typeof currentTarget === "string" ? currentTarget : "";
        const needsSidebar = targetNeedsSidebar(target);
        if (!needsSidebar) {
            return;
        }

        if (isMobile) {
            if (!openMobile) {
                setOpenMobile(true);
            }
            return;
        }

        if (!open) {
            setOpen(true);
        }
    }, [isMobile, open, openMobile, run, setOpen, setOpenMobile, stepIndex, steps]);

    const handleCallback = (data: CallBackProps) => {
        const { action, index, status, type } = data;

        if (delayedStepTimerRef.current && typeof window !== "undefined") {
            window.clearTimeout(delayedStepTimerRef.current);
            delayedStepTimerRef.current = null;
        }

        if (type === EVENTS.TARGET_NOT_FOUND) {
            const currentTarget = typeof data.step?.target === "string" ? data.step.target : "";
            if (targetNeedsSidebar(currentTarget)) {
                // Sidebar targets (including Hub) can be missing briefly while the sidebar animates open.
                // Retry the step instead of skipping it.
                if (isMobile) {
                    if (!openMobile) {
                        setOpenMobile(true);
                    }
                } else if (!open) {
                    setOpen(true);
                }

                if (typeof window !== "undefined") {
                    window.setTimeout(() => {
                        setJoyrideKey((value) => value + 1);
                        scrollTargetIntoView(currentTarget);
                    }, 250);
                }
                return;
            }

            if (currentTarget === "[data-tour='chat-share']") {
                const retryKey = `${activeTour}:${index}:${currentTarget}`;
                const attempts = targetNotFoundRetryRef.current[retryKey] ?? 0;
                if (attempts < 3 && typeof window !== "undefined") {
                    targetNotFoundRetryRef.current[retryKey] = attempts + 1;
                    window.setTimeout(() => {
                        setJoyrideKey((value) => value + 1);
                        scrollTargetIntoView(currentTarget);
                    }, 250);
                    return;
                }
            }
        }

        if (type === EVENTS.STEP_BEFORE) {
            const currentTarget = typeof data.step?.target === "string" ? data.step.target : "";
            const needsSidebar = targetNeedsSidebar(currentTarget);
            if (needsSidebar) {
                if (isMobile) {
                    if (!openMobile) {
                        setOpenMobile(true);
                    }
                } else if (!open) {
                    setOpen(true);
                }
            }

            if (typeof window !== "undefined" && currentTarget) {
                window.setTimeout(() => {
                    scrollTargetIntoView(currentTarget);
                }, needsSidebar ? 150 : 0);
            }
        }

        if (status === STATUS.FINISHED) {
            if (activeCompletedKey) {
                writeLocalStorage(activeCompletedKey, "1");
            }
            removeLocalStorage(ONBOARDING_PENDING_EMAIL_KEY);
            setRun(false);
            const lastStepIndex = Math.max(0, steps.length - 1);
            completedDialogLastStepIndexRef.current = lastStepIndex;
            setStepIndex(lastStepIndex);
            setCompletedDialogOpen(true);
            return;
        }

        if (status === STATUS.SKIPPED) {
            if (activeCompletedKey) {
                writeLocalStorage(activeCompletedKey, "1");
            }
            removeLocalStorage(ONBOARDING_PENDING_EMAIL_KEY);
            setRun(false);
            setStepIndex(0);
            return;
        }

        if (type === EVENTS.STEP_AFTER) {
            const delta = action === ACTIONS.PREV ? -1 : 1;
            const nextIndex = index + delta;

            const nextTarget = typeof steps[nextIndex]?.target === "string" ? steps[nextIndex].target : "";
            const needsSidebar = targetNeedsSidebar(nextTarget);

            if (needsSidebar) {
                const sidebarReady = isMobile ? openMobile : open;
                if (!sidebarReady) {
                    if (isMobile) {
                        setOpenMobile(true);
                    } else {
                        setOpen(true);
                    }

                    if (typeof window !== "undefined") {
                        delayedStepTimerRef.current = window.setTimeout(() => {
                            setJoyrideKey((value) => value + 1);
                            if (nextTarget) {
                                scrollTargetIntoView(nextTarget);
                            }
                            setStepIndex(nextIndex);
                        }, 250);
                        return;
                    }
                }
            }

            setStepIndex(nextIndex);
        }
    };

    if (!isAuthenticated || !user) {
        return null;
    }

    return (
        <>
            <Joyride
                key={joyrideKey}
                callback={handleCallback}
                continuous
                run={run}
                stepIndex={stepIndex}
                steps={steps}
                showProgress={false}
                showSkipButton
                tooltipComponent={TourTooltip}
                spotlightClicks
                disableOverlayClose
                disableScrolling
                styles={{
                    options: {
                        zIndex: 10000,
                        primaryColor,
                        backgroundColor: tooltipBackground,
                        textColor: tooltipTextColor,
                        arrowColor: tooltipBackground,
                    },
                    overlay: {
                        backgroundColor:
                            theme === "dark" ? "rgba(0,0,0,0.72)" : "rgba(17,24,39,0.55)",
                    },
                    tooltipContainer: {
                        textAlign: "left",
                        borderRadius: 12,
                    },
                }}
                locale={{
                    back: "Back",
                    close: "Close",
                    last: "Finish",
                    next: "Next",
                    skip: "Skip",
                }}
            />

            {mode === "demo" && location.pathname.startsWith("/chat") ? (
                <div className="fixed right-4 top-24 z-[10001] w-[320px] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 dark:border-white/10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-xl p-4 space-y-3">
                    <div className="text-sm font-semibold text-foreground">Answer styles</div>
                    <div className="text-sm text-muted-foreground">
	                        {demoReady ? (
	                            demoAnswerIndex === 0 ? (
	                                "You are viewing the Regular answer style. Click Next to see the Comprehensive version."
	                            ) : demoAnswerIndex === 1 ? (
	                                "You are viewing the Comprehensive answer style. Click Next to see the Task Chain version."
	                            ) : (
	                                "You are viewing the Task Chain answer style. Click Next to continue the tour."
	                            )
	                        ) : (
	                            "Loading the demo answers in chat..."
	                        )}
	                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={!demoReady || demoAnswerIndex === 0}
                            onClick={() => setDemoAnswerIndex((value) => (value === 0 ? 0 : ((value - 1) as 0 | 1 | 2)))}
                        >
                            Back
                        </Button>
                        <Button
                            type="button"
                            className="ml-auto"
                            disabled={!demoReady}
                            onClick={() => {
                                if (demoAnswerIndex < 2) {
                                    setDemoAnswerIndex((value) => ((value + 1) as 0 | 1 | 2));
                                    return;
                                }

                                if (typeof window !== "undefined") {
                                    try {
                                        window.localStorage.removeItem(ONBOARDING_DEMO_ACTIVE_KEY);
                                    } catch {
                                        // ignore
                                    }
                                }

                                setMode("normal");
                                setDemoAnswerIndex(0);
                                setDemoReady(false);
                                // Resume the original 11-step tour right where it left off,
                                // without forcing navigation away from the chat.
                                resumePausedTourInPlace();
                            }}
                        >
                            Next
                        </Button>
                    </div>
                </div>
            ) : null}

            <Dialog open={completedDialogOpen} onOpenChange={(open) => setCompletedDialogOpen(open)}>
                <DialogContent
                    hideCloseButton
                    onEscapeKeyDown={(event) => event.preventDefault()}
                    onPointerDownOutside={(event) => event.preventDefault()}
                >
                    <DialogHeader>
                        <DialogTitle>Tour complete</DialogTitle>
                        <DialogDescription>
                            You have completed the tour. Try asking a question to see the agent in action.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            variant="outline"
                            onClick={() => {
                                const lastStepIndex = Math.max(0, completedDialogLastStepIndexRef.current);
                                const lastTarget =
                                    typeof steps[lastStepIndex]?.target === "string" ? steps[lastStepIndex].target : "";
                                const needsSidebar = targetNeedsSidebar(lastTarget);

                                if (needsSidebar) {
                                    if (isMobile) {
                                        if (!openMobile) {
                                            setOpenMobile(true);
                                        }
                                    } else if (!open) {
                                        setOpen(true);
                                    }
                                }

                                setCompletedDialogOpen(false);
                                setStepIndex(lastStepIndex);
                                setJoyrideKey((value) => value + 1);
                                setRun(true);

                                if (typeof window !== "undefined" && lastTarget) {
                                    window.setTimeout(() => {
                                        scrollTargetIntoView(lastTarget);
                                    }, needsSidebar ? 150 : 0);
                                }
                            }}
                        >
                            Back
                        </Button>
                        <Button
                            onClick={() => {
                                setCompletedDialogOpen(false);
                                setRun(false);
                                setStepIndex(0);
                            }}
                        >
                            End
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={continueDialogOpen} onOpenChange={(open) => setContinueDialogOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Continue the tour?</DialogTitle>
                        <DialogDescription>
                            Want to continue the UI walkthrough from where you left off?
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button variant="outline" onClick={endPausedTour}>
                            No, end tour
                        </Button>
                        <Button onClick={resumePausedTour}>
                            Yes, continue
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
