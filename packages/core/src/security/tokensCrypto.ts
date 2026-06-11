import crypto from "node:crypto";

const ENCRYPTION_ALGORITHM_ENV = "EXCHANGE_ENCRYPTION_ALGORITHM";
const IV_LENGTH_BYTES_ENV = "EXCHANGE_ENCRYPTION_IV_LENGTH";
const ENCRYPTED_SECRET_VERSION_ENV = "EXCHANGE_ENCRYPTED_SECRET_VERSION";
const ENCRYPTION_KEY_ENV = "EXCHANGE_TOKEN_ENCRYPTION_KEY";

const ENCRYPTION_ALGORITHM =
    (process.env[ENCRYPTION_ALGORITHM_ENV] as string | undefined) ||
    "aes-256-gcm";

const IV_LENGTH_BYTES = (() => {
    const raw = process.env[IV_LENGTH_BYTES_ENV];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 12;
})();

const ENCRYPTED_SECRET_VERSION = (() => {
    const raw = process.env[ENCRYPTED_SECRET_VERSION_ENV];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 1;
})();

export type EncryptedSecret = {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    ciphertext: string;
};

function getEncryptionKey(): Buffer {
    const rawKey = process.env[ENCRYPTION_KEY_ENV];
    if (!rawKey) {
        throw new Error(`${ENCRYPTION_KEY_ENV} is not configured`);
    }

    const key = Buffer.from(rawKey, "base64");
    if (key.length !== 32) {
        throw new Error(`${ENCRYPTION_KEY_ENV} must be base64-encoded 32 bytes`);
    }

    return key;
}

export function isEncrypted(value: unknown): value is EncryptedSecret {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.v === "number" &&
        typeof candidate.alg === "string" &&
        typeof candidate.iv === "string" &&
        typeof candidate.tag === "string" &&
        typeof candidate.ciphertext === "string"
    );
}

export function encrypt(plainText: string): EncryptedSecret {
    const normalizedPlainText = plainText;
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(
        ENCRYPTION_ALGORITHM,
        getEncryptionKey(),
        iv
    ) as unknown as crypto.CipherGCM;
    const ciphertext = Buffer.concat([
        cipher.update(normalizedPlainText, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        v: ENCRYPTED_SECRET_VERSION,
        alg: ENCRYPTION_ALGORITHM,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
    };
}

export function decrypt(secret: EncryptedSecret): string {
    const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        getEncryptionKey(),
        Buffer.from(secret.iv, "base64")
    ) as unknown as crypto.DecipherGCM;

    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));

    return Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

/**
 * M7 — full-mask secret preview. Previously this returned
 * `<first4>****`, which leaked enough of the API key for an over-the-
 * shoulder observer to verify ownership. Now returns a fixed-width
 * mask string regardless of the secret's actual length (the length
 * itself was another side channel).
 */
export function getSecretPreview(secret: string): string | null {
    if (!secret) {
        return null;
    }
    return "••••••••";
}

