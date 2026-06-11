import { canonicalSpotProductId } from "../canonicalSpotProductId";

/** Coinbase Advanced Trade `product_id` (hyphenated BASE-QUOTE). */
export function productIdToCoinbaseProductId(productId: string): string {
    return canonicalSpotProductId(productId);
}

/** Normalize optional product id filters for GET endpoints. */
export function mapProductIdsForCoinbaseApi(ids: string[] | undefined): string[] | undefined {
    if (!ids?.length) return ids;
    return ids.map((id) => productIdToCoinbaseProductId(id));
}
