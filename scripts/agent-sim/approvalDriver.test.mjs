import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mintTestJwt, postApproval } from "./approvalDriver.mjs";

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

test("mintTestJwt returns null when no signing key is configured", () => {
  delete process.env.SIM_JWT_PRIVATE_KEY_B64;
  delete process.env.SIM_JWT_PRIVATE_KEY_FILE;
  assert.equal(mintTestJwt("u@example.com"), null);
});

test("mintTestJwt produces a verifiable RS256 token with the email claim", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const token = mintTestJwt("Trader@Example.com", { privateKeyPem: privateKey, now: 1_700_000_000_000 });
  const [h, p, sig] = token.split(".");
  // header alg
  assert.equal(JSON.parse(b64urlToBuf(h).toString()).alg, "RS256");
  // payload claims
  const payload = JSON.parse(b64urlToBuf(p).toString());
  assert.equal(payload.email, "Trader@Example.com");
  assert.equal(payload.exp - payload.iat, 3600);
  // signature verifies against the public key
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, b64urlToBuf(sig));
  assert.equal(ok, true);
});

test("postApproval posts the correct body and Bearer header", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const r = await postApproval({
    server: "http://x", agentId: "a1", jwt: "tok", threadId: "t1", approvalId: "ap1",
    decision: "approved", confirmationLevel: 1, fetchImpl: fakeFetch,
  });
  assert.equal(r.ok, true);
  assert.equal(captured.url, "http://x/agents/a1/cex-workflow/approval");
  assert.equal(captured.init.headers.Authorization, "Bearer tok");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, { threadId: "t1", approvalId: "ap1", decision: "approved", confirmationLevel: 1 });
});
