import "server-only";

/**
 * RFC 7807 problem codes of sky-account API v1 with their pinned HTTP status.
 * `code` is the stable branching key for the BFF; `detail` is the Turkish
 * sentence that may be shown to the person.
 */
export const skyAccountProblemStatuses = {
  unauthorized: 401,
  sudo_required: 401,
  sudo_expired: 401,
  invalid_credentials: 401,
  user_temporarily_locked: 401,
  user_disabled: 401,
  invalid_request: 400,
  password_not_configured: 400,
  totp_not_configured: 400,
  password_policy: 400,
  password_rejected: 400,
  totp_setup_expired: 400,
  invalid_totp_code: 400,
  invalid_name: 400,
  invalid_username: 400,
  name_locked: 403,
  credential_not_found: 404,
  duplicate_label: 409,
  username_taken: 409,
  username_cooldown: 409,
  rate_limited: 429,
  unmanaged_attributes_enabled: 503,
  internal_error: 500,
} as const;

export type SkyAccountProblemCode = keyof typeof skyAccountProblemStatuses;

export type SkyAccountProblemDetails = {
  code: SkyAccountProblemCode;
  status: (typeof skyAccountProblemStatuses)[SkyAccountProblemCode];
  detail: string;
  retryAfter: number | null;
  field: string | null;
  policy: string | null;
  params: ReadonlyArray<string | number>;
  availableAt: Date | null;
};

const PROBLEM_TYPE_PREFIX = "tag:yildizskylab.com,2026:sky-account:";
const MAX_DETAIL_LENGTH = 2_048;
const MAX_RETRY_AFTER_SECONDS = 365 * 24 * 60 * 60;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A typed sky-account rejection. The message never carries the upstream body. */
export class SkyAccountProblem extends Error {
  readonly code: SkyAccountProblemCode;
  readonly status: SkyAccountProblemDetails["status"];
  readonly detail: string;
  readonly retryAfter: number | null;
  readonly field: string | null;
  readonly policy: string | null;
  readonly params: ReadonlyArray<string | number>;
  readonly availableAt: Date | null;

  constructor(details: SkyAccountProblemDetails) {
    super(`sky-account v1 answered ${details.status} ${details.code}.`);
    this.name = "SkyAccountProblem";
    this.code = details.code;
    this.status = details.status;
    this.detail = details.detail;
    this.retryAfter = details.retryAfter;
    this.field = details.field;
    this.policy = details.policy;
    this.params = details.params;
    this.availableAt = details.availableAt;
  }
}

export class SkyAccountUnavailableError extends Error {
  constructor() {
    super("sky-account v1 is unavailable.");
    this.name = "SkyAccountUnavailableError";
  }
}

export class SkyAccountContractError extends Error {
  constructor() {
    super("sky-account v1 response did not match the pinned contract.");
    this.name = "SkyAccountContractError";
  }
}

export class SkyAccountInvalidInputError extends Error {
  constructor(readonly field: string) {
    super(`sky-account v1 request input is invalid: ${field}.`);
    this.name = "SkyAccountInvalidInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProblemCode(value: unknown): value is SkyAccountProblemCode {
  return typeof value === "string" && Object.hasOwn(skyAccountProblemStatuses, value);
}

function optionalString(value: unknown, maximum: number): value is string | undefined | null {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maximum);
}

function retrySeconds(value: unknown): number | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RETRY_AFTER_SECONDS) {
    return value;
  }
  return false;
}

/**
 * Maps a parsed `application/problem+json` body to `SkyAccountProblem`, or
 * returns `null` when the body or its status disagree with the pinned table.
 */
export function parseSkyAccountProblem(
  body: unknown,
  responseStatus: number,
  retryAfterHeader: string | null,
): SkyAccountProblem | null {
  if (!isRecord(body) || !isProblemCode(body.code)) return null;
  const code = body.code;
  const status = skyAccountProblemStatuses[code];
  if (
    responseStatus !== status ||
    body.status !== status ||
    body.type !== `${PROBLEM_TYPE_PREFIX}${code}` ||
    typeof body.detail !== "string" ||
    body.detail.length === 0 ||
    body.detail.length > MAX_DETAIL_LENGTH ||
    !optionalString(body.title, 512) ||
    !optionalString(body.field, 64) ||
    !optionalString(body.policy, 128) ||
    !optionalString(body.availableAt, 64) ||
    (body.availableAt !== undefined && body.availableAt !== null &&
      (!RFC3339_UTC.test(body.availableAt) || !Number.isFinite(Date.parse(body.availableAt)))) ||
    (body.params !== undefined && body.params !== null &&
      (!Array.isArray(body.params) || body.params.length > 16 ||
        !body.params.every((parameter) =>
          (typeof parameter === "string" && parameter.length <= 512) ||
          (typeof parameter === "number" && Number.isFinite(parameter)))))
  ) {
    return null;
  }
  const bodyRetryAfter = retrySeconds(body.retryAfter);
  if (bodyRetryAfter === false) return null;
  const headerRetryAfter = retryAfterHeader !== null && /^\d{1,9}$/.test(retryAfterHeader.trim())
    ? Number(retryAfterHeader.trim())
    : null;
  return new SkyAccountProblem({
    code,
    status,
    detail: body.detail,
    retryAfter: bodyRetryAfter ?? headerRetryAfter,
    field: body.field ?? null,
    policy: body.policy ?? null,
    params: Object.freeze([...((body.params ?? []) as Array<string | number>)]),
    availableAt: body.availableAt ? new Date(body.availableAt) : null,
  });
}
