import rateLimit from "express-rate-limit";

const rateLimitMessage = { error: "Too many requests, please try again in a minute." };

const isLocalDevMode = () => process.env.LOCAL_DEV_MODE?.trim() === "1";

export const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isLocalDevMode() ? 500 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
    skip: () => isLocalDevMode(),
});

export const ttsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
});

export const whisperLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
});

export const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage,
});
