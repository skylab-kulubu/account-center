import "server-only";

import {
  COMMUNICATION_CHANNEL,
  isPreferenceCategory,
  MAX_PREFERENCE_CHANGES,
  parseCommunicationPreferencesView,
} from "@/lib/communication-preferences";
import type { CommunicationPreferencesView, PreferenceChange } from "@/lib/communication-preferences";
import { brandCrossBundleError } from "@/server/cross-bundle-error";

/**
 * Client for core `GET/PUT /v1/users/me/communication-preferences` (core
 * `docs/communication-preferences.md`), called with the person's own Account
 * Center user token. Transport rules follow `profile-client.ts`: canonical
 * HTTPS origin, bounded timeouts and bodies, no retries, no redirects,
 * status-and-code-only errors and no upstream body in errors or logs.
 *
 * Core gives every switch once per channel (`{"email": Cell}`); the screen
 * shows e-mail only, so the parser keeps that channel's cell and ignores the
 * others and every member it does not know. A screen without an e-mail cell
 * where one is due is a contract failure.
 */

const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const REQUEST_TIMEOUT_MS = 8_000;
/** A screen lists every publicly listed team; generous, still bounded. */
const MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const PATH = "/v1/users/me/communication-preferences";

export type CoreCommunicationPreferencesFailure =
  /** Core did not accept the bearer. */
  | "unauthorized"
  /** A service account's token, or another refusal of the caller. */
  | "forbidden"
  /** The person is being erased or is erased (`communication_preference_subject_inactive`). */
  | "subject_inactive"
  /** `COMMUNICATION_PREFERENCE_KEY` is unset in core: preferences are off (`communication_preferences_unavailable`). */
  | "off"
  /** Keycloak did not answer core the team tree (`communication_preference_teams_unavailable`). */
  | "teams_unavailable"
  /** A team that does not exist or may not be followed (`communication_preference_team_unknown`). */
  | "team_unknown"
  /** Core could not read the change (`communication_preference_invalid`) or refused it otherwise. */
  | "rejected"
  /** Core did not answer, or answered a 5xx of its own. */
  | "unavailable"
  /** A 2xx whose body is not the documented one. */
  | "contract"
  | "invalid_input";

export class CoreCommunicationPreferencesError extends Error {
  static {
    brandCrossBundleError(this, "CoreCommunicationPreferencesError");
  }

  constructor(
    readonly failure: CoreCommunicationPreferencesFailure,
    /** Whole seconds to wait, for `teams_unavailable`, when core said. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Core communication preferences request failed: ${failure}.`);
    this.name = "CoreCommunicationPreferencesError";
  }
}

export interface CoreCommunicationPreferencesClient {
  read(accessToken: string): Promise<CommunicationPreferencesView>;
  /** Writes the changes on the e-mail channel in one transaction and answers the new screen. */
  update(accessToken: string, changes: readonly PreferenceChange[]): Promise<CommunicationPreferencesView>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreCommunicationPreferencesError("invalid_input");
  return `Bearer ${accessToken}`;
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
async function failureOf(response: Response): Promise<CoreCommunicationPreferencesError> {
  const { status } = response;
  if (status === 401) return new CoreCommunicationPreferencesError("unauthorized");
  const body = await readBoundedJson(response, ["application/problem+json", "application/json"], 16 * 1_024);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
  if (status === 403) {
    return new CoreCommunicationPreferencesError(
      code === "communication_preference_subject_inactive" ? "subject_inactive" : "forbidden",
    );
  }
  if (status === 503 && code === "communication_preferences_unavailable") return new CoreCommunicationPreferencesError("off");
  if (status === 503 && code === "communication_preference_teams_unavailable") {
    return new CoreCommunicationPreferencesError("teams_unavailable", retryAfter(response.headers.get("retry-after")));
  }
  if (status === 400 && code === "communication_preference_team_unknown") return new CoreCommunicationPreferencesError("team_unknown");
  if (status >= 400 && status < 500) return new CoreCommunicationPreferencesError("rejected");
  return new CoreCommunicationPreferencesError("unavailable");
}

/**
 * The e-mail cell of core's per-channel cell map (`{"email": Cell}`), with
 * `from` made explicit (core leaves it out when the value is the switch's
 * own). Anything else passes through for the shared parser to refuse.
 */
function emailCellOf(channels: unknown) {
  const cell = isRecord(channels) ? channels[COMMUNICATION_CHANNEL] : undefined;
  return isRecord(cell) ? { ...cell, from: cell.from ?? null } : cell;
}

function emailKindsOf(value: unknown) {
  return isRecord(value) ? { duyuru: emailCellOf(value.duyuru), haber: emailCellOf(value.haber) } : value;
}

function rowOf(value: unknown, depth: number): unknown {
  if (!isRecord(value) || depth > 32) return value;
  return {
    groupId: value.groupId,
    code: value.code,
    displayName: value.displayName,
    path: value.path,
    member: value.member,
    hidden: value.hidden ?? false,
    kinds: emailKindsOf(value.kinds),
    children: Array.isArray(value.children) ? value.children.map((child) => rowOf(child, depth + 1)) : value.children,
  };
}

/** Core's screen projected onto the e-mail channel, then checked by the shared fail-closed parser. */
export function parseCoreScreen(value: unknown): CommunicationPreferencesView {
  if (
    !isRecord(value) ||
    !Array.isArray(value.channels) ||
    !value.channels.includes(COMMUNICATION_CHANNEL) ||
    !Array.isArray(value.teams) ||
    !Array.isArray(value.following)
  ) {
    throw new CoreCommunicationPreferencesError("contract");
  }
  const projected = {
    master: emailCellOf(value.master),
    club: emailKindsOf(value.club),
    teams: value.teams.map((row) => rowOf(row, 0)),
    following: value.following.map((row) => rowOf(row, 0)),
    followable: value.followable,
  };
  const view = parseCommunicationPreferencesView(projected);
  if (!view) throw new CoreCommunicationPreferencesError("contract");
  return view;
}

function normalizeChanges(changes: readonly PreferenceChange[]) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_PREFERENCE_CHANGES) {
    throw new CoreCommunicationPreferencesError("invalid_input");
  }
  const seen = new Set<string>();
  return changes.map(({ category, enabled }) => {
    if (!isPreferenceCategory(category) || seen.has(category) || (enabled !== null && typeof enabled !== "boolean")) {
      throw new CoreCommunicationPreferencesError("invalid_input");
    }
    seen.add(category);
    return { category, channel: COMMUNICATION_CHANNEL, enabled };
  });
}

export class CoreCommunicationPreferencesHttpClient implements CoreCommunicationPreferencesClient {
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

  async #request(method: "GET" | "PUT", accessToken: string, body?: string) {
    const authorization = requireBearer(accessToken);
    const headers: Record<string, string> = { accept: "application/json", authorization };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(new URL(PATH, this.baseUrl), {
        method,
        body: body ?? null,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreCommunicationPreferencesError("unavailable");
    }
    if (response.status === 200) return parseCoreScreen(await readBoundedJson(response, ["application/json"]));
    if (response.status >= 200 && response.status < 300) throw new CoreCommunicationPreferencesError("contract");
    throw await failureOf(response);
  }

  async read(accessToken: string) {
    return this.#request("GET", accessToken);
  }

  async update(accessToken: string, changes: readonly PreferenceChange[]) {
    const items = normalizeChanges(changes);
    return this.#request("PUT", accessToken, JSON.stringify({ items }));
  }
}
