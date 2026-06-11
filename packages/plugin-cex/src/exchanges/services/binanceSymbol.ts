import { canonicalSpotProductId } from "../canonicalSpotProductId";

/** Map messy or hyphenated product ids to Binance Spot `symbol` (e.g. BTCUSDT). */
export function productIdToBinanceSymbol(productId: string): string {
    return canonicalSpotProductId(productId).replace(/-/g, "").replace(/\s+/g, "");
}
