import "server-only";

/**
 * Wire shapes shared by the token, Account REST, sky-account and sudo
 * contracts so that every parser applies the same bounds.
 */

/** A compact JWS (`header.payload.signature`, base64url segments) with generous but finite bounds. */
export const COMPACT_JWS = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,2048}$/;

/** Object keys that must never be accepted from upstream JSON maps. */
export const reservedObjectKeys: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedObjectKey(key: string) {
  return reservedObjectKeys.has(key);
}
