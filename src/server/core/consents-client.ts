import "server-only";

import { isPromotionalConsentSource } from "@/lib/promotional-consent";
import type { PromotionalConsentSource } from "@/lib/promotional-consent";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Client for core's own-consent routes (core `docs/contact-consents.md`,
 * "A signed-in person"): `GET /v1/users/me/consents`,
 * `POST /v1/users/me/consents` and `DELETE /v1/users/me/consents/{purpose}`,
 * called with the person's own Account Center user token. Transport rules
 * follow `communication-preferences-client.ts`: canonical HTTPS origin,
 * bounded timeouts and bodies, no retries, no redirects, status-and-code-only
 * errors and no upstream body in errors or logs.
 */

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const PURPOSE = /^[a-z][a-z_]{0,63}$/;
const TEXT_VERSION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_ITEMS = 1_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const PATH = "/v1/users/me/consents";

export type CoreConsentFailure =
  /** Core did not accept the bearer. */
  | "unauthorized"
  /** A service account's token, or another refusal of the caller. */
  | "forbidden"
  /** `CONTACT_CONSENT_KEY` is unset (`consents_unavailable`), or a core without these routes: nothing is recorded. */
  | "off"
  /** Keycloak did not answer core the person's addresses (`consent_addresses_unavailable`). */
  | "addresses_unavailable"
  /** Core refused the request (`consent_invalid`, `consent_text_unknown`, `purpose_not_enabled`…). */
  | "rejected"
  /** Core did not answer, or answered a 5xx of its own. */
  | "unavailable"
  /** A 2xx whose body is not the documented one. */
  | "contract"
  | "invalid_input";

export class CoreConsentError extends Error {
  static {
    brandCrossBundleError(this, "CoreConsentError");
  }

  constructor(
    readonly failure: CoreConsentFailure,
    /** Whole seconds to wait, for `addresses_unavailable`, when core said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Core consent request failed: ${failure}.`);
    this.name = "CoreConsentError";
  }
}

export const CONSENT_STATUSES = ["pending", "active", "withdrawn", "expired", "superseded"] as const;
export type CoreConsentStatus = (typeof CONSENT_STATUSES)[number];

/** One grant of the person's list, reduced to what Account Center reads. */
export type CoreConsentItem = { purpose: string; status: CoreConsentStatus };

export type CoreConsentGrant = { purpose: string; textVersion: string; source: PromotionalConsentSource };

export interface CoreConsentsClient {
  /** The account's grants and those given for any of the person's addresses, open or ended. */
  list(accessToken: string): Promise<CoreConsentItem[]>;
  /** Records the person's own grant; core answers it active at once. */
  grant(accessToken: string, grant: CoreConsentGrant): Promise<void>;
  /** Ends every open grant of the purpose that mails one of the person's addresses; the number ended. */
  withdraw(accessToken: string, purpose: string): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreConsentError("invalid_input");
  return `Bearer ${accessToken}`;
}

function requirePurpose(purpose: string) {
  if (!PURPOSE.test(purpose)) throw new CoreConsentError("invalid_input");
  return purpose;
}

function retryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds >= 1 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : null;
}

async function readBoundedJson(response: Response, accepted: readonly string[], maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!contentType || !accepted.includes(contentType) || (declaredLength > 0 && declaredLength > maxBytes)) {
    return undefined;
  }
  try {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Maps a non-2xx answer by status and core's `code`; the problem body is read for `code` only. */
async function failureOf(response: Response): Promise<CoreConsentError> {
  const { status } = response;
  if (status === 401) return new CoreConsentError("unauthorized");
  if (status === 403) return new CoreConsentError("forbidden");
  // A core before the consent record has no such route: the same as the key unset.
  if (status === 404) return new CoreConsentError("off");
  const body = await readBoundedJson(response, ["application/problem+json", "application/json"], 16 * 1_024);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
  if (status === 503 && code === "consents_unavailable") return new CoreConsentError("off");
  if (status === 503 && code === "consent_addresses_unavailable") {
    return new CoreConsentError("addresses_unavailable", retryAfter(response.headers.get("retry-after")));
  }
  if (status >= 400 && status < 500) return new CoreConsentError("rejected");
  return new CoreConsentError("unavailable");
}

/** Core's list, fail-closed: every item needs a known purpose shape and status; other members are ignored. */
export function parseConsentList(value: unknown): CoreConsentItem[] {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new CoreConsentError("contract");
  }
  return value.items.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.purpose !== "string" || !PURPOSE.test(item.purpose) ||
      !(CONSENT_STATUSES as readonly unknown[]).includes(item.status)
    ) {
      throw new CoreConsentError("contract");
    }
    return { purpose: item.purpose, status: item.status as CoreConsentStatus };
  });
}

export class CoreConsentsHttpClient implements CoreConsentsClient {
  constructor(private readonly baseUrl: URL) {
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("Core API URL must be a canonical credential-free HTTPS origin.");
    }
  }

  async #request(method: "GET" | "POST" | "DELETE", path: string, accessToken: string, body?: string) {
    const authorization = requireBearer(accessToken);
    const headers: Record<string, string> = { accept: "application/json", authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        body: body ?? null,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreConsentError("unavailable");
    }
    if (response.status === 200 || (method === "POST" && response.status === 201)) {
      return readBoundedJson(response, ["application/json"]);
    }
    if (response.status >= 200 && response.status < 300) throw new CoreConsentError("contract");
    throw await failureOf(response);
  }

  async list(accessToken: string) {
    return parseConsentList(await this.#request("GET", PATH, accessToken));
  }

  async grant(accessToken: string, { purpose, textVersion, source }: CoreConsentGrant) {
    if (!TEXT_VERSION.test(textVersion) || !isPromotionalConsentSource(source)) throw new CoreConsentError("invalid_input");
    const body = JSON.stringify({ purpose: requirePurpose(purpose), textVersion, source });
    const answer = await this.#request("POST", PATH, accessToken, body);
    // A signed-in person consenting for their own account is active at once.
    if (!isRecord(answer) || answer.status !== "active") throw new CoreConsentError("contract");
  }

  async withdraw(accessToken: string, purpose: string) {
    const answer = await this.#request("DELETE", `${PATH}/${requirePurpose(purpose)}`, accessToken);
    if (!isRecord(answer) || typeof answer.withdrawn !== "number" || !Number.isSafeInteger(answer.withdrawn) || answer.withdrawn < 0) {
      throw new CoreConsentError("contract");
    }
    return answer.withdrawn;
  }
}
