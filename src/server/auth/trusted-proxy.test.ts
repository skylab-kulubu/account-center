import { describe, expect, it } from "vitest";
import {
  AUTH_TRUSTED_PROXY_MODES,
  DEFAULT_TRUSTED_PROXY_RANGES,
  TRUSTED_PROXY_RANGE_DEFAULTS,
  canonicalIp,
  isTrustedProxyAddress,
  parseTrustedProxyRanges,
} from "@/server/auth/trusted-proxy";

describe("trusted proxy addresses", () => {
  it("gives every spelling of one host a single canonical form", () => {
    expect(canonicalIp("203.0.113.42")).toBe("203.0.113.42");
    expect(canonicalIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(canonicalIp("::FFFF:192.0.2.1")).toBe("::ffff:c000:201");
    expect(canonicalIp("0:0:0:0:0:0:0:1")).toBe("::1");
  });

  it("refuses everything that is not a bare address", () => {
    for (const value of [
      "",
      " 203.0.113.42",
      "203.0.113.42 ",
      "203.0.113.42:8080",
      "[2001:db8::1]:8080",
      "203.0.113.42, 198.51.100.7",
      "fe80::1%eth0",
      "010.1.1.1",
      "unknown",
      "_hidden",
      "example.com",
      "2001:db8::1".padEnd(65, "0"),
    ]) {
      expect(canonicalIp(value)).toBeNull();
    }
  });

  it("parses only canonical CIDR blocks", () => {
    expect(parseTrustedProxyRanges("10.0.0.0/8")).toEqual([
      { bytes: Uint8Array.of(10, 0, 0, 0), prefixLength: 8 },
    ]);
    expect(parseTrustedProxyRanges(" 127.0.0.0/8 , ::1/128 ")).toHaveLength(2);
    for (const value of [
      "",
      ",",
      "10.0.0.0",
      "10.0.0.0/",
      "10.0.0.0/8/8",
      "10.0.0.0/33",
      "::1/129",
      "10.0.0.1/8",
      "2001:db8::1/32",
      "fe80::1%eth0/64",
      "10.0.0.0/08",
      "not-an-address/8",
    ]) {
      expect(parseTrustedProxyRanges(value)).toBeNull();
    }
  });

  it("matches an address only inside a block of its own family", () => {
    const ranges = parseTrustedProxyRanges("10.0.0.0/8,172.16.0.0/12,fc00::/7,2001:db8::/32") ?? [];
    expect(ranges).toHaveLength(4);
    for (const inside of ["10.0.1.109", "10.255.255.255", "172.16.0.1", "172.31.255.254", "fd00::1", "2001:db8::1"]) {
      expect(isTrustedProxyAddress(inside, ranges)).toBe(true);
    }
    for (const outside of ["11.0.0.1", "9.255.255.255", "172.15.255.255", "172.32.0.1", "2001:db9::1", "fe00::1", "not-an-address"]) {
      expect(isTrustedProxyAddress(outside, ranges)).toBe(false);
    }
    expect(isTrustedProxyAddress("10.0.1.109", [])).toBe(false);
  });

  it("treats an IPv4-mapped peer as the IPv4 address it carries", () => {
    const ranges = parseTrustedProxyRanges("10.0.0.0/8") ?? [];
    expect(isTrustedProxyAddress("::ffff:c000:201", ranges)).toBe(false);
    expect(isTrustedProxyAddress("::ffff:a00:16d", ranges)).toBe(true);
  });

  it("keeps the documented private default reachable as a parsed set", () => {
    expect(DEFAULT_TRUSTED_PROXY_RANGES).toBe(
      "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7",
    );
    expect(TRUSTED_PROXY_RANGE_DEFAULTS).toHaveLength(6);
    for (const address of ["10.0.1.109", "172.20.0.3", "192.168.1.1", "127.0.0.1", "::1", "fd12::1"]) {
      expect(isTrustedProxyAddress(address, TRUSTED_PROXY_RANGE_DEFAULTS)).toBe(true);
    }
    expect(isTrustedProxyAddress("203.0.113.42", TRUSTED_PROXY_RANGE_DEFAULTS)).toBe(false);
    expect(isTrustedProxyAddress("2001:db8::1", TRUSTED_PROXY_RANGE_DEFAULTS)).toBe(false);
  });

  it("names exactly the three supported edge topologies", () => {
    expect([...AUTH_TRUSTED_PROXY_MODES]).toEqual(["cloudflare", "traefik", "none"]);
  });
});
