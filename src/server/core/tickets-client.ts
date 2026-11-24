import "server-only";

import { isTicketCancelCode, isTicketId, parseTickets } from "@/lib/tickets";
import type { AccountTicket, TicketCancelCode } from "@/lib/tickets";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Tickets client for core `GET /v1/tickets/me?include=waitlisted,cancelled`
 * and the holder's `POST /v1/tickets/{id}/cancel` (core
 * `docs/ticket-cancellation.md`), called with the person's own Account
 * Center user token (audience `core`). Transport rules follow
 * `skypass-wallet-client.ts`: canonical HTTPS origin, bounded timeouts and
 * bodies, no retries, no redirects, status-only errors and no upstream body
 * in errors or logs.
 */

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REQUEST_TIMEOUT_MS = 5_000;
/** A person's tickets with their Events' summaries; a few hundred fit. */
const MAX_RESPONSE_BYTES = 512 * 1_024;

export interface CoreTicketsClient {
  mine(accessToken: string): Promise<AccountTicket[]>;
  /** The holder cancels their own ticket; `200` again for one already cancelled. */
  cancel(accessToken: string, ticketId: string): Promise<void>;
}

export type CoreTicketsFailure =
  | "unauthorized"
  | "forbidden"
  /** No such ticket of this person, or core has no such route. */
  | "not_found"
  /** Core refused the cancel; `code` says why. */
  | "refused"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "contract"
  | "invalid_input";

export class CoreTicketsError extends Error {
  static {
    brandCrossBundleError(this, "CoreTicketsError");
  }

  constructor(
    readonly failure: CoreTicketsFailure,
    /** Core's refusal code, for `refused`; null when it sent one this BFF does not know. */
    readonly code: TicketCancelCode | null = null,
  ) {
    super(`Core tickets request failed: ${failure}.`);
    this.name = "CoreTicketsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreTicketsError("invalid_input");
  return `Bearer ${accessToken}`;
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

/** Maps a non-2xx answer by status and core's `code`; the problem body is read for `code` only. */
async function failureOf(response: Response): Promise<CoreTicketsError> {
  const { status } = response;
  if (status === 401) return new CoreTicketsError("unauthorized");
  if (status === 403) return new CoreTicketsError("forbidden");
  if (status === 404) return new CoreTicketsError("not_found");
  if (status === 429) return new CoreTicketsError("rate_limited");
  if (status === 409) {
    const body = await readBoundedJson(response, ["application/problem+json", "application/json"]);
    const code = isRecord(body) ? body.code : null;
    return new CoreTicketsError("refused", isTicketCancelCode(code) ? code : null);
  }
  if (status >= 400 && status < 500) return new CoreTicketsError("rejected");
  return new CoreTicketsError("unavailable");
}

export class CoreTicketsHttpClient implements CoreTicketsClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly now: () => number = Date.now,
  ) {
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

  async #request(path: string, method: "GET" | "POST", accessToken: string) {
    const authorization = requireBearer(accessToken);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        body: null,
        headers: { accept: "application/json", authorization },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreTicketsError("unavailable");
    }
    if (response.status === 200) return response;
    if (response.status >= 200 && response.status < 300) throw new CoreTicketsError("contract");
    throw await failureOf(response);
  }

  async mine(accessToken: string) {
    const response = await this.#request("/v1/tickets/me?include=waitlisted,cancelled", "GET", accessToken);
    const tickets = parseTickets(await readBoundedJson(response, ["application/json"]), this.now());
    if (!tickets) throw new CoreTicketsError("contract");
    return tickets;
  }

  async cancel(accessToken: string, ticketId: string) {
    if (!isTicketId(ticketId)) throw new CoreTicketsError("invalid_input");
    await this.#request(`/v1/tickets/${encodeURIComponent(ticketId)}/cancel`, "POST", accessToken);
  }
}
