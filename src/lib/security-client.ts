/**
 * Browser-side plumbing shared by the security page's mutations: same-origin
 * JSON calls with the session CSRF proof, and the Sudo mode retry loop around
 * the `428 sudo_required` challenge the BFF sends before doing anything.
 */

export type SudoChallengeReason = "missing" | "expired" | "spi_token_required";

export type SudoChallengeBody = {
  error: "sudo_required";
  reason: SudoChallengeReason;
  methods: string[];
  fallback: "microsoft" | null;
};

export type MutationOutcome =
  | { kind: "ok"; response: Response; body: unknown }
  | { kind: "error"; response: Response; status: number; body: unknown }
  /** The person dismissed the Sudo mode dialog; nothing was sent again. */
  | { kind: "sudo_cancelled" }
  /** A Microsoft re-authentication proof exists but the SPI needs a sudo token (K3d); the page explains. */
  | { kind: "spi_token_required" };

export type EnsureSudo = (options?: { challenged?: boolean }) => Promise<boolean>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

export function parseSudoChallenge(body: unknown): SudoChallengeBody | null {
  if (
    !isObject(body) ||
    body.error !== "sudo_required" ||
    (body.reason !== "missing" && body.reason !== "expired" && body.reason !== "spi_token_required") ||
    !Array.isArray(body.methods) ||
    !body.methods.every((method) => typeof method === "string") ||
    (body.fallback !== null && body.fallback !== "microsoft")
  ) return null;
  return {
    error: "sudo_required",
    reason: body.reason,
    methods: body.methods as string[],
    fallback: body.fallback,
  };
}

/** The Turkish `detail` of a BFF problem body, bounded, or the fallback. */
export function detailOf(body: unknown, fallback: string) {
  return isObject(body) && typeof body.detail === "string" && body.detail.length > 0 && body.detail.length <= 512
    ? body.detail
    : fallback;
}

/** The stable `error` key of a BFF problem body, or an empty string. */
export function errorOf(body: unknown) {
  return isObject(body) && typeof body.error === "string" && body.error.length <= 64 ? body.error : "";
}

/** Seconds to wait before the next attempt (body first, `Retry-After` second), bounded to a day. */
export function retryAfterOf(body: unknown, response: Response) {
  if (isObject(body) && typeof body.retryAfter === "number" && Number.isFinite(body.retryAfter) && body.retryAfter > 0) {
    return Math.min(Math.ceil(body.retryAfter), 24 * 60 * 60);
  }
  const header = response.headers.get("retry-after");
  return header && /^\d{1,6}$/.test(header) ? Number(header) : undefined;
}

export type SecurityRequest = {
  method: "POST" | "DELETE";
  path: string;
  csrfToken: string;
  body?: unknown;
};

/** A same-origin mutation call carrying the session CSRF proof; never cached, never following redirects. */
export function securityRequest({ method, path, csrfToken, body }: SecurityRequest) {
  return fetch(path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers: {
      "x-csrf-token": csrfToken,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * Sends a mutation and, when the BFF answers `428 sudo_required`, opens the
 * Sudo mode dialog once and retries. A second `428` is reported as an error
 * rather than retried again, so a stale or unusable proof can never loop.
 */
export async function runWithSudo(send: () => Promise<Response>, ensureSudo: EnsureSudo): Promise<MutationOutcome> {
  let response = await send();
  if (response.status === 428) {
    const challenge = parseSudoChallenge(await responseJson(response));
    if (challenge?.reason === "spi_token_required") return { kind: "spi_token_required" };
    const verified = await ensureSudo({ challenged: true });
    if (!verified) return { kind: "sudo_cancelled" };
    response = await send();
    if (response.status === 428) {
      const again = parseSudoChallenge(await responseJson(response));
      if (again?.reason === "spi_token_required") return { kind: "spi_token_required" };
      return { kind: "error", response, status: 428, body: again };
    }
  }
  const body = response.status === 204 ? null : await responseJson(response);
  if (response.ok) return { kind: "ok", response, body };
  return { kind: "error", response, status: response.status, body };
}

/** Splits a Base32 secret into groups of four for manual entry, without changing its characters. */
export function groupSecret(secret: string) {
  return secret.replace(/=+$/, "").match(/.{1,4}/g)?.join(" ") ?? secret;
}
