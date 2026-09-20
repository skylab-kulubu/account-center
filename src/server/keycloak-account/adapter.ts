import "server-only";

import {
  KeycloakAccountContractError,
  parseAuthenticationSummary,
  parseDeviceHints,
  parseProfile,
  parseSessions,
} from "@/server/keycloak-account/schema";
import type {
  AccountProfile,
  AccountSession,
  AuthenticationSummary,
  KeycloakAccountReadAdapter,
} from "@/server/keycloak-account/types";

const MAX_ACCOUNT_RESPONSE_BYTES = 512 * 1_024;

export class KeycloakAccountUnauthorizedError extends Error {
  constructor() {
    super("Keycloak rejected the user Account REST token.");
    this.name = "KeycloakAccountUnauthorizedError";
  }
}

export class KeycloakAccountForbiddenError extends Error {
  constructor() {
    super("Keycloak denied the required user Account REST role contract.");
    this.name = "KeycloakAccountForbiddenError";
  }
}

export class KeycloakAccountUnavailableError extends Error {
  constructor() {
    super("Keycloak Account REST is unavailable.");
    this.name = "KeycloakAccountUnavailableError";
  }
}

type AccountResource = "profile" | "credentials" | "sessions" | "devices";

async function readBoundedJson(response: Response, resource: AccountResource) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !response.body) {
    throw new KeycloakAccountContractError(resource);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_ACCOUNT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new KeycloakAccountContractError(resource);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof KeycloakAccountContractError) throw error;
    throw new KeycloakAccountUnavailableError();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new KeycloakAccountContractError(resource);
  }
}

export class Keycloak26AccountReadAdapter implements KeycloakAccountReadAdapter {
  readonly #baseUrl: URL;

  constructor(
    issuer: URL,
    private readonly request: typeof fetch = fetch,
  ) {
    this.#baseUrl = new URL(`${issuer.pathname.replace(/\/$/, "")}/account/`, issuer.origin);
    if (!this.#baseUrl.pathname.startsWith(`${issuer.pathname.replace(/\/$/, "")}/account/`)) {
      throw new Error("Invalid Keycloak Account REST base URL.");
    }
  }

  async #read(
    resource: AccountResource,
    path: "" | "credentials" | "sessions" | "sessions/devices",
    accessToken: string,
    optional = false,
  ) {
    const url = new URL(path, this.#baseUrl);
    if (resource === "profile") url.searchParams.set("userProfileMetadata", "false");
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new KeycloakAccountUnavailableError();
    }
    if (optional && response.status === 404) return null;
    if (response.status === 401) {
      throw new KeycloakAccountUnauthorizedError();
    }
    if (response.status === 403) throw new KeycloakAccountForbiddenError();
    if (!response.ok) throw new KeycloakAccountUnavailableError();
    return readBoundedJson(response, resource);
  }

  async #delete(path: "sessions" | `sessions/${string}`, accessToken: string) {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.#baseUrl), {
        method: "DELETE",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new KeycloakAccountUnavailableError();
    }
    if (response.status === 401) throw new KeycloakAccountUnauthorizedError();
    if (response.status === 403) throw new KeycloakAccountForbiddenError();
    if (response.status !== 204) throw new KeycloakAccountUnavailableError();
  }

  async profile(accessToken: string): Promise<AccountProfile> {
    return parseProfile(await this.#read("profile", "", accessToken));
  }

  async authentication(accessToken: string): Promise<AuthenticationSummary> {
    return parseAuthenticationSummary(await this.#read("credentials", "credentials", accessToken));
  }

  async sessions(accessToken: string): Promise<AccountSession[]> {
    const [sessions, devices] = await Promise.all([
      this.#read("sessions", "sessions", accessToken),
      this.#read("devices", "sessions/devices", accessToken, true),
    ]);
    return parseSessions(sessions, devices === null ? undefined : parseDeviceHints(devices));
  }

  async snapshot(accessToken: string) {
    const [profile, authentication, sessions] = await Promise.all([
      this.profile(accessToken),
      this.authentication(accessToken),
      this.sessions(accessToken),
    ]);
    return { profile, authentication, sessions };
  }

  revokeSession(accessToken: string, sessionId: string) {
    return this.#delete(`sessions/${encodeURIComponent(sessionId)}`, accessToken);
  }

  revokeOtherSessions(accessToken: string) {
    return this.#delete("sessions", accessToken);
  }
}
