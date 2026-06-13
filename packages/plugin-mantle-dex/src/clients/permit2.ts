import { concat, numberToHex, size, type Hex } from "viem";

/** Canonical Permit2 contract (same address on every EVM chain incl. Mantle). */
export const PERMIT2_ADDRESS =
    "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/**
 * 0x v2 settler convention for permit2 swaps: the EIP-712 signature is appended
 * to the swap calldata as
 *
 *     data || uint256(len(signature)) || signature
 *
 * The settler reads the trailing 32-byte big-endian length and then that many
 * signature bytes. Sending `transaction.data` WITHOUT this trailer reverts on
 * an ERC-20 (permit2) sell, so this encoding is on the real-money path and is
 * unit-tested directly.
 */
export function appendPermit2Signature(data: Hex, signature: Hex): Hex {
    const signatureLength = numberToHex(size(signature), { size: 32 });
    return concat([data, signatureLength, signature]);
}

/** The EIP-712 typed-data object 0x returns under `quote.permit2.eip712`. */
export interface ZeroExEip712 {
    types: Record<string, unknown>;
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
    primaryType: string;
}

/**
 * viem's `signTypedData` derives the domain separator itself and rejects an
 * explicit `EIP712Domain` entry in `types` (which 0x always includes). Strip it
 * and reshape to viem's argument order.
 */
export function eip712ForViem(eip712: ZeroExEip712): {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
} {
    const { EIP712Domain: _omitted, ...types } = eip712.types as Record<
        string,
        unknown
    >;
    return {
        domain: eip712.domain,
        types,
        primaryType: eip712.primaryType,
        message: eip712.message,
    };
}
