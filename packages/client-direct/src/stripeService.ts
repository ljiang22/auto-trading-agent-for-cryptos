import Stripe from "stripe";
import { elizaLogger, getEnvVariable } from "@elizaos/core";

let stripeClient: Stripe | null = null;
let cachedSecretKey: string | undefined;

const STRIPE_RELEVANT_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
    "active",
    "trialing",
    "past_due",
    "incomplete",
    "incomplete_expired",
    "canceled",
];

const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
    "active",
    "trialing",
    "past_due",
];

type SubscriptionPlanName = "Plus" | "Pro" | "Enterprise";
export type ResolvedSubscriptionTier = "free" | "plus" | "pro" | "enterprise";

export interface SubscriptionItemSummary {
    id: string;
    priceId: string | null;
    productId: string | null;
    nickname: string | null;
    currency: string | null;
    unitAmount: number | null;
    interval: Stripe.Price.Recurring.Interval | null;
    intervalCount: number | null;
}

export interface SubscriptionSummary {
    id: string;
    status: Stripe.Subscription.Status;
    collectionMethod: Stripe.Subscription.CollectionMethod | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
    canceledAt: number | null;
    endedAt: number | null;
    items: SubscriptionItemSummary[];
    latestInvoiceId: string | null;
}

export interface SubscriptionLookupResult {
    email: string;
    customers: Array<{
        customerId: string;
        customerEmail: string | null;
        subscriptions: SubscriptionSummary[];
    }>;
}

export interface SubscriptionStatusSummary {
    /** Canonical tier. Use this as the single source of truth for user classification. */
    planName: SubscriptionPlanName | null;
    resolvedTier: ResolvedSubscriptionTier;
    primarySubscription: SubscriptionSummary | null;
}

export interface SubscriptionStatusLookup {
    lookupResult: SubscriptionLookupResult;
    summary: SubscriptionStatusSummary;
}

const resolveStripeSecret = (): string | undefined => {
    if (typeof cachedSecretKey === "undefined") {
        cachedSecretKey = getEnvVariable("STRIPE_SECRET_KEY");
    }
    return cachedSecretKey;
};

export const getStripeWebhookSecret = (): string | undefined =>
    getEnvVariable("STRIPE_WEBHOOK_SECRET");

export const isStripeConfigured = (): boolean => Boolean(resolveStripeSecret());

const getStripeClient = (): Stripe | null => {
    const secretKey = resolveStripeSecret();
    if (!secretKey) {
        return null;
    }

    if (!stripeClient) {
        stripeClient = new Stripe(secretKey, {
            appInfo: {
                name: "SentiEdge Subscription Sync",
            },
        });
    }

    return stripeClient;
};

const buildSubscriptionSummary = (
    subscription: Stripe.Subscription
): SubscriptionSummary => {
    const items: SubscriptionItemSummary[] = subscription.items.data.map(
        (item) => {
            const price = item.price;
            const productId =
                price?.product && typeof price.product === "object"
                    ? price.product.id
                    : typeof price?.product === "string"
                      ? price.product
                      : null;

            return {
                id: item.id,
                priceId: price?.id ?? null,
                productId,
                nickname: price?.nickname ?? null,
                currency: price?.currency ?? null,
                unitAmount: price?.unit_amount ?? null,
                interval: price?.recurring?.interval ?? null,
                intervalCount: price?.recurring?.interval_count ?? null,
            };
        }
    );

    return {
        id: subscription.id,
        status: subscription.status,
        collectionMethod: subscription.collection_method ?? null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
        currentPeriodStart: subscription.current_period_start ?? null,
        currentPeriodEnd: subscription.current_period_end ?? null,
        canceledAt: subscription.canceled_at ?? null,
        endedAt: subscription.ended_at ?? null,
        items,
        latestInvoiceId:
            typeof subscription.latest_invoice === "string"
                ? subscription.latest_invoice
                : subscription.latest_invoice?.id ?? null,
    };
};

const escapeEmailForQuery = (email: string): string =>
    email.replace(/'/g, "\\'");

export const lookupCustomerSubscriptionsByEmail = async (
    email: string
): Promise<SubscriptionLookupResult> => {
    const stripe = getStripeClient();
    if (!stripe) {
        throw new Error("Stripe secret key is not configured");
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
        throw new Error("A valid email is required to query Stripe");
    }

    try {
        const customers = await stripe.customers.search({
            query: `email:'${escapeEmailForQuery(normalizedEmail)}'`,
            limit: 10,
        });

        const customerSummaries = await Promise.all(
            customers.data.map(async (customer) => {
                const subscriptions = await stripe.subscriptions.list({
                    customer: customer.id,
                    status: "all",
                    expand: ["data.latest_invoice"],
                });

                const filteredSubscriptions = subscriptions.data.filter((sub) =>
                    STRIPE_RELEVANT_STATUSES.includes(sub.status)
                );

                return {
                    customerId: customer.id,
                    customerEmail:
                        typeof customer.email === "string"
                            ? customer.email.toLowerCase()
                            : null,
                    subscriptions: filteredSubscriptions.map(
                        buildSubscriptionSummary
                    ),
                };
            })
        );

        return {
            email: normalizedEmail,
            customers: customerSummaries,
        };
    } catch (error) {
        elizaLogger.error("Stripe subscription lookup failed", error);
        throw error;
    }
};

const hasAnyActiveSubscription = (
    result: SubscriptionLookupResult
): boolean =>
    result.customers.some((customer) =>
        customer.subscriptions.some((subscription) =>
            ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)
        )
    );

