import { describe, expect, it } from "vitest";
import {
    ipv6To64Prefix,
    stableIpIdentityKey,
    ipToUserId,
} from "../src/ipUtils.ts";

describe("ipv6To64Prefix", () => {
    it("keeps the first 4 hextets of a full IPv6 address", () => {
        expect(ipv6To64Prefix("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe(
            "2001:db8:85a3:8d3",
        );
    });

    it("lowercases and strips leading zeros per hextet", () => {
        expect(ipv6To64Prefix("2001:0DB8:85A3:08D3::1")).toBe("2001:db8:85a3:8d3");
    });

    it("expands :: when computing the /64 prefix", () => {
        expect(ipv6To64Prefix("2001:db8::1")).toBe("2001:db8:0:0");
    });
});

describe("stableIpIdentityKey", () => {
    it("leaves IPv4 addresses unchanged", () => {
        expect(stableIpIdentityKey("203.0.113.5")).toBe("203.0.113.5");
    });

    it("maps localhost variants to 127.0.0.1", () => {
        expect(stableIpIdentityKey("::1")).toBe("127.0.0.1");
        expect(stableIpIdentityKey("localhost")).toBe("127.0.0.1");
    });

    it("collapses IPv4-mapped IPv6 to the IPv4 address", () => {
        expect(stableIpIdentityKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    });

    it("collapses a full IPv6 address to its /64 key", () => {
        expect(
            stableIpIdentityKey("2001:db8:85a3:8d3:1319:8a2e:370:7348"),
        ).toBe("2001:db8:85a3:8d3");
    });
});

describe("ipToUserId stability across rotating IPv6 addresses", () => {
    it("two temporary addresses in the same /64 resolve to the same user", () => {
        const a = ipToUserId("2001:db8:85a3:8d3:1319:8a2e:370:7348");
        const b = ipToUserId("2001:db8:85a3:8d3:aaaa:bbbb:cccc:dddd");
        expect(a).toBe(b);
    });

    it("a compressed address in the same /64 resolves to the same user", () => {
        const full = ipToUserId("2001:db8:85a3:8d3:1319:8a2e:370:7348");
        const compressed = ipToUserId("2001:db8:85a3:8d3::1");
        expect(compressed).toBe(full);
    });

    it("a different /64 resolves to a different user", () => {
        const a = ipToUserId("2001:db8:85a3:8d3::1");
        const b = ipToUserId("2001:db8:85a3:9999::1");
        expect(a).not.toBe(b);
    });

    it("IPv4 addresses remain per-address (full address keyed)", () => {
        expect(ipToUserId("203.0.113.5")).not.toBe(ipToUserId("203.0.113.6"));
    });

    it("IPv4-mapped IPv6 matches the bare IPv4 user", () => {
        expect(ipToUserId("::ffff:203.0.113.5")).toBe(ipToUserId("203.0.113.5"));
    });
});
