import { describe, expect, it } from "vitest";
import { size, slice } from "viem";
import {
    appendPermit2Signature,
    eip712ForViem,
    PERMIT2_ADDRESS,
} from "../src/clients/permit2.ts";

describe("appendPermit2Signature (0x v2 calldata trailer)", () => {
    it("appends data || uint256(len(sig)) || sig for a 65-byte signature", () => {
        const data = "0x1234" as `0x${string}`;
        const sig = ("0x" + "ab".repeat(65)) as `0x${string}`; // 65-byte ECDSA sig
        const out = appendPermit2Signature(data, sig);

        // 2 (data) + 32 (length word) + 65 (signature) bytes
        expect(size(out)).toBe(2 + 32 + 65);
        expect(slice(out, 0, 2)).toBe(data);
        expect(BigInt(slice(out, 2, 34))).toBe(65n); // big-endian uint256 length
        expect(slice(out, 34)).toBe(sig);
    });

    it("encodes a 64-byte (compact) signature length correctly", () => {
        const sig = ("0x" + "cd".repeat(64)) as `0x${string}`;
        const out = appendPermit2Signature("0xdead", sig);
        expect(BigInt(slice(out, 2, 34))).toBe(64n);
        expect(slice(out, 34)).toBe(sig);
    });

    it("Permit2 address is the canonical cross-chain deployment", () => {
        expect(PERMIT2_ADDRESS.toLowerCase()).toBe(
            "0x000000000022d473030f116ddee9f6b43ac78ba3",
        );
    });
});

describe("eip712ForViem", () => {
    it("strips EIP712Domain from types and reshapes for viem.signTypedData", () => {
        const eip712 = {
            types: {
                EIP712Domain: [{ name: "name", type: "string" }],
                PermitTransferFrom: [{ name: "amount", type: "uint256" }],
            },
            domain: { name: "Permit2", chainId: 5000 },
            message: { amount: "5000000" },
            primaryType: "PermitTransferFrom",
        };
        const out = eip712ForViem(eip712);
        expect(out.types).not.toHaveProperty("EIP712Domain");
        expect(out.types).toHaveProperty("PermitTransferFrom");
        expect(out.domain).toEqual(eip712.domain);
        expect(out.primaryType).toBe("PermitTransferFrom");
        expect(out.message).toEqual(eip712.message);
    });
});
