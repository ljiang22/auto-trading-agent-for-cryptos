#!/usr/bin/env node
/**
 * dev-auth.mjs — LOCAL-DEV ONLY auth helper (no Django required).
 *
 * The agent authenticates by verifying an RS256 JWT against JWT_PUBLIC_KEY_B64 (normally
 * Django's public key). For local testing you can be your own issuer: generate a throwaway
 * RSA keypair, point a locally-started agent at its public key, and mint tokens with the
 * matching private key. Tokens minted here will NOT verify in staging/prod (those use
 * Django's real key), so this only works against an agent you explicitly started with this
 * dev public key — it cannot grant access to any real deployment.
 *
 * Keypair lives in .dev-auth/ (gitignored, per-developer). Usage:
 *   node scripts/dev-auth.mjs init                              # make keypair; print env to set
 *   node scripts/dev-auth.mjs token [--email E] [--ttl-hours N] # mint a token + browser snippet
 *   node scripts/dev-auth.mjs pubkey                            # print JWT_PUBLIC_KEY_B64 only
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mintTestJwt } from "./agent-sim/approvalDriver.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(REPO, ".dev-auth");
const PRIV = join(DIR, "jwt_dev_priv.pem");
const PUB = join(DIR, "jwt_dev_pub.pem");

function ensureKeypair() {
  if (existsSync(PRIV) && existsSync(PUB)) return;
  mkdirSync(DIR, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(PRIV, privateKey, { mode: 0o600 });
  writeFileSync(PUB, publicKey);
  console.error(`[dev-auth] generated dev keypair in ${DIR} (gitignored)`);
}

function pubKeyB64() {
  ensureKeypair();
  return Buffer.from(readFileSync(PUB, "utf8")).toString("base64");
}

function parseArgs(argv) {
  const m = new Map();
  for (let i = 3; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const [k, inline] = t.slice(2).split("=", 2);
    if (inline !== undefined) m.set(k, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) m.set(k, argv[(i += 1)]);
    else m.set(k, true);
  }
  return m;
}

const cmd = process.argv[2];
const args = parseArgs(process.argv);

if (cmd === "init") {
  const b64 = pubKeyB64();
  console.log("# Local-dev auth: add these to .env.local (gitignored, overrides .env) and restart the agent.");
  console.log("# NEVER set these in staging/prod — the dev key would let self-minted tokens authenticate.");
  console.log(`JWT_PUBLIC_KEY_B64=${b64}`);
  console.log("LOCAL_DEV_MODE=1");
  console.log("PAPER_TRADING_ENABLED=true");
  console.log("\n# Then mint a token:  node scripts/dev-auth.mjs token --email you@example.com");
} else if (cmd === "pubkey") {
  console.log(pubKeyB64());
} else if (cmd === "token") {
  ensureKeypair();
  const emailArg = args.get("email");
  const email = (typeof emailArg === "string" && emailArg) || process.env.VITE_TEST_USER_EMAIL || "dev@example.com";
  const ttlHours = Number(args.get("ttl-hours")) || 24;
  const token = mintTestJwt(email, { privateKeyPem: readFileSync(PRIV, "utf8"), ttlSec: ttlHours * 3600 });
  if (!token) {
    console.error("[dev-auth] failed to mint token");
    process.exit(1);
  }
  console.log(`# Dev access token for ${email} (RS256, ttl ${ttlHours}h):`);
  console.log(token);
  const userInfoCookie = encodeURIComponent(JSON.stringify({ email }));
  console.log("\n# Browser: paste in the app devtools console (same host as the SPA), reloads authenticated.");
  console.log("# Sets BOTH cookies — the SPA's checkAuthStatus gates its signed-in state on `user_info`,");
  console.log("# so an `access_token`-only snippet authenticates the backend but leaves the UI signed-out.");
  console.log(`document.cookie = "access_token=${token}; path=/"; document.cookie = "user_info=${userInfoCookie}; path=/"; location.reload();`);
  console.log("\n# API / curl:");
  console.log(`curl -H "Authorization: Bearer ${token}" http://localhost:3001/authentication/me/`);
} else if (cmd === "seed-trading") {
  // Enable trading + a dummy default exchange on the user's account so the CEX approval
  // gate fires locally. Fills still go through the paper venue (PAPER_TRADING_ENABLED=true),
  // so the dummy creds never touch a real exchange. Needs MONGODB_* from .env.
  const emailArg = args.get("email");
  const email = (typeof emailArg === "string" && emailArg) || process.env.VITE_TEST_USER_EMAIL || "dev@example.com";
  const venue = (typeof args.get("venue") === "string" && args.get("venue")) || "binance";
  const uri = process.env.MONGODB_CONNECTION_STRING || process.env.DOCUMENTDB_CONNECTION_STRING;
  const dbName = process.env.MONGODB_DATABASE || process.env.DOCUMENTDB_DATABASE;
  if (!uri || !dbName) {
    console.error("[dev-auth] seed-trading needs MONGODB_CONNECTION_STRING + MONGODB_DATABASE (run via `pnpm dev:auth`, which loads .env).");
    process.exit(1);
  }
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const accounts = client.db(dbName).collection("accounts");
    const acct = await accounts.findOne({ email });
    if (!acct) {
      console.error(`[dev-auth] no account for ${email}. Sign in once in the app (use a dev:auth token) to create it, then re-run.`);
      process.exit(1);
    }
    await accounts.updateOne(
      { email },
      {
        $set: {
          "details.enableTrading": true,
          [`details.exchangeAuths.${venue}.api_key_name_secret`]: {
            apiKeyName: "dev-paper-key",
            apiKeySecret: "dev-paper-secret",
            updatedAt: Date.now(),
          },
          "details.defaultExchangeAuth": { exchangeId: venue, authType: "api_key_name_secret" },
        },
      },
    );
    // Set the user's trading MODE to paper. This is what actually routes create_order to the
    // built-in paper venue ($10k ledger): resolveTradingMode reads user_trading_preferences
    // .default_mode (DB-first, keyed by account.id) and otherwise defaults to "live" — in which
    // case the dummy creds above hit the REAL exchange and fail ("API-key format invalid").
    // PAPER_TRADING_ENABLED does NOT drive order dispatch; the per-user default_mode does.
    await client.db(dbName).collection("user_trading_preferences").updateOne(
      { userId: acct.id },
      { $set: { userId: acct.id, default_mode: "paper", updatedAt: Date.now() } },
      { upsert: true },
    );
    console.log(`[dev-auth] paper trading enabled for ${email} (default exchange: ${venue}, dummy creds; trading mode=paper → fills use the built-in paper venue, never a real exchange). The CEX approval gate will now fire and orders will execute on the paper ledger.`);
  } finally {
    await client.close();
  }
} else {
  console.log(
    "Usage: node scripts/dev-auth.mjs <init|token|pubkey|seed-trading> [--email E] [--ttl-hours N] [--venue binance|coinbase]\n" +
      "  LOCAL DEV ONLY — minted tokens do not verify in staging/prod.",
  );
  process.exit(cmd ? 1 : 0);
}
