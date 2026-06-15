import { createHash } from "node:crypto";
import type { CanonicalIntent } from "../../intent/canonicalIntent";
import { computeIntentHash, deriveClientOrderId } from "../../idempotency/intentHash";

/**
 * Derive a per-tranche paper client_order_id. We salt the deterministic intent
 * hash with `salt` (use `${instance_id}:${tick_count}`): identical retries of
 * the SAME tick produce the SAME id (dedupe), while distinct DCA tranches
 * (different tick_count) produce DIFFERENT ids and so all fire.
 */
export function deriveTrancheClientOrderId(intent: CanonicalIntent, salt: string): string {
  const base = computeIntentHash(intent);
  const salted = createHash("sha256").update(`${base}:${salt}`).digest("hex");
  return deriveClientOrderId(salted, "paper");
}
