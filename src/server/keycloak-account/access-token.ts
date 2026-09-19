import "server-only";

import { decodeJwt, decodeProtectedHeader } from "jose";

export class AccountAccessTokenContractError extends Error {
  constructor() {
    super("The server-held Account REST token does not match the pinned user-token contract.");
    this.name = "AccountAccessTokenContractError";
  }
}

export class AccountAccessTokenExpiredError extends Error {
  constructor() {
    super("The server-held Account REST token has expired.");
    this.name = "AccountAccessTokenExpiredError";
  }
}

export function validateAccountAccessToken(
  accessToken: string,
  expected: { issuer: URL; clientId: string; subject: string },
  now = new Date(),
) {
  let claims;
  let header;
  try {
    claims = decodeJwt(accessToken);
    header = decodeProtectedHeader(accessToken);
  } catch {
    throw new AccountAccessTokenContractError();
  }
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    header.alg !== "RS256" ||
    header.typ !== "JWT" ||
    claims.iss !== expected.issuer.href.replace(/\/$/, "") ||
    claims.sub !== expected.subject ||
    claims.azp !== expected.clientId ||
    claims.scope !== "openid" ||
    !Array.isArray(audience) ||
    audience.length !== 1 ||
    audience[0] !== "account" ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.exp)
  ) {
    throw new AccountAccessTokenContractError();
  }
  const expiresAt = new Date(claims.exp * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) throw new AccountAccessTokenContractError();
  if (claims.exp <= Math.floor(now.getTime() / 1_000)) {
    throw new AccountAccessTokenExpiredError();
  }
  return { expiresAt };
}
