// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import identityFixture from "../../../tests/fixtures/sky-account-v1-identity.json";
import problemsFixture from "../../../tests/fixtures/sky-account-v1-problems.json";
import sudoGrantFixture from "../../../tests/fixtures/sky-account-v1-sudo-grant.json";
import totpCredentialFixture from "../../../tests/fixtures/sky-account-v1-totp-credential.json";
import totpSetupFixture from "../../../tests/fixtures/sky-account-v1-totp-setup.json";
import {
  SkyAccountContractError,
  SkyAccountHttpClient,
  SkyAccountInvalidInputError,
  SkyAccountProblem,
  SkyAccountUnavailableError,
  SKY_ACCOUNT_API_VERSION,
} from "@/server/sky-account/client";
import type { SkyAccountProblemCode } from "@/server/sky-account/client";

const issuer = new URL("https://e.yildizskylab.com/realms/e-skylab");
const base = "https://e.yildizskylab.com/realms/e-skylab/sky-account/v1";
const bearer = { accessToken: "server-held-user-token" };
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
    }]);
    expect(Object.keys(identity).sort()).toEqual([
      "credentials", "email", "emailVerified", "firstName", "lastName", "nameLocked", "personalEmail",
      "primary", "schoolEmail", "sub", "username", "usernameChangeAvailableAt", "verifiedYtu",
    ]);
    expect(Object.keys(identity.credentials).sort()).toEqual(["passkeys", "password", "totp"]);
    expect(JSON.stringify(identity)).not.toContain("transports");
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
