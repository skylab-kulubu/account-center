import "server-only";

/**
 * Club-profile client for core `GET/PATCH /v1/users/me` and
 * `POST/DELETE /v1/users/me/profile-picture`, called with the person's own
 * Account Center user token (audience `core`, no core roles). Transport rules
 * follow `account-deletion/core-gateway.ts`: canonical HTTPS origin, bounded
 * timeouts and bodies, no retries on non-idempotent calls, status-only error
 * mapping, and no upstream body in errors or logs. The me-view parser checks
 * every documented member strictly and ignores members it does not know, so
 * additive core releases never fail the BFF closed.
 */

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
const PRINTABLE_TEXT = /^[^\p{Cc}]*$/u;
const REQUEST_TIMEOUT_MS = 5_000;
const UPLOAD_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1_024;
const MAX_PICTURE_BYTES = 5 * 1_024 * 1_024;

/** Multipart field name core reads the picture from; verify against core before A2 ships. */
export const CORE_PROFILE_PICTURE_FIELD = "file";

const pictureContentTypes: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const patchFieldLimits = {
  firstName: 255,
  lastName: 255,
  linkedin: 512,
  university: 255,
  faculty: 255,
  department: 255,
} as const;
const nullableStringKeys = [
  "email",
  "firstName",
  "lastName",
  "username",
  "schoolEmail",
  "skyNumber",
  "linkedin",
  "university",
  "faculty",
  "department",
  "profilePictureId",
  "phone",
] as const;

export type CoreProfile = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  schoolEmail: string | null;
  skyNumber: string | null;
  studentCardLinked: boolean;
  linkedin: string | null;
  university: string | null;
  faculty: string | null;
  department: string | null;
  profilePictureId: string | null;
  profilePictureUrl: string | null;
  phone: string | null;
  /**
   * University, faculty and department follow the YTÜ Microsoft login and
   * core refuses to change them (`409`). Core decides who is YTÜ-linked; a
   * core that predates the member reports nobody as linked.
   */
  ytuLinked: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CoreProfilePatch = Partial<Record<keyof typeof patchFieldLimits, string>>;

export type CoreProfilePictureContentType = "image/png" | "image/jpeg" | "image/webp";

export type CoreProfilePictureUpload = {
  bytes: Uint8Array;
  contentType: CoreProfilePictureContentType;
  fileName?: string;
};

export interface CoreProfileClient {
  getMe(accessToken: string): Promise<CoreProfile>;
  patchMe(accessToken: string, patch: CoreProfilePatch): Promise<CoreProfile>;
  uploadProfilePicture(accessToken: string, upload: CoreProfilePictureUpload): Promise<void>;
  deleteProfilePicture(accessToken: string): Promise<void>;
}

export class CoreProfileUnavailableError extends Error {
  constructor() {
    super("Core profile is unavailable.");
    this.name = "CoreProfileUnavailableError";
  }
}

export class CoreProfileUnauthorizedError extends Error {
  constructor() {
    super("Core rejected the profile credential.");
    this.name = "CoreProfileUnauthorizedError";
  }
}

export class CoreProfileForbiddenError extends Error {
  constructor() {
    super("Core denied the profile operation.");
    this.name = "CoreProfileForbiddenError";
  }
}

export class CoreProfileNotFoundError extends Error {
  constructor() {
    super("Core has no profile for the caller.");
    this.name = "CoreProfileNotFoundError";
  }
}

/** Core refused the request itself (validation, size, media type, rate limit). */
export class CoreProfileRejectedError extends Error {
  constructor(readonly status: number) {
    super(`Core rejected the profile request with status ${status}.`);
    this.name = "CoreProfileRejectedError";
  }
}

export class CoreProfileContractError extends Error {
  constructor() {
    super("Core profile response did not match the pinned contract.");
    this.name = "CoreProfileContractError";
  }
}

export class CoreProfileInvalidInputError extends Error {
  constructor(readonly field: string) {
    super(`Core profile request input is invalid: ${field}.`);
    this.name = "CoreProfileInvalidInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maximum = 1_024): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && value.length <= maximum);
}

function absoluteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseProfile(value: unknown): CoreProfile {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 255 ||
    !nullableStringKeys.every((key) => nullableString(value[key])) ||
    (value.studentCardLinked !== undefined && value.studentCardLinked !== null &&
      typeof value.studentCardLinked !== "boolean") ||
    (value.ytuLinked !== undefined && value.ytuLinked !== null && typeof value.ytuLinked !== "boolean") ||
    !nullableString(value.profilePictureUrl, 2_048) ||
    (typeof value.profilePictureUrl === "string" && !absoluteHttpUrl(value.profilePictureUrl)) ||
    !nullableString(value.createdAt, 64) ||
    (typeof value.createdAt === "string" && !RFC3339_UTC.test(value.createdAt)) ||
    !nullableString(value.updatedAt, 64) ||
    (typeof value.updatedAt === "string" && !RFC3339_UTC.test(value.updatedAt))
  ) {
    throw new CoreProfileContractError();
  }
  const text = (key: (typeof nullableStringKeys)[number]) => (value[key] as string | null | undefined) ?? null;
  return {
    id: value.id,
    email: text("email"),
    firstName: text("firstName"),
    lastName: text("lastName"),
    username: text("username"),
    schoolEmail: text("schoolEmail"),
    skyNumber: text("skyNumber"),
    studentCardLinked: value.studentCardLinked === true,
    linkedin: text("linkedin"),
    university: text("university"),
    faculty: text("faculty"),
    department: text("department"),
    profilePictureId: text("profilePictureId"),
    profilePictureUrl: (value.profilePictureUrl as string | null | undefined) ?? null,
    phone: text("phone"),
    ytuLinked: value.ytuLinked === true,
    createdAt: (value.createdAt as string | null | undefined) ?? null,
    updatedAt: (value.updatedAt as string | null | undefined) ?? null,
  };
}

