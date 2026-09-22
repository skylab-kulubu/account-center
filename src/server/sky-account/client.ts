import "server-only";

import { COMPACT_JWS } from "@/server/contract-shapes";
import {
  parseSkyAccountProblem,
  SkyAccountContractError,
  SkyAccountProblem,
  SkyAccountInvalidInputError,
  SkyAccountUnavailableError,
} from "@/server/sky-account/problem";
import {
  parseCredential,
  parseEmailChangeRequest,
  parseIdentity,
  parsePendingEmailChange,
  parseSudoGrant,
  parseTotpSetup,
  parseWebauthnAssertion,
  parseWebauthnAssertionOptions,
  parseWebauthnAttestation,
  parseWebauthnRegistrationOptions,
} from "@/server/sky-account/schema";
import type {
  BearerAuthorization,
  ChangePasswordInput,
  ChangeUsernameInput,
  EmailChangeInput,
  EmailConfirmInput,
  PatchNameInput,
  PrimaryEmailInput,
  RegisterPasskeyInput,
  SkyAccountClient,
  SudoAuthenticationInput,
  SudoAuthorization,
  SudoPasswordInput,
  SudoTotpInput,
  TotpConfirmInput,
  WebauthnAssertion,
} from "@/server/sky-account/types";

export {
  SkyAccountContractError,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
  skyAccountProblemStatuses,
} from "@/server/sky-account/problem";
export type {
  SkyAccountProblemCode,
  SkyAccountProblemDetails,
  SkyAccountProblemStatus,
} from "@/server/sky-account/problem";
export { parseWebauthnAssertion, parseWebauthnAttestation } from "@/server/sky-account/schema";
export type * from "@/server/sky-account/types";

/** The sky-account API generation this client is written against. */
export const SKY_ACCOUNT_API_VERSION = "v1";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_REQUEST_BYTES = 8 * 1_024;
/** Passkey ceremony bodies (`credentials/webauthn/register`, `sudo/webauthn/verify`) may carry up to 64 KB (contract, Uç noktalar). */
const MAX_CEREMONY_REQUEST_BYTES = 64 * 1_024;
const SUDO_HEADER = "x-sky-sudo";
/** Contract limits (`docs/sky-account-api.md`): names ≤ 64 characters after normalization, username `^[a-z0-9._]{3,30}$`. */
const MAX_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 64;
const USERNAME = /^[a-z0-9._]{3,30}$/;
const TOTP_CODE = /^\d{4,10}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SETUP_HANDLE = /^[A-Za-z0-9_-]{1,255}$/;
const BEARER_TOKEN = /^[\x21-\x7e]{1,8192}$/;
/** RFC 5321 path limit; the shape check only keeps obvious non-addresses local, Keycloak's validator decides. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const EMAIL_CODE = /^\d{6}$/;
const primaryChoices = new Set(["school", "personal"]);

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type JsonBody = Record<string, unknown>;

type RequestSpec = {
  method: Method;
  path: string;
  auth: BearerAuthorization;
  sudo?: string;
  body?: JsonBody;
  maxRequestBytes?: number;
  expectedStatus: 200 | 201 | 202 | 204;
};

function requireToken(value: string, field: string) {
  if (!BEARER_TOKEN.test(value)) throw new SkyAccountInvalidInputError(field);
  return value;
}

function requireText(value: string, field: string, maximum: number) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) throw new SkyAccountInvalidInputError(field);
  return trimmed;
}

function requireSecret(value: string, field: string, maximum = 1_024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new SkyAccountInvalidInputError(field);
  }
  return value;
}

function requireCode(value: string, field: string) {
  if (!TOTP_CODE.test(value)) throw new SkyAccountInvalidInputError(field);
  return value;
}

function requireAddress(value: string) {
  const address = typeof value === "string" ? value.trim() : "";
  if (address.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(address)) throw new SkyAccountInvalidInputError("address");
  return address;
}

function requireEmailCode(value: string) {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!EMAIL_CODE.test(code)) throw new SkyAccountInvalidInputError("code");
  return code;
}

function requireUsername(value: string) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!USERNAME.test(username)) throw new SkyAccountInvalidInputError("username");
  return username;
}

async function readBounded(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SkyAccountContractError();
    }
    chunks.push(result.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function mediaType(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

/**
 * Typed transport to the sky-account Keycloak extension
 * (`${OIDC_ISSUER}/sky-account/v1`). Every call carries the session's user
 * access token; sudo-protected calls additionally carry the opaque sudo token
 * in `X-Sky-Sudo`. No retries (mutations are not idempotent), bounded
 * timeouts and bodies, RFC 7807 problems mapped to `SkyAccountProblem`, and
 * no request or response body ever reaches a log or an error message.
 */
export class SkyAccountHttpClient implements SkyAccountClient {
  readonly #baseUrl: URL;

