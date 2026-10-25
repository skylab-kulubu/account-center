import "server-only";

import {
  INBOX_PAGE_SIZE,
  isInboxCursor,
  isInboxItemAction,
  isInboxItemId,
  parseInboxCounts,
  parseInboxItem,
  parseInboxPage,
} from "@/lib/inbox";
import type { InboxCounts, InboxItem, InboxItemAction, InboxPage } from "@/lib/inbox";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Client for SkyMail's person endpoints (`/v1/me/inbox…`, skymail-backend
 * `docs/inbox.md`), called with the person's own Account Center user token:
 * SkyMail wants `aud ∋ skymail` (Keycloak, iletişim-servisi 04) and a
 * person's token, no role. Transport rules follow the core clients: an
 * HTTPS base, bounded timeouts and bodies, no retries, no redirects,
 * status-and-code-only errors and no upstream body in errors or logs.
 */

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REQUEST_TIMEOUT_MS = 5_000;
/** 100 items of at most 200 + 1000 + 2048 characters fit well inside this. */
const MAX_RESPONSE_BYTES = 512 * 1_024;

export type SkyMailInboxFailure =
  /** SkyMail did not accept the bearer (no `aud skymail`, expired). */
  | "unauthorized"
  /** A refusal of the caller (a service account's token, the account access gate). */
  | "forbidden"
  /** The item is not the person's, or gone. */
  | "not_found"
  /** SkyMail refused the request itself (a cursor it does not know). */
  | "rejected"
  /** SkyMail did not answer, or answered a 5xx of its own. */
  | "unavailable"
  /** A 2xx whose body is not the documented one. */
  | "contract"
  | "invalid_input";

export class SkyMailInboxError extends Error {
  static {
    brandCrossBundleError(this, "SkyMailInboxError");
  }

  constructor(readonly failure: SkyMailInboxFailure) {
    super(`SkyMail inbox request failed: ${failure}.`);
    this.name = "SkyMailInboxError";
  }
}

export interface SkyMailInboxClient {
  list(accessToken: string, cursor?: string): Promise<InboxPage>;
  counts(accessToken: string): Promise<InboxCounts>;
  mark(accessToken: string, id: string, action: InboxItemAction): Promise<InboxItem>;
  /** `read-all` marks every unarchived item read (and seen), `seen-all` seen. */
  markAll(accessToken: string, action: "read-all" | "seen-all"): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new SkyMailInboxError("invalid_input");
  return `Bearer ${accessToken}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || (declaredLength > 0 && declaredLength > MAX_RESPONSE_BYTES)) {
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

function failureOf(status: number): SkyMailInboxError {
  if (status === 401) return new SkyMailInboxError("unauthorized");
  if (status === 403) return new SkyMailInboxError("forbidden");
  if (status === 404) return new SkyMailInboxError("not_found");
  if (status >= 400 && status < 500) return new SkyMailInboxError("rejected");
  return new SkyMailInboxError("unavailable");
}

/** The base must be HTTPS without credentials, query or fragment; a path (`/api/skymail`) is kept. */
export function skyMailBaseUrl(value: URL): URL {
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash) {
    throw new Error("SkyMail API URL must be a credential-free HTTPS URL without query or fragment.");
  }
  const base = new URL(value.href);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  return base;
}

export class SkyMailInboxHttpClient implements SkyMailInboxClient {
  readonly #base: URL;

  constructor(baseUrl: URL) {
    this.#base = skyMailBaseUrl(baseUrl);
  }

  async #request(method: "GET" | "POST", path: string, accessToken: string): Promise<unknown> {
    const authorization = requireBearer(accessToken);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#base), {
        method,
        headers: { accept: "application/json", authorization },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SkyMailInboxError("unavailable");
    }
    if (response.status === 200) {
      const body = await readBoundedJson(response);
      if (body === undefined) throw new SkyMailInboxError("contract");
      return body;
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) throw new SkyMailInboxError("contract");
    throw failureOf(response.status);
  }

  async list(accessToken: string, cursor?: string) {
    if (cursor !== undefined && !isInboxCursor(cursor)) throw new SkyMailInboxError("invalid_input");
    const query = new URLSearchParams({ limit: String(INBOX_PAGE_SIZE) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const page = parseInboxPage(await this.#request("GET", `v1/me/inbox?${query}`, accessToken));
    if (!page) throw new SkyMailInboxError("contract");
    return page;
  }

  async counts(accessToken: string) {
    const counts = parseInboxCounts(await this.#request("GET", "v1/me/inbox/counts", accessToken));
    if (!counts) throw new SkyMailInboxError("contract");
    return counts;
  }

  async mark(accessToken: string, id: string, action: InboxItemAction) {
    if (!isInboxItemId(id) || !isInboxItemAction(action)) throw new SkyMailInboxError("invalid_input");
    const item = parseInboxItem(await this.#request("POST", `v1/me/inbox/${encodeURIComponent(id)}/${action}`, accessToken));
    if (!item) throw new SkyMailInboxError("contract");
    return item;
  }

  async markAll(accessToken: string, action: "read-all" | "seen-all") {
    if (action !== "read-all" && action !== "seen-all") throw new SkyMailInboxError("invalid_input");
    const body = await this.#request("POST", `v1/me/inbox/${action}`, accessToken);
    if (!isRecord(body) || typeof body.updated !== "number" || !Number.isSafeInteger(body.updated) || body.updated < 0) {
      throw new SkyMailInboxError("contract");
    }
    return body.updated;
  }
}
