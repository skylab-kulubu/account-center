// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import sudoGrantFixture from "../../../tests/fixtures/sky-account-v1-sudo-grant.json";
import totpCredentialFixture from "../../../tests/fixtures/sky-account-v1-totp-credential.json";
import totpSetupFixture from "../../../tests/fixtures/sky-account-v1-totp-setup.json";
import passkeyCredentialFixture from "../../../tests/fixtures/sky-account-v1-passkey-credential.json";
import assertionJson from "../../../tests/fixtures/sky-account-v1-webauthn-assertion.json";
import assertionOptionsFixture from "../../../tests/fixtures/sky-account-v1-webauthn-assertion-options.json";
import attestationJson from "../../../tests/fixtures/sky-account-v1-webauthn-attestation.json";
import registrationOptionsFixture from "../../../tests/fixtures/sky-account-v1-webauthn-registration-options.json";
import {
  SkyAccountContractError,
  SkyAccountHttpClient,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
  SKY_ACCOUNT_API_VERSION,
} from "@/server/sky-account/client";
import type { SkyAccountProblemCode, WebauthnAssertion, WebauthnAttestation } from "@/server/sky-account/client";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");
const base = "https://e.yildizskylab.com/realms/e-skylab/sky-account/v1";
const bearer = { accessToken: "server-held-user-token" };
const assertionFixture = assertionJson as WebauthnAssertion;
const attestationFixture = attestationJson as WebauthnAttestation & { clientExtensionResults: unknown };
const sudo = { accessToken: "server-held-user-token", sudoToken: "opaque-sudo-token" };

type Recorded = { url: string; method: string; headers: Headers; body: string | null };

function transport(
  respond: (recorded: Recorded) => Response | Promise<Response>,
) {
  const calls: Recorded[] = [];
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(recorded);
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(init?.credentials).toBe("omit");
    return respond(recorded);
  });
  return { request, calls, client: new SkyAccountHttpClient(issuer, request) };
}

function json(value: unknown, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": contentType } });
}

