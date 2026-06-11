import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function loadSigningKey() {
  const b64 = process.env.SIM_JWT_PRIVATE_KEY_B64?.trim();
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  const file = process.env.SIM_JWT_PRIVATE_KEY_FILE?.trim();
  if (file) return readFileSync(file, "utf8");
  return null;
}

/**
 * Mint an RS256 JWT for a paper-trading test user. Returns null when no signing key
 * is configured (the harness then runs SSE-only assertions and skips approval driving).
 * @param {string} email
 * @param {{ privateKeyPem?: string|null, ttlSec?: number, now?: number }} [opts]
 */
export function mintTestJwt(email, { privateKeyPem = loadSigningKey(), ttlSec = 3600, now } = {}) {
  if (!privateKeyPem) return null;
  const iat = Math.floor((now ?? Date.now()) / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { email, role: "user", iat, exp: iat + ttlSec };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

export async function postApproval({ server, agentId, jwt, threadId, approvalId, decision, confirmationLevel, parameters, feedback, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch;
  const url = `${String(server).replace(/\/$/, "")}/agents/${agentId}/cex-workflow/approval`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      threadId,
      ...(approvalId ? { approvalId } : {}),
      decision,
      confirmationLevel,
      ...(parameters ? { parameters } : {}),
      ...(feedback ? { feedback } : {}),
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, body };
}
