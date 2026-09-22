import "server-only";

import { isIP } from "node:net";

/**
 * The edge topologies this deployment knows how to read a client address from.
 *
 * - `cloudflare`: only the Cloudflare-written `CF-Connecting-IP` is believed.
 * - `traefik`: the reverse proxy in front rewrites `X-Forwarded-For`/`X-Real-IP`
 *   and discards whatever the visitor sent under those names.
 * - `none`: no proxy is believed; only a socket address the runtime exposes counts.
 */
export const AUTH_TRUSTED_PROXY_MODES = ["cloudflare", "traefik", "none"] as const;

export type AuthTrustedProxy = (typeof AUTH_TRUSTED_PROXY_MODES)[number];

/** A parsed CIDR block: the masked network bytes plus how many leading bits are significant. */
export type TrustedProxyRange = {
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
};

/**
 * Loopback and private ranges every hop between the reverse proxy and this
 * process lives in. The set is used for one purpose only: skipping proxy hops
 * while reading `X-Forwarded-For`. Widening it is a security decision, because
 * every peer inside it is allowed to present the client address and can
 * therefore put any visitor into any rate-limit bucket.
 */
export const DEFAULT_TRUSTED_PROXY_RANGES =
  "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7";

/**
 * One address, one bucket: the same host written in different notations has to
 * canonicalise to the same string, and anything that is not a bare address —
 * a port, a zone id, a host name, a list — is not an address at all.
 */
export function canonicalIp(value: string) {
  if (
    value.length > 64 ||
    value.includes(",") ||
    value.includes("%") ||
    value !== value.trim()
  ) {
    return null;
  }
  const version = isIP(value);
  if (version === 4) return value.split(".").map((part) => String(Number(part))).join(".");
  if (version !== 6) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function ipv4Bytes(value: string) {
  const bytes = new Uint8Array(4);
  value.split(".").forEach((part, index) => {
    bytes[index] = Number(part);
  });
  return bytes;
}

function ipv6Bytes(value: string) {
  let text = value;
  const embeddedIpv4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (embeddedIpv4?.[1]) {
    const quads = ipv4Bytes(embeddedIpv4[1]);
    const high = (((quads[0] ?? 0) << 8) | (quads[1] ?? 0)).toString(16);
    const low = (((quads[2] ?? 0) << 8) | (quads[3] ?? 0)).toString(16);
    text = `${text.slice(0, embeddedIpv4.index)}${high}:${low}`;
  }
  const [head = "", tail] = text.split("::");
  if (text.split("::").length > 2) return null;
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [
    ...headGroups,
    ...(tail === undefined ? [] : Array.from({ length: missing }, () => "0")),
    ...tailGroups,
  ];
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    const word = Number.parseInt(group, 16);
    if (!Number.isInteger(word) || word < 0 || word > 0xffff) return null;
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

/** The address in network byte order: 4 bytes for IPv4, 16 for IPv6, `null` when it is not an address. */
export function ipBytes(value: string) {
  if (value.includes("%")) return null;
  const version = isIP(value);
  if (version === 4) return ipv4Bytes(value);
  if (version === 6) return ipv6Bytes(value);
  return null;
}

function maskedByte(byte: number, significantBits: number) {
  if (significantBits <= 0) return 0;
  if (significantBits >= 8) return byte;
  return byte & ((0xff << (8 - significantBits)) & 0xff);
}

function isNetworkAddress(bytes: Uint8Array, prefixLength: number) {
  return bytes.every((byte, index) => byte === maskedByte(byte, prefixLength - index * 8));
}

/**
 * `::ffff:10.0.1.109` and `10.0.1.109` are the same peer, so a dual-stack hop
 * still matches the IPv4 block an operator configured for it.
 */
function ipv4Mapped(bytes: Uint8Array) {
  if (bytes.length !== 16) return null;
  if (bytes.subarray(0, 10).some((byte) => byte !== 0)) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.subarray(12);
}

function matchesRange(bytes: Uint8Array, range: TrustedProxyRange) {
  const candidate = bytes.length === range.bytes.length ? bytes : ipv4Mapped(bytes);
  if (!candidate || candidate.length !== range.bytes.length) return false;
  return range.bytes.every(
    (byte, index) =>
      maskedByte(candidate[index] ?? 0, range.prefixLength - index * 8) ===
      maskedByte(byte, range.prefixLength - index * 8),
  );
}

/**
 * Parses the comma-separated CIDR list an operator configured, or returns
 * `null` when any entry is not a canonical block. A block whose host bits are
 * set (`10.0.0.1/8`) is rejected rather than silently widened to its network,
 * so a typo cannot quietly hand a whole /8 the right to present client addresses.
 */
export function parseTrustedProxyRanges(value: string) {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const ranges: TrustedProxyRange[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf("/");
    if (separator < 0) return null;
    const bytes = ipBytes(entry.slice(0, separator));
    const prefix = entry.slice(separator + 1);
    if (!bytes || !/^(?:0|[1-9]\d{0,2})$/.test(prefix)) return null;
    const prefixLength = Number(prefix);
    if (prefixLength > bytes.length * 8 || !isNetworkAddress(bytes, prefixLength)) return null;
    ranges.push({ bytes, prefixLength });
  }
  return ranges;
}

const parsedDefaults = parseTrustedProxyRanges(DEFAULT_TRUSTED_PROXY_RANGES);
if (!parsedDefaults) {
  throw new Error("DEFAULT_TRUSTED_PROXY_RANGES must be a canonical CIDR list.");
}

/** `DEFAULT_TRUSTED_PROXY_RANGES`, parsed once, for every caller that took no configuration. */
export const TRUSTED_PROXY_RANGE_DEFAULTS: readonly TrustedProxyRange[] = parsedDefaults;

/** Whether the address is one of the hops allowed to hand us somebody else's address. */
export function isTrustedProxyAddress(address: string, ranges: readonly TrustedProxyRange[]) {
  const bytes = ipBytes(address);
  if (!bytes) return false;
  return ranges.some((range) => matchesRange(bytes, range));
}