const normalizePlanToken = (value: string | null | undefined): string =>
    value?.toLowerCase() ?? "";

// Authoritative Price ID → plan mapping, loaded once from env.
// Env vars (comma-separated lists):
//   STRIPE_PRICE_IDS_PLUS, STRIPE_PRICE_IDS_PRO, STRIPE_PRICE_IDS_ENTERPRISE
const PRICE_ID_TO_PLAN: Map<string, SubscriptionPlanName> = (() => {
    const map = new Map<string, SubscriptionPlanName>();
    const add = (envKey: string, plan: SubscriptionPlanName) => {
        const raw = process.env[envKey];
        if (!raw) return;
        for (const id of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
            map.set(id, plan);
        }
    };
    add("STRIPE_PRICE_IDS_PLUS", "Plus");
    add("STRIPE_PRICE_IDS_PRO", "Pro");
    add("STRIPE_PRICE_IDS_ENTERPRISE", "Enterprise");
    return map;
})();

let warnedNicknameFallback = false;

const derivePlanFromSubscription = (
    subscription: SubscriptionSummary
): SubscriptionPlanName | null => {
    // Primary: resolve via stable Stripe Price IDs.
    for (const item of subscription.items) {
        if (item.priceId) {
            const plan = PRICE_ID_TO_PLAN.get(item.priceId);
            if (plan) return plan;
        }
    }

    // Fallback: exact-token match on nickname, not substring. Tokenizing on
    // non-alphanumerics prevents "professional" / "apropos" / "surplus" from
    // matching "pro" / "plus" via substring, while still accepting
    // "pro-monthly" / "pro_yearly" / "Pro Plan".
    for (const item of subscription.items) {
        const nickname = normalizePlanToken(item.nickname);
        if (!nickname) continue;
        const tokens = new Set(nickname.split(/[^a-z0-9]+/).filter(Boolean));

        let plan: SubscriptionPlanName | null = null;
        if (tokens.has("enterprise")) plan = "Enterprise";
        else if (tokens.has("pro")) plan = "Pro";
        else if (tokens.has("plus")) plan = "Plus";

        if (plan) {
            if (PRICE_ID_TO_PLAN.size === 0 && !warnedNicknameFallback) {
                warnedNicknameFallback = true;
                elizaLogger.warn(
                    `[Stripe] Plan resolved via nickname fallback ('${nickname}' → ${plan}). ` +
                    `Configure STRIPE_PRICE_IDS_{PLUS,PRO,ENTERPRISE} for authoritative matching.`
                );
            }
            return plan;
        }
    }

    return null;
};

const PLAN_PRIORITY: Record<SubscriptionPlanName, number> = {
    Plus: 1,
    Pro: 2,
    Enterprise: 3,
};

const planNameToTier = (
    planName: SubscriptionPlanName | null
): ResolvedSubscriptionTier => {
    if (planName === "Enterprise") {
        return "enterprise";
    }
    if (planName === "Pro") {
        return "pro";
    }
    if (planName === "Plus") {
        return "plus";
    }
    return "free";
};

const selectBestSubscription = (
    result: SubscriptionLookupResult,
    { activeOnly }: { activeOnly: boolean }
): SubscriptionStatusSummary["primarySubscription"] => {
    let bestSubscription: SubscriptionSummary | null = null;
    let bestPriority = 0;

    for (const customer of result.customers) {
        for (const subscription of customer.subscriptions) {
            if (
                activeOnly &&
                !ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)
            ) {
                continue;
            }

            const plan = derivePlanFromSubscription(subscription);
            if (!plan) {
                continue;
            }

            const priority = PLAN_PRIORITY[plan];
            if (priority > bestPriority) {
                bestPriority = priority;
                bestSubscription = subscription;
            }
        }
    }

    return bestSubscription;
};

export const summarizeSubscriptionStatus = (
    result: SubscriptionLookupResult
): SubscriptionStatusSummary => {
    const hasActive = hasAnyActiveSubscription(result);
    const primaryActiveSubscription = selectBestSubscription(result, {
        activeOnly: true,
    });

    const primarySubscription =
        primaryActiveSubscription ??
        selectBestSubscription(result, { activeOnly: false });
    const primaryActivePlan = primaryActiveSubscription
        ? derivePlanFromSubscription(primaryActiveSubscription)
        : null;
    const resolvedTier = hasActive
        ? primaryActivePlan
          ? planNameToTier(primaryActivePlan)
          : "plus"
        : "free";

    return {
        planName: primarySubscription
            ? derivePlanFromSubscription(primarySubscription)
            : null,
        resolvedTier,
        primarySubscription,
    };
};

export const getSubscriptionStatusByEmail = async (
    email: string
): Promise<SubscriptionStatusLookup> => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
        throw new Error("A valid email is required to query Stripe");
    }

    const lookupResult = await lookupCustomerSubscriptionsByEmail(normalizedEmail);
    const summary = summarizeSubscriptionStatus(lookupResult);
    return { lookupResult, summary };
};

export const constructStripeEvent = (
    payload: Buffer,
    signature: string,
    webhookSecret: string
): Stripe.Event => {
    const stripe = getStripeClient();
    if (!stripe) {
        throw new Error("Stripe secret key is not configured");
    }
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
};
