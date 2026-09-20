import "server-only";

import { createHash } from "node:crypto";

export const ACCOUNT_ACCESS_ISSUER = "https://e.yildizskylab.com/realms/e-skylab";
export const ACCOUNT_ACCESS_CONTRACT_KEY = "skylab:account-access:v1:contract";
export const ACCOUNT_ACCESS_CONTRACT_VALUE = "sha256(iss\\0sub);marker=1;ttl=none";
export const ACCOUNT_ACCESS_MARKER_PREFIX = "skylab:account-access:v1:blocked:";
export const ACCOUNT_ACCESS_MARKER_VALUE = "1";

export function accountAccessSubjectDigest(issuer: string, subject: string) {
  return createHash("sha256").update(`${issuer}\0${subject}`, "utf8").digest("hex");
}

export function accountAccessMarkerKey(issuer: string, subject: string) {
  return `${ACCOUNT_ACCESS_MARKER_PREFIX}${accountAccessSubjectDigest(issuer, subject)}`;
}
