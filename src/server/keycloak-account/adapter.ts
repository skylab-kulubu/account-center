import "server-only";

import {
  KeycloakAccountContractError,
  parseAuthenticationSummary,
  parseDeviceHints,
  parseGroups,
  parseProfile,
  parseSessions,
} from "@/server/keycloak-account/schema";
import type { KeycloakAccountResource } from "@/server/keycloak-account/schema";
import type {
  AccountGroup,
  AccountProfile,
  AccountSession,
  AuthenticationSummary,
  KeycloakAccountReadAdapter,
} from "@/server/keycloak-account/types";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

const MAX_ACCOUNT_RESPONSE_BYTES = 512 * 1_024;

export class KeycloakAccountUnauthorizedError extends Error {
  static {
    brandCrossBundleError(this, "KeycloakAccountUnauthorizedError");
  }

  constructor() {
    super("Keycloak rejected the user Account REST token.");
    this.name = "KeycloakAccountUnauthorizedError";
  }
}

export class KeycloakAccountForbiddenError extends Error {
  static {
    brandCrossBundleError(this, "KeycloakAccountForbiddenError");
  }

  constructor() {
    super("Keycloak denied the required user Account REST role contract.");
    this.name = "KeycloakAccountForbiddenError";
  }
}

export class KeycloakAccountUnavailableError extends Error {
  static {
    brandCrossBundleError(this, "KeycloakAccountUnavailableError");
  }

  constructor() {
    super("Keycloak Account REST is unavailable.");
    this.name = "KeycloakAccountUnavailableError";
  }
}

type AccountReadPath =
  | ""
  | "credentials"
  | "sessions"
  | "sessions/devices"
  | "groups";

async function readBoundedJson(response: Response, resource: KeycloakAccountResource) {
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

/**
 * Read-mostly adapter over the Keycloak user Account REST API. It never calls
 * `/admin/` and never issues `POST /account`: identity mutations (name,
 * username, e-mail, credentials) belong to the sky-account SPI client.
 */
export class Keycloak26AccountReadAdapter implements KeycloakAccountReadAdapter {
  readonly #baseUrl: URL;

  constructor(
    private readonly issuer: URL,
    private readonly request: typeof fetch = fetch,
  ) {
    this.#baseUrl = new URL(`${issuer.pathname.replace(/\/$/, "")}/account/`, issuer.origin);
    if (!this.#baseUrl.pathname.startsWith(`${issuer.pathname.replace(/\/$/, "")}/account/`)) {
      throw new Error("Invalid Keycloak Account REST base URL.");
    }
  }

  async #read(
    resource: KeycloakAccountResource,
    path: AccountReadPath,
    accessToken: string,
    options: { optional?: boolean; query?: Record<string, string> } = {},
  ) {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
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
    if (options.optional && response.status === 404) return null;
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
    return parseProfile(await this.#read("profile", "", accessToken, {
      query: { userProfileMetadata: "true" },
    }));
  }

  async authentication(accessToken: string): Promise<AuthenticationSummary> {
    return parseAuthenticationSummary(await this.#read("credentials", "credentials", accessToken));
  }

  async sessions(accessToken: string): Promise<AccountSession[]> {
    const [sessions, devices] = await Promise.all([
      this.#read("sessions", "sessions", accessToken),
      this.#read("devices", "sessions/devices", accessToken, { optional: true }),
    ]);
    return parseSessions(sessions, devices === null ? undefined : parseDeviceHints(devices));
  }

  async groups(accessToken: string): Promise<AccountGroup[]> {
    return parseGroups(await this.#read("groups", "groups", accessToken, {
      query: { briefRepresentation: "false" },
    }));
  }

  revokeSession(accessToken: string, sessionId: string) {
    return this.#delete(`sessions/${encodeURIComponent(sessionId)}`, accessToken);
  }

  revokeOtherSessions(accessToken: string) {
    return this.#delete("sessions", accessToken);
  }
}
