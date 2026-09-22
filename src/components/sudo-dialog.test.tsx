import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assertionOptionsFixture from "../../tests/fixtures/sky-account-v1-webauthn-assertion-options.json";
import { SudoDialog } from "@/components/sudo-dialog";
import { base64UrlToBuffer } from "@/lib/webauthn";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const secretPassword = "hunter2-correct-horse";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers });
}

function methods(overrides: Partial<{
  methods: string[];
  fallback: "microsoft" | null;
  active: { method: string; expiresAt: string } | null;
  csrfToken: string;
}> = {}) {
  return json({
    methods: ["password", "passkey", "totp"],
    fallback: null,
    active: null,
    csrfToken: "session-bound-csrf",
    ...overrides,
  });
}

function requestOf(call: unknown[]) {
  const [url, init] = call as [string, RequestInit | undefined];
  return { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null };
}

beforeEach(() => {
  replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SudoDialog", () => {
  it("opens as a modal, loads only the person's methods and shows them as tabs in order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methods({ methods: ["totp", "password"] }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: "Kimliğini doğrula" });
    expect(dialog).toHaveAttribute("open");
    const tabs = await within(dialog).findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Parola", "Doğrulama kodu"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: "Parola" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Parola", { selector: "input" })).toHaveAttribute("type", "password");
    expect(within(dialog).getByLabelText("Parola", { selector: "input" })).toHaveAttribute("autocomplete", "current-password");
    expect(fetch).toHaveBeenCalledWith("/api/account/sudo/methods", { cache: "no-store", credentials: "same-origin" });
  });

  it("proves with the password, never keeps it, and reports the deadline", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods())
      .mockResolvedValueOnce(json({ method: "password", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    const input = await screen.findByLabelText("Parola", { selector: "input" });
    const submit = screen.getByRole("button", { name: "Doğrula" });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: secretPassword } });
    expect(submit).toBeEnabled();
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(onVerified).toHaveBeenCalledWith({ method: "password", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const proof = requestOf(request.mock.calls[1]!);
    expect(proof.url).toBe("/api/account/sudo/password");
    expect(proof.init).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-csrf-token": "session-bound-csrf", "content-type": "application/json" },
    });
    expect(proof.body).toEqual({ password: secretPassword });
    expect(input).toHaveValue("");
    expect(document.body.innerHTML).not.toContain(secretPassword);
  });

  it("proves with a verification code on the Doğrulama kodu tab, keyboard-switching between tabs", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods())
      .mockResolvedValueOnce(json({ method: "totp", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    const passwordTab = await screen.findByRole("tab", { name: "Parola" });
    passwordTab.focus();
    fireEvent.keyDown(passwordTab, { key: "End" });
    const totpTab = screen.getByRole("tab", { name: "Doğrulama kodu" });
    expect(totpTab).toHaveAttribute("aria-selected", "true");
    expect(totpTab).toHaveFocus();
    fireEvent.keyDown(totpTab, { key: "ArrowRight" });
    expect(passwordTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(passwordTab, { key: "ArrowLeft" });
    expect(totpTab).toHaveAttribute("aria-selected", "true");

    const input = screen.getByLabelText("Doğrulama kodu", { selector: "input" });
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    fireEvent.change(input, { target: { value: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Doğrula" }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledWith({ method: "totp", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const proof = requestOf(request.mock.calls[1]!);
    expect(proof.url).toBe("/api/account/sudo/totp");
    expect(proof.body).toEqual({ code: "123456" });
  });

  it("shows the server's Turkish detail for a wrong password and lets the person retry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["password"] }))
      .mockResolvedValueOnce(json({ error: "invalid_credentials", detail: "Parola veya doğrulama kodu yanlış." }, 401))
      .mockResolvedValueOnce(json({ method: "password", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    const input = await screen.findByLabelText("Parola", { selector: "input" });
    fireEvent.change(input, { target: { value: "wrong-password" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Parola veya doğrulama kodu yanlış.");
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("tab")).toHaveLength(1);

    fireEvent.change(input, { target: { value: secretPassword } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it("surfaces the lockout message and blocks attempts until the wait passes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["password"] }))
      .mockResolvedValueOnce(json(
        { error: "locked", detail: "Çok fazla hatalı deneme yapıldı. Hesabın geçici olarak kilitlendi.", retryAfter: 125 },
        423,
        { "retry-after": "125" },
      ));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);

    const input = await screen.findByLabelText("Parola", { selector: "input" });
    fireEvent.change(input, { target: { value: "wrong-password" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Hesabın geçici olarak kilitlendi.");
    expect(alert).toHaveTextContent("Yeniden denemek için bekle: 3 dakika.");
    expect(screen.getByRole("button", { name: "Doğrula" })).toBeDisabled();
    expect(input).toBeDisabled();
  });

  it("explains a rate limit with the Retry-After header when the body has no hint", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["totp"] }))
      .mockResolvedValueOnce(json({ error: "rate_limited", detail: "Çok fazla deneme yaptın. Biraz sonra yeniden dene." }, 429, { "retry-after": "45" }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);

    const input = await screen.findByLabelText("Doğrulama kodu", { selector: "input" });
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.submit(input.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Çok fazla deneme yaptın.");
    expect(alert).toHaveTextContent("45 saniye");
    expect(screen.getByRole("button", { name: "Doğrula" })).toBeDisabled();
  });

  it("runs the passkey ceremony with the relayed options and posts the serialized assertion", async () => {
    const credential = {
      id: assertionOptionsFixture.allowCredentials[0]!.id,
      rawId: base64UrlToBuffer(assertionOptionsFixture.allowCredentials[0]!.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: new TextEncoder().encode("{\"type\":\"webauthn.get\"}").buffer,
        authenticatorData: new Uint8Array([1, 2, 3]).buffer,
        signature: new Uint8Array([4, 5, 6]).buffer,
        userHandle: null,
      },
    };
    class FakePublicKeyCredential {}
    Object.setPrototypeOf(credential, FakePublicKeyCredential.prototype);
    vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
    const get = vi.fn().mockResolvedValue(credential);
    vi.stubGlobal("navigator", { ...navigator, credentials: { get } });
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["passkey"] }))
      .mockResolvedValueOnce(json(assertionOptionsFixture))
      .mockResolvedValueOnce(json({ method: "passkey", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Passkey ile doğrula" }));

    await waitFor(() => expect(onVerified).toHaveBeenCalledWith({ method: "passkey", expiresAt: "2026-09-21T13:15:18.000Z" }));
    expect(get).toHaveBeenCalledTimes(1);
    const publicKey = get.mock.calls[0]![0].publicKey as PublicKeyCredentialRequestOptions;
    expect(publicKey.rpId).toBe("yildizskylab.com");
    expect(publicKey.userVerification).toBe("required");
    expect(publicKey.challenge).toBeInstanceOf(ArrayBuffer);
    expect(publicKey.allowCredentials![0]!.id).toBeInstanceOf(ArrayBuffer);
    const options = requestOf(request.mock.calls[1]!);
    expect(options.url).toBe("/api/account/sudo/webauthn/options");
    expect(options.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": "session-bound-csrf" } });
    const verify = requestOf(request.mock.calls[2]!);
    expect(verify.url).toBe("/api/account/sudo/webauthn/verify");
    expect(verify.body).toEqual({
      assertion: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        response: {
          clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
          authenticatorData: "AQID",
          signature: "BAUG",
        },
      },
    });
  });

  it("tells the person when the passkey prompt was cancelled or unsupported", async () => {
    vi.stubGlobal("PublicKeyCredential", class {});
    const rejection = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", { ...navigator, credentials: { get: vi.fn().mockRejectedValue(rejection) } });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["passkey"] }))
      .mockResolvedValueOnce(json(assertionOptionsFixture));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Passkey ile doğrula" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Passkey doğrulaması tamamlanmadı");

    cleanup();
    vi.stubGlobal("navigator", { ...navigator, credentials: undefined });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(methods({ methods: ["passkey"] }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Passkey ile doğrula" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bu tarayıcı passkey doğrulamasını desteklemiyor");
  });

  it("offers the Microsoft re-authentication when no method exists, returning to the page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methods({ methods: [], fallback: "microsoft" }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "Microsoft ile yeniden doğrula" });
    const form = button.closest("form")!;
    expect(form).toHaveAttribute("action", "/api/account/sudo/reauthenticate");
    expect(form).toHaveAttribute("method", "post");
    expect(form.querySelector("input[name='csrfToken']")).toHaveValue("session-bound-csrf");
    expect(form.querySelector("input[name='returnTo']")).toHaveValue("/security");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText(/parola, passkey ya da doğrulama uygulaması tanımlı değil/)).toBeInTheDocument();
  });

  it("closes without a network call when a fresh proof already exists", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(methods({
      active: { method: "totp", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
    }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(expect.objectContaining({ method: "totp" })));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("redirects to login when the session is gone and retries a failed method load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "authentication_required" }, 401));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?returnTo=%2Fsecurity"));

    cleanup();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unavailable", detail: "Kimlik hizmetine şu anda ulaşılamıyor." }, 503))
      .mockResolvedValueOnce(methods({ methods: ["password"] }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Kimlik hizmetine şu anda ulaşılamıyor.");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByLabelText("Parola", { selector: "input" })).toBeInTheDocument();
  });

  it("traps focus, dismisses on Escape and through the close button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methods({ methods: ["password"] }));
    const onDismiss = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={onDismiss} />);

    const dialog = await screen.findByRole("dialog", { name: "Kimliğini doğrula" });
    const input = await within(dialog).findByLabelText("Parola", { selector: "input" });
    const close = within(dialog).getByRole("button", { name: "Pencereyi kapat" });
    expect(dialog).toHaveAttribute("aria-describedby");
    fireEvent.change(input, { target: { value: "x" } });
    const submit = within(dialog).getByRole("button", { name: "Doğrula" });
    submit.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("explains a disabled account without reloading, but reloads the CSRF proof on a plain 403", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["password"] }))
      .mockResolvedValueOnce(json({ error: "disabled", detail: "Hesabın devre dışı. Yönetim ekibiyle iletişime geç." }, 403))
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(methods({ methods: ["password"], csrfToken: "renewed-csrf" }))
      .mockResolvedValueOnce(json({ method: "password", expiresAt: "2026-09-21T13:15:18.000Z" }));
    const onVerified = vi.fn();
    render(<SudoDialog returnTo="/security" onVerified={onVerified} onDismiss={vi.fn()} />);

    const input = await screen.findByLabelText("Parola", { selector: "input" });
    fireEvent.change(input, { target: { value: secretPassword } });
    fireEvent.submit(input.closest("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Hesabın devre dışı. Yönetim ekibiyle iletişime geç.");
    expect(alert).toHaveAttribute("data-tone", "danger");
    expect(request).toHaveBeenCalledTimes(2);

    fireEvent.change(input, { target: { value: secretPassword } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Oturum bilgin yenilendi"));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    fireEvent.change(input, { target: { value: secretPassword } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect((request.mock.calls[4]![1] as RequestInit).headers).toMatchObject({ "x-csrf-token": "renewed-csrf" });
  });

  it("fails closed on a methods payload that drifts from the contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ methods: ["sms"], fallback: null, active: null, csrfToken: "c" }));
    render(<SudoDialog returnTo="/security" onVerified={vi.fn()} onDismiss={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Doğrulama yöntemlerin alınamadı");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});
