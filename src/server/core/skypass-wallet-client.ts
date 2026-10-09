import "server-only";

/**
 * SkyPass Google Wallet client for core `GET /v1/skypass/wallet`,
 * `POST /v1/skypass/wallet/google` and `DELETE /v1/skypass/wallet/google`
 * (core `docs/skypass-google-wallet.md`), called with the person's own
 * Account Center user token. Transport rules follow `profile-client.ts`:
 * canonical HTTPS origin, bounded timeouts and bodies, no retries, no
 * redirects, status-only errors and no upstream body in errors or logs.
 *
 * The save link core answers has no expiry and whoever saves it first owns
 * the pass, so it never appears in an error, a log line or a thrown
 * message: a link that is not exactly Google's save URL is a contract
 * failure without the value.
 */

import { isGoogleWalletSaveUrl } from "@/lib/skypass-wallet";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const STATUS_TIMEOUT_MS = 5_000;
/** Core gives its Google calls one 20-second deadline per link or revoke; the BFF waits a little longer. */
const WRITE_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export type CoreSkyPassWalletStatus = {
  google: {
    /** False while Google Wallet is off in core: the button is hidden. */
    available: boolean;
    /** The person has a pass that opens the door; it does not say whether a phone saved it. */
    issued: boolean;
  };
};

export interface CoreSkyPassWalletClient {
  status(accessToken: string): Promise<CoreSkyPassWalletStatus>;
  /** Writes the person's pass to Google and answers its save link. */
  googleSaveUrl(accessToken: string): Promise<string>;
  /** Ends the person's pass; `204` also when there was none. */
  revokeGoogle(accessToken: string): Promise<void>;
}

export type CoreSkyPassWalletFailure =
  /** Core did not accept the bearer. */
  | "unauthorized"
  | "forbidden"
  /** The person is not active (deletion pending or erased), or core has no such route. */
  | "not_found"
  /** The pass was ended (a revoke, or the account's deletion) while the link was written. */
  | "ended"
  /** More than 10 link or revoke calls in a minute. */
  | "rate_limited"
  /** Google did not take the write or did not answer in time. */
  | "google_unavailable"
  /** Google Wallet is off in core. */
  | "off"
  /** Core did not answer, or answered a 5xx of its own. */
  | "unavailable"
  /** Any other 4xx. */
  | "rejected"
  /** A 2xx whose body is not the documented one. */
  | "contract"
  | "invalid_input";

export class CoreSkyPassWalletError extends Error {
  static {
    brandCrossBundleError(this, "CoreSkyPassWalletError");
  }

  constructor(
    readonly failure: CoreSkyPassWalletFailure,
    /** Whole seconds to wait, for `rate_limited` and `google_unavailable`, when core said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Core SkyPass Wallet request failed: ${failure}.`);
    this.name = "CoreSkyPassWalletError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreSkyPassWalletError("invalid_input");
  return `Bearer ${accessToken}`;
}

function retryAfter(value: unknown): number | null {
  const seconds = typeof value === "string" && /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function readBoundedJson(response: Response, accepted: readonly string[]): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!contentType || !accepted.includes(contentType) || (declaredLength > 0 && declaredLength > MAX_RESPONSE_BYTES)) {
    return undefined;
  }
  try {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** Maps a non-2xx answer by status and core's `code`; the problem body is read for those two members only. */
async function failureOf(response: Response): Promise<CoreSkyPassWalletError> {
  const { status } = response;
  if (status === 401) return new CoreSkyPassWalletError("unauthorized");
  if (status === 403) return new CoreSkyPassWalletError("forbidden");
  if (status === 404) return new CoreSkyPassWalletError("not_found");
  if (status === 409) return new CoreSkyPassWalletError("ended");
  const body = await readBoundedJson(response, ["application/problem+json", "application/json"]);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
  if (status === 429) {
    const seconds = retryAfter(isRecord(body) ? body.retryAfterSeconds : undefined) ??
      retryAfter(response.headers.get("retry-after"));
    return new CoreSkyPassWalletError("rate_limited", seconds);
  }
  if (status === 503 && code === "skypass_google_wallet_off") return new CoreSkyPassWalletError("off");
  if (status === 502 && code === "skypass_google_wallet_unavailable") {
    return new CoreSkyPassWalletError("google_unavailable", retryAfter(response.headers.get("retry-after")));
  }
  if (status >= 400 && status < 500) return new CoreSkyPassWalletError("rejected");
  return new CoreSkyPassWalletError("unavailable");
}

function parseStatus(value: unknown): CoreSkyPassWalletStatus {
  if (
    !isRecord(value) ||
    !isRecord(value.google) ||
    typeof value.google.available !== "boolean" ||
    typeof value.google.issued !== "boolean"
  ) {
    throw new CoreSkyPassWalletError("contract");
  }
  return { google: { available: value.google.available, issued: value.google.issued } };
}

function parseSaveUrl(value: unknown): string {
  if (!isRecord(value) || !isGoogleWalletSaveUrl(value.saveUrl)) throw new CoreSkyPassWalletError("contract");
  return value.saveUrl;
}

export class CoreSkyPassWalletHttpClient implements CoreSkyPassWalletClient {
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

  async #request(
    path: "/v1/skypass/wallet" | "/v1/skypass/wallet/google",
    method: "GET" | "POST" | "DELETE",
    accessToken: string,
    accepted: number,
    timeoutMs: number,
  ) {
    const authorization = requireBearer(accessToken);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        body: null,
        headers: { accept: "application/json", authorization },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CoreSkyPassWalletError("unavailable");
    }
    if (response.status === accepted) return response;
    if (response.status >= 200 && response.status < 300) throw new CoreSkyPassWalletError("contract");
    throw await failureOf(response);
  }

  async status(accessToken: string) {
    const response = await this.#request("/v1/skypass/wallet", "GET", accessToken, 200, STATUS_TIMEOUT_MS);
    return parseStatus(await readBoundedJson(response, ["application/json"]));
  }

  async googleSaveUrl(accessToken: string) {
    const response = await this.#request("/v1/skypass/wallet/google", "POST", accessToken, 200, WRITE_TIMEOUT_MS);
    return parseSaveUrl(await readBoundedJson(response, ["application/json"]));
  }

  async revokeGoogle(accessToken: string) {
    await this.#request("/v1/skypass/wallet/google", "DELETE", accessToken, 204, WRITE_TIMEOUT_MS);
  }
}
