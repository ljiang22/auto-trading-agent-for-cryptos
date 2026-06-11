export const ONBOARDING_PENDING_EMAIL_KEY = "sentiedge:onboarding:pending-email";
export const ONBOARDING_COMPLETED_KEY_PREFIX = "sentiedge:onboarding:completed:";
export const ONBOARDING_TOUR_PAUSED_KEY = "sentiedge:onboarding:paused";
export const ONBOARDING_DEMO_ASK_EVENT = "sentiedge:onboarding:demo-ask";
export const ONBOARDING_DEMO_QUESTION = "What is the price of BTC?";
export const ONBOARDING_DEMO_COMPARE_SOURCE = "onboarding_demo_compare";
export const ONBOARDING_DEMO_ACTIVE_KEY = "sentiedge:onboarding:demo-active";
export const ONBOARDING_DEMO_SELECT_TAB_EVENT = "sentiedge:onboarding:demo-select-tab";

export type OnboardingTourId = "main" | "chat";

export type OnboardingTourPauseState = {
    tourId: OnboardingTourId;
    resumeStepIndex: number;
    startedAt: number;
    reason?: "demo" | "live-chat";
    returnPath?: string;
};

export const getOnboardingCompletedKey = (userId: string, tourId: OnboardingTourId = "main") =>
    `${ONBOARDING_COMPLETED_KEY_PREFIX}${userId}:${tourId}`;
