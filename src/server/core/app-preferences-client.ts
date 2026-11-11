import "server-only";

import { isAppPreferenceApp, parseAppPreferenceSummaries } from "@/lib/app-preferences";
import type { AppPreferenceSummary } from "@/lib/app-preferences";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Client for core's Account Center routes of the App preferences (core
 * `docs/app-preferences.md`): `GET /v1/users/me/app-preferences` (the
 * summary, never a value) and `DELETE /v1/users/me/app-preferences/{app}`
 * (reset). Called with the person's own Account Center user token; core
 * picks the `account` namespace from the token's `azp`. Transport rules
 * follow `communication-preferences-client.ts`.
 */

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const PATH = "/v1/users/me/app-preferences";

export type CoreAppPreferencesFailure =
  /** Core did not accept the bearer. */
  | "unauthorized"
  /** A service account's token, or a client core does not map to Account Center. */
  | "forbidden"
  /** The person is being erased or is erased (`app_preference_subject_inactive`). */
  | "subject_inactive"
  /** 404: `APP_PREFERENCE_CLIENTS` is empty (the feature is off) or the app is not in it. */
  | "off"
  /** More than 60 writes a minute (`app_preference_rate_limited`). */
  | "rate_limited"
  /** Any other refusal of the request. */
  | "rejected"
  /** Core did not answer, or answered a 5xx of its own. */
  | "unavailable"
  /** A 2xx whose body is not the documented one. */
  | "contract"
  | "invalid_input";

export class CoreAppPreferencesError extends Error {
  static {
    brandCrossBundleError(this, "CoreAppPreferencesError");
  }

  constructor(readonly failure: CoreAppPreferencesFailure) {
    super(`Core app preferences request failed: ${failure}.`);
    this.name = "CoreAppPreferencesError";
  }
}

export interface CoreAppPreferencesClient {
  summary(accessToken: string): Promise<AppPreferenceSummary[]>;
  reset(accessToken: string, app: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreAppPreferencesError("invalid_input");
  return `Bearer ${accessToken}`;
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
async function failureOf(response: Response): Promise<CoreAppPreferencesError> {
  const { status } = response;
  if (status === 401) return new CoreAppPreferencesError("unauthorized");
  if (status === 404) return new CoreAppPreferencesError("off");
  if (status === 429) return new CoreAppPreferencesError("rate_limited");
  const body = await readBoundedJson(response, ["application/problem+json", "application/json"], 16 * 1_024);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
  if (status === 403) {
    return new CoreAppPreferencesError(code === "app_preference_subject_inactive" ? "subject_inactive" : "forbidden");
  }
  if (status >= 400 && status < 500) return new CoreAppPreferencesError("rejected");
  return new CoreAppPreferencesError("unavailable");
}

export class CoreAppPreferencesHttpClient implements CoreAppPreferencesClient {
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

  async #request(method: "GET" | "DELETE", path: string, accessToken: string) {
    const authorization = requireBearer(accessToken);
    try {
      return await fetch(new URL(path, this.baseUrl), {
        method,
        body: null,
        headers: { accept: "application/json", authorization },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreAppPreferencesError("unavailable");
    }
  }

  async summary(accessToken: string) {
    const response = await this.#request("GET", PATH, accessToken);
    if (response.status !== 200) {
      if (response.status >= 200 && response.status < 300) throw new CoreAppPreferencesError("contract");
      throw await failureOf(response);
    }
    const items = parseAppPreferenceSummaries(await readBoundedJson(response, ["application/json"]));
    if (!items) throw new CoreAppPreferencesError("contract");
    return items;
  }

  async reset(accessToken: string, app: string) {
    if (!isAppPreferenceApp(app)) throw new CoreAppPreferencesError("invalid_input");
    const response = await this.#request("DELETE", `${PATH}/${app}`, accessToken);
    if (response.status === 204 || response.status === 200) return;
    if (response.status >= 200 && response.status < 300) throw new CoreAppPreferencesError("contract");
    throw await failureOf(response);
  }
}