function problem(code: keyof typeof problemsFixture, headers: Record<string, string> = {}) {
  const body = problemsFixture[code];
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("SkyAccountHttpClient", () => {
  it("pins the v1 base path under the configured realm issuer", () => {
    expect(SKY_ACCOUNT_API_VERSION).toBe("v1");
    expect(() => new SkyAccountHttpClient(new URL("http://e.yildizskylab.com/realms/e-skylab"), vi.fn()))
      .toThrow(/HTTPS/);
  });

  it("reads the identity with the session bearer only", async () => {
    const { client, calls } = transport(() => json(identityFixture));
    const identity = await client.identity(bearer);
    expect(identity).toMatchObject({
      sub: "11111111-1111-4111-8111-111111111111",
      username: "account-fixture",
      primary: "school",
      verifiedYtu: true,
      nameLocked: true,
      usernameChangeAvailableAt: null,
      credentials: {
        password: true,
        totp: [expect.objectContaining({ id: "2f0c5b4a-8d3e-4c1b-9a7f-000000000001", type: "otp", label: "Telefon" })],
        passkeys: [
          expect.objectContaining({ type: "webauthn-passwordless", label: "MacBook" }),
          expect.objectContaining({ type: "webauthn", label: null, createdAt: null }),
        ],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${base}/identity`, method: "GET", body: null });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer server-held-user-token");
    expect(calls[0]?.headers.get("x-sky-sudo")).toBeNull();
    expect(calls[0]?.headers.get("accept")).toBe("application/json, application/problem+json");
  });

  it("patches the name without sudo and returns the fresh identity", async () => {
    const { client, calls } = transport(() => json({ ...identityFixture, firstName: "Augusta", nameLocked: false, verifiedYtu: false }));
    const identity = await client.patchName(bearer, { firstName: " Augusta ", lastName: "Lovelace" });
    expect(identity.firstName).toBe("Augusta");
    expect(calls[0]).toMatchObject({
      url: `${base}/identity/name`,
      method: "PATCH",
      body: JSON.stringify({ firstName: "Augusta", lastName: "Lovelace" }),
    });
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("x-sky-sudo")).toBeNull();
  });

  it("sends the sudo token only on sudo-protected endpoints", async () => {
    const { client, calls } = transport((recorded) => {
      if (recorded.url.endsWith("/identity/username")) return json(identityFixture);
      if (recorded.url.endsWith("/credentials/password")) return new Response(null, { status: 204 });
      if (recorded.url.endsWith("/credentials/totp/setup")) return json(totpSetupFixture);
      if (recorded.url.endsWith("/credentials/totp/confirm")) return json(totpCredentialFixture, 201);
      if (recorded.url.includes("/credentials/")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${recorded.url}`);
    });

    await client.changeUsername(sudo, { username: "Ada.Lovelace" });
    await client.changePassword(sudo, { newPassword: "correct horse battery staple", logoutOtherSessions: true });
    const setup = await client.totpSetup(sudo);
    const credential = await client.totpConfirm(sudo, { setupHandle: setup.setupHandle, code: "123456", label: "Telefon" });
    await client.deleteCredential(sudo, credential.id);

    expect(calls.map((call) => [call.method, call.url.replace(base, ""), call.body])).toEqual([
      ["POST", "/identity/username", JSON.stringify({ username: "ada.lovelace" })],
      ["POST", "/credentials/password", JSON.stringify({ newPassword: "correct horse battery staple", logoutOtherSessions: true })],
      ["POST", "/credentials/totp/setup", null],
      ["POST", "/credentials/totp/confirm", JSON.stringify({ setupHandle: setup.setupHandle, code: "123456", label: "Telefon" })],
      ["DELETE", "/credentials/2f0c5b4a-8d3e-4c1b-9a7f-000000000004", null],
    ]);
    for (const call of calls) {
      expect(call.headers.get("x-sky-sudo")).toBe("opaque-sudo-token");
      expect(call.headers.get("authorization")).toBe("Bearer server-held-user-token");
    }
    expect(calls[2]?.headers.get("content-type")).toBeNull();
    expect(setup).toEqual({
      setupHandle: "ZW9faHuWMziZ8fm_cttFxSmAMYRW82GJo8I-FBhR468",
      secret: "OR4DE4DRNFXDKZTQJZUFMSBSKR4G2Z3B",
      otpauthUri: totpSetupFixture.otpauthUri,
      expiresAt: new Date("2026-09-21T13:20:18Z"),
      policy: { type: "totp", algorithm: "SHA1", digits: 6, period: 30 },
    });
    expect(credential).toEqual({
      id: "2f0c5b4a-8d3e-4c1b-9a7f-000000000004",
      type: "otp",
      label: "Telefon",
      createdAt: "2026-09-21T13:10:41.130Z",
    });
  });

  it("proves sudo with a password or a code and returns the opaque grant", async () => {
    const { client, calls } = transport(() => json(sudoGrantFixture));
    const byPassword = await client.sudoPassword(bearer, { password: "hunter2-but-longer" });
    const byCode = await client.sudoTotp(bearer, { code: "123456" });
    expect(byPassword).toEqual({
      sudoToken: sudoGrantFixture.sudoToken,
      expiresAt: new Date("2026-09-21T13:15:18Z"),
    });
    expect(byCode).toEqual(byPassword);
    expect(calls.map((call) => [call.url.replace(base, ""), call.body])).toEqual([
      ["/sudo/password", JSON.stringify({ password: "hunter2-but-longer" })],
      ["/sudo/totp", JSON.stringify({ code: "123456" })],
    ]);
    expect(calls.every((call) => call.headers.get("x-sky-sudo") === null)).toBe(true);
  });

  it("relays passkey assertion options and forwards the browser assertion for sudo", async () => {
    const { client, calls } = transport((recorded) => {
      if (recorded.url.endsWith("/sudo/webauthn/options")) return json(assertionOptionsFixture);
      if (recorded.url.endsWith("/sudo/webauthn/verify")) return json(sudoGrantFixture);
      throw new Error(`unexpected ${recorded.url}`);
    });
    const options = await client.sudoWebauthnOptions(bearer);
    expect(options).toEqual(assertionOptionsFixture);
    const grant = await client.sudoWebauthnVerify(bearer, {
      ...assertionFixture,
      authenticatorAttachment: "platform",
      clientExtensionResults: { appid: true, injected: "page-data" },
    } as never);
    expect(grant).toEqual({
      sudoToken: sudoGrantFixture.sudoToken,
      expiresAt: new Date("2026-09-21T13:15:18Z"),
    });
    // Exactly the sudo contract's members: no attachment (registration only), no extension results.
    expect(calls.map((call) => [call.method, call.url.replace(base, ""), call.body])).toEqual([
      ["POST", "/sudo/webauthn/options", null],
      ["POST", "/sudo/webauthn/verify", JSON.stringify({
        id: assertionFixture.id,
        rawId: assertionFixture.rawId,
        type: "public-key",
        response: assertionFixture.response,
      })],
    ]);
    expect(Object.keys(JSON.parse(calls[1]!.body!))).toEqual(["id", "rawId", "type", "response"]);
    expect(Object.keys(JSON.parse(calls[1]!.body!).response)).toEqual(["clientDataJSON", "authenticatorData", "signature", "userHandle"]);
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    expect(calls[1]?.headers.get("content-type")).toBe("application/json");
    expect(calls.every((call) => call.headers.get("x-sky-sudo") === null)).toBe(true);
  });

  it("accepts ceremony bodies above the 8 KB default up to the documented member bounds", async () => {
    const { client, request } = transport(() => json(sudoGrantFixture));
    const large = { ...assertionFixture, response: { ...assertionFixture.response, clientDataJSON: "A".repeat(8_000) } };
    await expect(client.sudoWebauthnVerify(bearer, large)).resolves.toMatchObject({ sudoToken: sudoGrantFixture.sudoToken });
    const maximal = {
      ...assertionFixture,
      response: {
        ...assertionFixture.response,
        clientDataJSON: "A".repeat(8_192),
        authenticatorData: "B".repeat(8_192),
        signature: "C".repeat(4_096),
        userHandle: "D".repeat(1_024),
      },
      id: "E".repeat(1_366),
      rawId: "E".repeat(1_366),
    };
    await expect(client.sudoWebauthnVerify(bearer, maximal)).resolves.toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(Buffer.byteLength(String(request.mock.calls[1]?.[1]?.body), "utf8")).toBeGreaterThan(8 * 1_024);
    expect(Buffer.byteLength(String(request.mock.calls[1]?.[1]?.body), "utf8")).toBeLessThanOrEqual(64 * 1_024);
  });

  it("relays passkey creation options under sudo and registers the browser attestation with its label", async () => {
    const { client, calls } = transport((recorded) => {
      if (recorded.url.endsWith("/credentials/webauthn/options")) return json(registrationOptionsFixture);
      if (recorded.url.endsWith("/credentials/webauthn/register")) return json(passkeyCredentialFixture, 201);
      throw new Error(`unexpected ${recorded.url}`);
    });
    const options = await client.webauthnRegistrationOptions(sudo);
    expect(options).toEqual(registrationOptionsFixture);
    const credential = await client.registerPasskey(sudo, { attestation: attestationFixture, label: " iPhone " });
    expect(credential).toEqual({
      id: "2f0c5b4a-8d3e-4c1b-9a7f-000000000005",
      type: "webauthn-passwordless",
      label: "iPhone",
      createdAt: "2026-09-21T13:12:00.000Z",
      transports: ["internal", "hybrid"],
    });
    expect(calls.map((call) => [call.method, call.url.replace(base, "")])).toEqual([
      ["POST", "/credentials/webauthn/options"],
      ["POST", "/credentials/webauthn/register"],
    ]);
    expect(calls[0]?.body).toBeNull();
    expect(calls[0]?.headers.get("content-type")).toBeNull();
    // Exactly the registration contract's members plus the label: no client extension results.
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toEqual({
      id: attestationFixture.id,
      rawId: attestationFixture.rawId,
      type: "public-key",
      response: {
        clientDataJSON: attestationFixture.response.clientDataJSON,
        attestationObject: attestationFixture.response.attestationObject,
        transports: ["internal", "hybrid"],
      },
      authenticatorAttachment: "platform",
      label: "iPhone",
    });
    expect(Object.keys(body)).toEqual(["id", "rawId", "type", "response", "authenticatorAttachment", "label"]);
    expect(calls[1]!.body).not.toContain("credProps");
    for (const call of calls) {
      expect(call.headers.get("x-sky-sudo")).toBe("opaque-sudo-token");
      expect(call.headers.get("authorization")).toBe("Bearer server-held-user-token");
    }
  });

  it("forwards a minimal attestation without transports or attachment and bounds the ceremony body", async () => {
    const { client, calls } = transport(() => json(passkeyCredentialFixture, 201));
    const minimal = {
      id: attestationFixture.id,
      rawId: attestationFixture.rawId,
      type: "public-key" as const,
      response: {
        clientDataJSON: attestationFixture.response.clientDataJSON,
        attestationObject: "A".repeat(40_000),
      },
      authenticatorAttachment: null,
    };
    await client.registerPasskey(sudo, { attestation: minimal as never, label: "Anahtar" });
    const body = JSON.parse(calls[0]!.body!);
    expect(Object.keys(body)).toEqual(["id", "rawId", "type", "response", "label"]);
    expect(Object.keys(body.response)).toEqual(["clientDataJSON", "attestationObject"]);
    expect(Buffer.byteLength(calls[0]!.body!, "utf8")).toBeGreaterThan(8 * 1_024);
  });

  it("rejects malformed browser attestations and labels before contacting the extension", async () => {
    const { client, request } = transport(() => json(passkeyCredentialFixture, 201));
    const malformed: Array<[unknown, string]> = [
      [{ ...attestationFixture, rawId: "different" }, "iPhone"],
      [{ ...attestationFixture, type: "public-key-credential" }, "iPhone"],
      [{ ...attestationFixture, response: { ...attestationFixture.response, attestationObject: "" } }, "iPhone"],
      [{ ...attestationFixture, response: { ...attestationFixture.response, attestationObject: "not base64url!" } }, "iPhone"],
      [{ ...attestationFixture, response: { ...attestationFixture.response, attestationObject: "A".repeat(48_001) } }, "iPhone"],
      [{ ...attestationFixture, response: { ...attestationFixture.response, transports: ["Internal!"] } }, "iPhone"],
      [{ ...attestationFixture, response: { ...attestationFixture.response, transports: "internal" } }, "iPhone"],
      [{ ...attestationFixture, authenticatorAttachment: "roaming" }, "iPhone"],
      [{ ...attestationFixture, response: null }, "iPhone"],
      ["attestation", "iPhone"],
      [attestationFixture, ""],
      [attestationFixture, " ".repeat(4)],
      [attestationFixture, "x".repeat(65)],
    ];
    for (const [attestation, label] of malformed) {
      await expect(client.registerPasskey(sudo, { attestation: attestation as never, label }))
        .rejects.toBeInstanceOf(SkyAccountInvalidInputError);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on creation options that drift from the contract and ignores additive members", async () => {
    const excluded = registrationOptionsFixture.excludeCredentials[0]!;
    const drifted: unknown[] = [
      { ...registrationOptionsFixture, challenge: "" },
      { ...registrationOptionsFixture, rp: { id: "", name: "SKY LAB" } },
      { ...registrationOptionsFixture, user: { ...registrationOptionsFixture.user, id: "not base64url!" } },
      { ...registrationOptionsFixture, pubKeyCredParams: [] },
      { ...registrationOptionsFixture, pubKeyCredParams: [{ type: "public-key", alg: "ES256" }] },
      { ...registrationOptionsFixture, timeout: 0 },
      { ...registrationOptionsFixture, excludeCredentials: [excluded, excluded] },
      { ...registrationOptionsFixture, excludeCredentials: [{ ...excluded, transports: ["Internal!"] }] },
      { ...registrationOptionsFixture, authenticatorSelection: { residentKey: "always" } },
      { ...registrationOptionsFixture, authenticatorSelection: null },
      { ...registrationOptionsFixture, attestation: "unknown" },
      { ...registrationOptionsFixture, extensions: { credProps: false } },
      Object.fromEntries(Object.entries(registrationOptionsFixture).filter(([key]) => key !== "extensions")),
      Object.fromEntries(Object.entries(registrationOptionsFixture).filter(([key]) => key !== "user")),
    ];
    for (const body of drifted) {
      const { client } = transport(() => json(body));
      await expect(client.webauthnRegistrationOptions(sudo)).rejects.toBeInstanceOf(SkyAccountContractError);
    }
    const { client } = transport(() => json({
      ...registrationOptionsFixture,
      hints: ["client-device"],
      excludeCredentials: [{ ...excluded, aaguid: "00000000-0000-0000-0000-000000000000" }],
      authenticatorSelection: { ...registrationOptionsFixture.authenticatorSelection, legacy: true },
    }));
    await expect(client.webauthnRegistrationOptions(sudo)).resolves.toEqual(registrationOptionsFixture);
    const { timeout: _timeout, attestation: _attestation, ...optional } = registrationOptionsFixture;
    void _timeout;
    void _attestation;
    const bare = transport(() => json(optional));
    const parsed = await bare.client.webauthnRegistrationOptions(sudo);
    expect("timeout" in parsed).toBe(false);
    expect("attestation" in parsed).toBe(false);
  });

  it("rejects malformed browser assertions before contacting the extension", async () => {
    const { client, request } = transport(() => json(sudoGrantFixture));
    const malformed: unknown[] = [
      { ...assertionFixture, rawId: "different" },
      { ...assertionFixture, type: "public-key-credential" },
      { ...assertionFixture, id: "not base64url!" },
      { ...assertionFixture, response: { ...assertionFixture.response, signature: "" } },
      { ...assertionFixture, response: { ...assertionFixture.response, clientDataJSON: "A" } },
      { ...assertionFixture, response: { ...assertionFixture.response, userHandle: 42 } },
      { ...assertionFixture, clientExtensionResults: "yes" },
      { ...assertionFixture, response: null },
      "assertion",
    ];
    for (const body of malformed) {
      await expect(client.sudoWebauthnVerify(bearer, body as never)).rejects.toBeInstanceOf(SkyAccountInvalidInputError);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed on assertion options that drift from the contract", async () => {
    const credential = assertionOptionsFixture.allowCredentials[0]!;
    const drifted: unknown[] = [
      { ...assertionOptionsFixture, challenge: "" },
      { ...assertionOptionsFixture, challenge: "not base64url!" },
      { ...assertionOptionsFixture, rpId: "" },
      { ...assertionOptionsFixture, userVerification: "optional" },
      { ...assertionOptionsFixture, timeout: 0 },
      { ...assertionOptionsFixture, timeout: "90000" },
      { ...assertionOptionsFixture, allowCredentials: [{ ...credential, type: "public-key-credential" }] },
      { ...assertionOptionsFixture, allowCredentials: [credential, credential] },
      { ...assertionOptionsFixture, allowCredentials: [{ ...credential, transports: ["Internal!"] }] },
      { ...assertionOptionsFixture, allowCredentials: null },
      Object.fromEntries(Object.entries(assertionOptionsFixture).filter(([key]) => key !== "challenge")),
    ];
    for (const body of drifted) {
      const { client } = transport(() => json(body));
      await expect(client.sudoWebauthnOptions(bearer)).rejects.toBeInstanceOf(SkyAccountContractError);
    }
    const { client } = transport(() => json({
      ...assertionOptionsFixture,
      extensions: { appid: "https://e.yildizskylab.com" },
      allowCredentials: [{ ...credential, aaguid: "00000000-0000-0000-0000-000000000000" }],
    }));
    await expect(client.sudoWebauthnOptions(bearer)).resolves.toEqual(assertionOptionsFixture);
  });

  it("pins both documented statuses of the shared WebAuthn problem codes", async () => {
    for (const status of [400, 401]) {
      const { client } = transport(() => json(
        { ...problemsFixture.webauthn_invalid, status },
        status,
        "application/problem+json",
      ));
      await expect(client.sudoWebauthnVerify(bearer, assertionFixture)).rejects.toMatchObject({
        code: "webauthn_invalid",
        status,
      });
    }
    const { client } = transport(() => json(
      { ...problemsFixture.webauthn_invalid, status: 403 },
      403,
      "application/problem+json",
    ));
    await expect(client.sudoWebauthnVerify(bearer, assertionFixture)).rejects.toBeInstanceOf(SkyAccountContractError);
    const mismatched = transport(() => json(problemsFixture.webauthn_invalid, 400, "application/problem+json"));
    await expect(mismatched.client.sudoWebauthnVerify(bearer, assertionFixture)).rejects.toBeInstanceOf(SkyAccountContractError);
  });

  it.each(Object.keys(problemsFixture) as Array<keyof typeof problemsFixture>)(
    "maps the %s problem into a typed SkyAccountProblem",
    async (code) => {
      const expected = problemsFixture[code];
      const { client } = transport(() => problem(code));
      const rejection = client.identity(bearer);
      await expect(rejection).rejects.toBeInstanceOf(SkyAccountProblem);
      await expect(rejection).rejects.toMatchObject({
        code,
        status: expected.status,
        detail: expected.detail,
        retryAfter: "retryAfter" in expected ? expected.retryAfter : null,
        field: "field" in expected ? expected.field : null,
        policy: "policy" in expected ? expected.policy : null,
        params: "params" in expected ? expected.params : [],
        availableAt: "availableAt" in expected ? new Date(expected.availableAt) : null,
      });
      await expect(rejection).rejects.not.toThrow(new RegExp(expected.detail.slice(0, 12)));
    },
  );

  it("prefers the Retry-After header when the body omits retryAfter", async () => {
    const withoutBodyHint = { ...problemsFixture.rate_limited };
    delete (withoutBodyHint as { retryAfter?: number }).retryAfter;
    const { client } = transport(() => new Response(JSON.stringify(withoutBodyHint), {
      status: 429,
      headers: { "content-type": "application/problem+json", "retry-after": "120" },
    }));
    await expect(client.sudoTotp(bearer, { code: "000000" })).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfter: 120,
    });
  });

  it("fails closed on problem bodies that drift from the pinned code table", async () => {
    const drifted: Array<[number, unknown]> = [
      [401, { ...problemsFixture.sudo_required, code: "sudo_needed", type: "tag:yildizskylab.com,2026:sky-account:sudo_needed" }],
      [428, problemsFixture.sudo_required],
      [401, { ...problemsFixture.sudo_required, status: 403 }],
      [401, { ...problemsFixture.sudo_required, type: "https://attacker.invalid/sudo_required" }],
      [401, { ...problemsFixture.sudo_required, detail: 42 }],
      [401, { ...problemsFixture.sudo_required, detail: "x".repeat(2_049) }],
      [429, { ...problemsFixture.rate_limited, retryAfter: -1 }],
      [409, { ...problemsFixture.username_cooldown, availableAt: "tomorrow" }],
      [400, { ...problemsFixture.password_policy, params: [{ nested: true }] }],
      [401, "sudo_required"],
    ];
    for (const [status, body] of drifted) {
      const { client } = transport(() => json(body, status, "application/problem+json"));
      await expect(client.identity(bearer)).rejects.toBeInstanceOf(SkyAccountContractError);
    }
  });

  it("treats non-problem failures as unavailable or contract errors without echoing bodies", async () => {
    const cases: Array<[Response | Error, unknown]> = [
      [new Response("<html>bad gateway secret-detail</html>", { status: 502 }), SkyAccountUnavailableError],
      [new Response(null, { status: 503 }), SkyAccountUnavailableError],
      [new Response(null, { status: 504 }), SkyAccountUnavailableError],
      [new Error("socket hang up secret-detail"), SkyAccountUnavailableError],
      [new Response("Unsupported Media Type secret-detail", { status: 415 }), SkyAccountContractError],
      [new Response(JSON.stringify({ error: "secret-detail" }), { status: 401, headers: { "content-type": "application/json" } }), SkyAccountContractError],
      [json({ ...identityFixture, sub: 42, secretField: "secret-detail" }), SkyAccountContractError],
      [json(identityFixture, 201), SkyAccountContractError],
      [new Response("not json secret-detail", { status: 200, headers: { "content-type": "application/json" } }), SkyAccountContractError],
      [new Response(JSON.stringify(identityFixture), { status: 200, headers: { "content-type": "text/plain" } }), SkyAccountContractError],
    ];
    for (const [outcome, ErrorType] of cases) {
      const { client } = transport(() => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const rejection = client.identity(bearer);
      await expect(rejection).rejects.toBeInstanceOf(ErrorType as new () => Error);
      await expect(rejection).rejects.not.toThrow(/secret-detail/);
    }
  });

  it("rejects an oversized success body before parsing", async () => {
    const { client } = transport(() => json({
      ...identityFixture,
      firstName: "x".repeat(70 * 1_024),
    }));
    await expect(client.identity(bearer)).rejects.toBeInstanceOf(SkyAccountContractError);
  });

  it("fails closed on identity payloads whose documented members drift from v1", async () => {
    const credential = identityFixture.credentials.totp[0]!;
    const drifted: unknown[] = [
      { ...identityFixture, primary: "work" },
      { ...identityFixture, sub: "" },
      { ...identityFixture, verifiedYtu: "yes" },
      { ...identityFixture, usernameChangeAvailableAt: "soon" },
      { ...identityFixture, credentials: { ...identityFixture.credentials, password: "yes" } },
      { ...identityFixture, credentials: { ...identityFixture.credentials, totp: [{ ...credential, type: "password" }] } },
      { ...identityFixture, credentials: { ...identityFixture.credentials, totp: [{ ...credential, createdAt: "yesterday" }] } },
      { ...identityFixture, credentials: { ...identityFixture.credentials, totp: [credential, credential] } },
      { ...identityFixture, credentials: { ...identityFixture.credentials, passkeys: [credential] } },
      Object.fromEntries(Object.entries(identityFixture).filter(([key]) => key !== "nameLocked")),
      Object.fromEntries(Object.entries(identityFixture).filter(([key]) => key !== "credentials")),
    ];
    for (const body of drifted) {
      const { client } = transport(() => json(body));
      await expect(client.identity(bearer)).rejects.toBeInstanceOf(SkyAccountContractError);
    }
  });

  it("ignores additive members of later extension releases while keeping the v1 fields strict", async () => {
    const passkey = identityFixture.credentials.passkeys[0]!;
    const { client } = transport(() => json({
      ...identityFixture,
      emailChange: { pendingAddress: "new@example.invalid", requestedAt: "2026-09-21T13:00:00Z" },
      credentials: {
        ...identityFixture.credentials,
        webauthnPolicy: { rpId: "yildizskylab.com" },
        passkeys: [{ ...passkey, transports: ["internal", "hybrid"], aaguid: "00000000-0000-0000-0000-000000000000" }],
      },
    }));
    const identity = await client.identity(bearer);
    expect(identity.credentials.passkeys).toEqual([{
      id: passkey.id,
      type: "webauthn-passwordless",
      label: "MacBook",
      createdAt: passkey.createdAt,
      transports: ["internal", "hybrid"],
    }]);
    expect(Object.keys(identity).sort()).toEqual([
      "credentials", "email", "emailVerified", "firstName", "lastName", "nameLocked", "personalEmail",
      "primary", "schoolEmail", "sub", "username", "usernameChangeAvailableAt", "verifiedYtu",
    ]);
    expect(Object.keys(identity.credentials).sort()).toEqual(["passkeys", "password", "totp"]);
    expect(JSON.stringify(identity)).not.toContain("aaguid");
    expect(JSON.stringify(identity)).not.toContain("webauthnPolicy");
  });

  it("keeps passkey transports strict and never copies them onto OTP rows", async () => {
    const passkey = identityFixture.credentials.passkeys[0]!;
    const totp = identityFixture.credentials.totp[0]!;
    const invalid = transport(() => json({
      ...identityFixture,
      credentials: { ...identityFixture.credentials, passkeys: [{ ...passkey, transports: ["USB!"] }] },
    }));
    await expect(invalid.client.identity(bearer)).rejects.toBeInstanceOf(SkyAccountContractError);
    const otp = transport(() => json({
      ...identityFixture,
      credentials: { ...identityFixture.credentials, totp: [{ ...totp, transports: ["internal"] }] },
    }));
    const identity = await otp.client.identity(bearer);
    expect(identity.credentials.totp[0]).toEqual({ id: totp.id, type: "otp", label: "Telefon", createdAt: totp.createdAt });
    expect(identity.credentials.passkeys[0]).not.toHaveProperty("transports");
  });

  it("fails closed on sudo grants and TOTP setups that drift from the contract", async () => {
    for (const body of [
      { ...sudoGrantFixture, sudoToken: "" },
      { ...sudoGrantFixture, sudoToken: "not a token" },
      { ...sudoGrantFixture, expiresAt: "2026-09-21 13:15" },
      { sudoToken: sudoGrantFixture.sudoToken },
    ]) {
      const { client } = transport(() => json(body));
      await expect(client.sudoPassword(bearer, { password: "hunter2-but-longer" }))
        .rejects.toBeInstanceOf(SkyAccountContractError);
    }
    for (const body of [
      { ...totpSetupFixture, otpauthUri: "https://attacker.invalid/?secret=x" },
      { ...totpSetupFixture, secret: "not-base32!" },
      { ...totpSetupFixture, policy: { ...totpSetupFixture.policy, type: "hotp" } },
      { ...totpSetupFixture, policy: { ...totpSetupFixture.policy, digits: 7 } },
      { ...totpSetupFixture, policy: null },
    ]) {
      const { client } = transport(() => json(body));
      await expect(client.totpSetup(sudo)).rejects.toBeInstanceOf(SkyAccountContractError);
    }
  });

  it("accepts additive members on sudo grants and TOTP setups without copying them", async () => {
    const grant = transport(() => json({ ...sudoGrantFixture, amr: ["pwd"] }));
    await expect(grant.client.sudoPassword(bearer, { password: "hunter2-but-longer" })).resolves.toEqual({
      sudoToken: sudoGrantFixture.sudoToken,
      expiresAt: new Date("2026-09-21T13:15:18Z"),
    });
    const setup = transport(() => json({
      ...totpSetupFixture,
      qrDataUrl: "data:image/png;base64,AAAA",
      policy: { ...totpSetupFixture.policy, lookAheadWindow: 1 },
    }));
    const parsed = await setup.client.totpSetup(sudo);
    expect(Object.keys(parsed).sort()).toEqual(["expiresAt", "otpauthUri", "policy", "secret", "setupHandle"]);
    expect(parsed.policy).toEqual({ type: "totp", algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("validates its own inputs before sending anything", async () => {
    const { client, request } = transport(() => json(identityFixture));
    const invalid: Array<() => Promise<unknown>> = [
      () => client.patchName(bearer, { firstName: "", lastName: "Lovelace" }),
      () => client.patchName(bearer, { firstName: "A".repeat(65), lastName: "Lovelace" }),
      () => client.patchName(bearer, { firstName: "Ada", lastName: " ".repeat(3) }),
      () => client.changeUsername(sudo, { username: " " }),
      () => client.changeUsername(sudo, { username: "ab" }),
      () => client.changeUsername(sudo, { username: "a".repeat(31) }),
      () => client.changeUsername(sudo, { username: "ada lovelace" }),
      () => client.changeUsername(sudo, { username: "ada-lovelace" }),
      () => client.changeUsername(sudo, { username: "ada@lovelace" }),
      () => client.sudoPassword(bearer, { password: "" }),
      () => client.sudoTotp(bearer, { code: "12ab" }),
      () => client.sudoTotp(bearer, { code: "123" }),
      () => client.changePassword(sudo, { newPassword: "", logoutOtherSessions: true }),
      () => client.totpConfirm(sudo, { setupHandle: "handle with spaces", code: "123456", label: "Telefon" }),
      () => client.totpConfirm(sudo, { setupHandle: "handle", code: "123456", label: "" }),
      () => client.deleteCredential(sudo, "../credentials"),
      () => client.deleteCredential({ ...sudo, sudoToken: "" }, "2f0c5b4a-8d3e-4c1b-9a7f-000000000004"),
      () => client.identity({ accessToken: "" }),
    ];
    for (const attempt of invalid) {
      await expect(attempt()).rejects.toBeInstanceOf(SkyAccountInvalidInputError);
    }
    expect(request).not.toHaveBeenCalled();

    await client.patchName(bearer, { firstName: ` ${"A".repeat(64)} `, lastName: "L" });
    await client.changeUsername(sudo, { username: " Ada.Lovelace_01 " });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ firstName: "A".repeat(64), lastName: "L" });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ username: "ada.lovelace_01" });
  });

  it("never retries a request", async () => {
    let attempts = 0;
    const { client } = transport(() => {
      attempts += 1;
      throw new Error("connection reset");
    });
    await expect(client.changePassword(sudo, { newPassword: "correct horse battery staple", logoutOtherSessions: false }))
      .rejects.toBeInstanceOf(SkyAccountUnavailableError);
    expect(attempts).toBe(1);
  });

  it("exposes the problem code as a stable branching key", () => {
    const code: SkyAccountProblemCode = "name_locked";
    const error = new SkyAccountProblem({
      code,
      status: 403,
      detail: "Doğrulanmış YTÜ hesabının adı değiştirilemez.",
      retryAfter: null,
      field: null,
      policy: null,
      params: [],
      availableAt: null,
    });
    expect(error.message).toBe("sky-account v1 answered 403 name_locked.");
    expect(error.name).toBe("SkyAccountProblem");
    expect(error.code).toBe("name_locked");
  });
});