  constructor(
    issuer: URL,
    private readonly request: typeof fetch = fetch,
  ) {
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error("sky-account requires the canonical HTTPS realm issuer.");
    }
    this.#baseUrl = new URL(
      `${issuer.pathname.replace(/\/$/, "")}/sky-account/${SKY_ACCOUNT_API_VERSION}/`,
      issuer.origin,
    );
  }

  async #call(spec: RequestSpec) {
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
      authorization: `Bearer ${requireToken(spec.auth.accessToken, "accessToken")}`,
    };
    if (spec.sudo !== undefined) headers[SUDO_HEADER] = requireToken(spec.sudo, "sudoToken");
    let body: string | null = null;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      if (Buffer.byteLength(body, "utf8") > (spec.maxRequestBytes ?? MAX_REQUEST_BYTES)) {
        throw new SkyAccountInvalidInputError("body");
      }
      headers["content-type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.request(new URL(spec.path, this.#baseUrl), {
        method: spec.method,
        body,
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SkyAccountUnavailableError();
    }
    return this.#outcome(response, spec.expectedStatus);
  }

  async #outcome(response: Response, expectedStatus: RequestSpec["expectedStatus"]): Promise<unknown> {
    const type = mediaType(response);
    if (response.status === expectedStatus) {
      if (expectedStatus === 204) return undefined;
      if (type !== "application/json") throw new SkyAccountContractError();
      try {
        return JSON.parse(await readBounded(response)) as unknown;
      } catch {
        throw new SkyAccountContractError();
      }
    }
    if (type === "application/problem+json") {
      let problem: unknown;
      try {
        problem = JSON.parse(await readBounded(response));
      } catch {
        throw new SkyAccountContractError();
      }
      const mapped = parseSkyAccountProblem(problem, response.status, response.headers.get("retry-after"));
      if (mapped) throw mapped;
      throw new SkyAccountContractError();
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new SkyAccountUnavailableError();
    }
    throw new SkyAccountContractError();
  }

  async identity(auth: BearerAuthorization) {
    return parseIdentity(await this.#call({
      method: "GET",
      path: "identity",
      auth,
      expectedStatus: 200,
    }));
  }

  async patchName(auth: BearerAuthorization, input: PatchNameInput) {
    return parseIdentity(await this.#call({
      method: "PATCH",
      path: "identity/name",
      auth,
      body: {
        firstName: requireText(input.firstName, "firstName", MAX_NAME_LENGTH),
        lastName: requireText(input.lastName, "lastName", MAX_NAME_LENGTH),
      },
      expectedStatus: 200,
    }));
  }

  async changeUsername(auth: SudoAuthorization, input: ChangeUsernameInput) {
    return parseIdentity(await this.#call({
      method: "POST",
      path: "identity/username",
      auth,
      sudo: auth.sudoToken,
      body: { username: requireUsername(input.username) },
      expectedStatus: 200,
    }));
  }

  async sudoPassword(auth: BearerAuthorization, input: SudoPasswordInput) {
    return parseSudoGrant(await this.#call({
      method: "POST",
      path: "sudo/password",
      auth,
      body: { password: requireSecret(input.password, "password") },
      expectedStatus: 200,
    }));
  }

  async sudoTotp(auth: BearerAuthorization, input: SudoTotpInput) {
    return parseSudoGrant(await this.#call({
      method: "POST",
      path: "sudo/totp",
      auth,
      body: { code: requireCode(input.code, "code") },
      expectedStatus: 200,
    }));
  }

  async sudoWebauthnOptions(auth: BearerAuthorization) {
    return parseWebauthnAssertionOptions(await this.#call({
      method: "POST",
      path: "sudo/webauthn/options",
      auth,
      expectedStatus: 200,
    }));
  }

  async sudoWebauthnVerify(auth: BearerAuthorization, assertion: WebauthnAssertion) {
    const validated = parseWebauthnAssertion(assertion);
    if (!validated) throw new SkyAccountInvalidInputError("assertion");
    return parseSudoGrant(await this.#call({
      method: "POST",
      path: "sudo/webauthn/verify",
      auth,
      body: validated,
      maxRequestBytes: MAX_CEREMONY_REQUEST_BYTES,
      expectedStatus: 200,
    }));
  }

  /**
   * Proves sudo with the ID token of a fresh Keycloak login, for a person who
   * has no password, verification app or passkey. The bearer is the same
   * session's access token and no `X-Sky-Sudo` is sent; the SPI verifies the
   * token's signature, its binding to this session (`sub`, `sid`) and its
   * `auth_time`, and answers the same grant the other proofs return (the
   * window starts at the login: `expiresAt = auth_time + 300`). A login older
   * than five minutes is `401 authentication_stale`; every other rejection is
   * `401 sudo_required`. The ID token is validated locally before it is sent
   * and never appears in a log, an error message or a thrown message.
   */
  async sudoAuthentication(auth: BearerAuthorization, input: SudoAuthenticationInput) {
    const idToken = typeof input.idToken === "string" ? input.idToken : "";
    if (!COMPACT_JWS.test(idToken)) throw new SkyAccountInvalidInputError("idToken");
    return parseSudoGrant(await this.#call({
      method: "POST",
      path: "sudo/authentication",
      auth,
      body: { idToken },
      expectedStatus: 200,
    }));
  }

  async changePassword(auth: SudoAuthorization, input: ChangePasswordInput) {
    if (typeof input.logoutOtherSessions !== "boolean") {
      throw new SkyAccountInvalidInputError("logoutOtherSessions");
    }
    await this.#call({
      method: "POST",
      path: "credentials/password",
      auth,
      sudo: auth.sudoToken,
      body: {
        newPassword: requireSecret(input.newPassword, "newPassword"),
        logoutOtherSessions: input.logoutOtherSessions,
      },
      expectedStatus: 204,
    });
  }

  async totpSetup(auth: SudoAuthorization) {
    return parseTotpSetup(await this.#call({
      method: "POST",
      path: "credentials/totp/setup",
      auth,
      sudo: auth.sudoToken,
      expectedStatus: 200,
    }));
  }

  async totpConfirm(auth: SudoAuthorization, input: TotpConfirmInput) {
    if (!SETUP_HANDLE.test(input.setupHandle)) throw new SkyAccountInvalidInputError("setupHandle");
    return parseCredential(await this.#call({
      method: "POST",
      path: "credentials/totp/confirm",
      auth,
      sudo: auth.sudoToken,
      body: {
        setupHandle: input.setupHandle,
        code: requireCode(input.code, "code"),
        label: requireText(input.label, "label", MAX_LABEL_LENGTH),
      },
      expectedStatus: 201,
    }));
  }

  async webauthnRegistrationOptions(auth: SudoAuthorization) {
    return parseWebauthnRegistrationOptions(await this.#call({
      method: "POST",
      path: "credentials/webauthn/options",
      auth,
      sudo: auth.sudoToken,
      expectedStatus: 200,
    }));
  }

  async registerPasskey(auth: SudoAuthorization, input: RegisterPasskeyInput) {
    const validated = parseWebauthnAttestation(input.attestation);
    if (!validated) throw new SkyAccountInvalidInputError("attestation");
    return parseCredential(await this.#call({
      method: "POST",
      path: "credentials/webauthn/register",
      auth,
      sudo: auth.sudoToken,
      body: { ...validated, label: requireText(input.label, "label", MAX_LABEL_LENGTH) },
      maxRequestBytes: MAX_CEREMONY_REQUEST_BYTES,
      expectedStatus: 201,
    }));
  }

  async deleteCredential(auth: SudoAuthorization, credentialId: string) {
    if (!CREDENTIAL_ID.test(credentialId)) throw new SkyAccountInvalidInputError("credentialId");
    await this.#call({
      method: "DELETE",
      path: `credentials/${encodeURIComponent(credentialId)}`,
      auth,
      sudo: auth.sudoToken,
      expectedStatus: 204,
    });
  }

  /**
   * Mails a six-digit code to a new Personal e-mail (`202 { expiresAt }`).
   * Nothing is written to the person yet; a second request replaces the
   * first and kills its code. The address is only trimmed here: the SPI
   * lower-cases it and runs Keycloak's validator, and it never reaches a
   * log line on either side.
   */
  async requestEmailChange(auth: SudoAuthorization, input: EmailChangeInput) {
    return parseEmailChangeRequest(await this.#call({
      method: "POST",
      path: "email/change-request",
      auth,
      sudo: auth.sudoToken,
      body: { address: requireAddress(input.address) },
      expectedStatus: 202,
    }));
  }

  /**
   * Proves the pending address with the mailed code. Bearer only, no sudo:
   * the SPI compares the code with the caller's own pending change, so a
   * code read by anyone else cannot attach the address to another account.
   */
  async confirmEmail(auth: BearerAuthorization, input: EmailConfirmInput) {
    return parseIdentity(await this.#call({
      method: "POST",
      path: "email/confirm",
      auth,
      body: { code: requireEmailCode(input.code) },
      expectedStatus: 200,
    }));
  }

  /**
   * The caller's change still waiting for its code (address, deadline, tries
   * left), read without consuming it, so a page reloaded between the mail and
   * the code can show the code box again. `null` when nothing waits.
   */
  async pendingEmailChange(auth: BearerAuthorization) {
    try {
      return parsePendingEmailChange(await this.#call({
        method: "GET",
        path: "email/pending",
        auth,
        expectedStatus: 200,
      }));
    } catch (error) {
      if (error instanceof SkyAccountProblem && error.code === "no_pending_email_change") return null;
      throw error;
    }
  }

  async setPrimaryEmail(auth: SudoAuthorization, input: PrimaryEmailInput) {
    if (!primaryChoices.has(input.which)) throw new SkyAccountInvalidInputError("which");
    return parseIdentity(await this.#call({
      method: "POST",
      path: "email/primary",
      auth,
      sudo: auth.sudoToken,
      body: { which: input.which },
      expectedStatus: 200,
    }));
  }

  async removePersonalEmail(auth: SudoAuthorization) {
    return parseIdentity(await this.#call({
      method: "DELETE",
      path: "email/personal",
      auth,
      sudo: auth.sudoToken,
      expectedStatus: 200,
    }));
  }
}