function mappedError(status: number) {
  if (status === 401) return new CoreProfileUnauthorizedError();
  if (status === 403) return new CoreProfileForbiddenError();
  if (status === 404) return new CoreProfileNotFoundError();
  if (status >= 400 && status < 500) return new CoreProfileRejectedError(status);
  return new CoreProfileUnavailableError();
}

function requireBearer(accessToken: string) {
  if (!BEARER_TOKEN.test(accessToken)) throw new CoreProfileInvalidInputError("accessToken");
  return `Bearer ${accessToken}`;
}

function normalizePatch(patch: CoreProfilePatch) {
  if (!isRecord(patch)) throw new CoreProfileInvalidInputError("patch");
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(patchFieldLimits, key)) throw new CoreProfileInvalidInputError(key);
    const limit = patchFieldLimits[key as keyof typeof patchFieldLimits];
    if (typeof value !== "string" || value.length > limit || !PRINTABLE_TEXT.test(value)) {
      throw new CoreProfileInvalidInputError(key);
    }
    body[key] = value.trim();
  }
  if (Object.keys(body).length === 0) throw new CoreProfileInvalidInputError("patch");
  return body;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (contentType !== "application/json" || (declaredLength > 0 && declaredLength > MAX_RESPONSE_BYTES)) {
    throw new CoreProfileContractError();
  }
  try {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CoreProfileContractError();
  }
}

export class CoreProfileHttpClient implements CoreProfileClient {
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
    path: "/v1/users/me" | "/v1/users/me/profile-picture",
    method: "GET" | "PATCH" | "POST" | "DELETE",
    accessToken: string,
    options: { body?: string | FormData; acceptedStatuses: readonly number[]; timeoutMs?: number },
  ) {
    const authorization = requireBearer(accessToken);
    const headers: Record<string, string> = { accept: "application/json", authorization };
    if (typeof options.body === "string") headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        body: options.body ?? null,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CoreProfileUnavailableError();
    }
    if (!options.acceptedStatuses.includes(response.status)) {
      if (response.status >= 200 && response.status < 300) throw new CoreProfileContractError();
      throw mappedError(response.status);
    }
    return response;
  }

  async getMe(accessToken: string) {
    const response = await this.#request("/v1/users/me", "GET", accessToken, { acceptedStatuses: [200] });
    return parseProfile(await readBoundedJson(response));
  }

  async patchMe(accessToken: string, patch: CoreProfilePatch) {
    const body = JSON.stringify(normalizePatch(patch));
    const response = await this.#request("/v1/users/me", "PATCH", accessToken, {
      body,
      acceptedStatuses: [200],
    });
    return parseProfile(await readBoundedJson(response));
  }

  async uploadProfilePicture(accessToken: string, upload: CoreProfilePictureUpload) {
    if (!(upload.bytes instanceof Uint8Array) || upload.bytes.byteLength === 0 || upload.bytes.byteLength > MAX_PICTURE_BYTES) {
      throw new CoreProfileInvalidInputError("bytes");
    }
    if (!pictureContentTypes.has(upload.contentType)) throw new CoreProfileInvalidInputError("contentType");
    const extension = upload.contentType === "image/png" ? "png" : upload.contentType === "image/jpeg" ? "jpg" : "webp";
    const fileName = upload.fileName && /^[A-Za-z0-9._-]{1,128}$/.test(upload.fileName)
      ? upload.fileName
      : `profile.${extension}`;
    const form = new FormData();
    form.set(
      CORE_PROFILE_PICTURE_FIELD,
      new File([Buffer.from(upload.bytes)], fileName, { type: upload.contentType }),
    );
    await this.#request("/v1/users/me/profile-picture", "POST", accessToken, {
      body: form,
      acceptedStatuses: [200, 201, 204],
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }

  async deleteProfilePicture(accessToken: string) {
    await this.#request("/v1/users/me/profile-picture", "DELETE", accessToken, {
      acceptedStatuses: [200, 204],
    });
  }
}
