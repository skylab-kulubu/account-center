import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import attestationFixture from "../../tests/fixtures/sky-account-v1-webauthn-attestation.json";
import registrationOptionsFixture from "../../tests/fixtures/sky-account-v1-webauthn-registration-options.json";
import totpSetupFixture from "../../tests/fixtures/sky-account-v1-totp-setup.json";
import { SecurityManager } from "@/components/security-manager";
import { base64UrlToBuffer } from "@/lib/webauthn";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const sudo = vi.hoisted(() => ({
  ensureSudo: vi.fn<(options?: { challenged?: boolean }) => Promise<boolean>>(),
  invalidateSudo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock("@/components/sudo-provider", () => ({
  useSudo: () => ({ ensureSudo: sudo.ensureSudo, invalidateSudo: sudo.invalidateSudo, sudoExpiresAt: null }),
}));

const totpReference = "t".repeat(43);
const passkeyReference = "p".repeat(43);
const legacyReference = "l".repeat(43);
const csrfToken = "session-bound-csrf";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    password: true,
    totp: [{ reference: totpReference, label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" }],
    passkeys: [
      { reference: passkeyReference, label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z", transports: ["internal", "hybrid"] },
      { reference: legacyReference, label: null, createdAt: null, legacy: true },
    ],
    sudo: { methods: ["password", "passkey", "totp"], fallback: null, active: null },
    csrfToken,
    ...overrides,
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function noContent() {
  return new Response(null, { status: 204 });
}

type Recorded = { url: string; init: RequestInit; body: unknown };

function recorded(call: unknown[]): Recorded {
  const [url, init] = call as [string, RequestInit];
  return { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
}

const challenge = { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null };

/** The page-level completion notice (progress indicators also use `role="status"`). */
async function findNotice() {
  const heading = await screen.findByText("İşlem tamamlandı");
  return heading.closest<HTMLElement>("[role='status']")!;
}

beforeEach(() => {
  sudo.ensureSudo.mockReset();
  sudo.ensureSudo.mockResolvedValue(true);
  sudo.invalidateSudo.mockReset();
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SecurityManager", () => {
  it("renders the three sections from the inventory without leaking references", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload()));
    const { container } = render(<SecurityManager />);

    expect(await screen.findByRole("heading", { level: 2, name: "Parola" })).toBeInTheDocument();
    expect(screen.getByText("Tanımlı")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Parolayı değiştir" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Doğrulama uygulaması" })).toBeInTheDocument();
    expect(screen.getByText("Telefon")).toBeInTheDocument();
    expect(screen.getByText("Eklendi: 21 Eylül 2026")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Passkey’ler" })).toBeInTheDocument();
    expect(screen.getByText("MacBook")).toBeInTheDocument();
    expect(screen.getByText(/Eklendi: 1 Eylül 2026 · Bu cihaz · Telefon \/ QR/)).toBeInTheDocument();
    expect(screen.getByText(/Eski tür güvenlik anahtarı/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /— Kaldır$/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Doğrulama uygulaması ekle" })).toBeEnabled();
    expect(fetch).toHaveBeenCalledWith("/api/account/security", { cache: "no-store", credentials: "same-origin" });
    for (const reference of [totpReference, passkeyReference, legacyReference, csrfToken]) {
      expect(container.innerHTML).not.toContain(reference);
    }
  });

  it("shows the empty states and the set-password copy for a fresh account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload({ password: false, totp: [], passkeys: [] })));
    render(<SecurityManager />);
    expect(await screen.findByRole("button", { name: "Parola belirle" })).toBeInTheDocument();
    expect(screen.getByText("Tanımlı değil")).toBeInTheDocument();
    expect(screen.getByText("Tanımlı bir doğrulama uygulaması yok.")).toBeInTheDocument();
    expect(screen.getByText("Kayıtlı bir passkey yok.")).toBeInTheDocument();
    expect(screen.getByText("Hesabına ek bir giriş yöntemi eklemeni öneriyoruz.")).toBeInTheDocument();
  });

  it("shows a retryable card when the inventory cannot be read and redirects on 401", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unavailable", detail: "Kimlik hizmetine şu anda ulaşılamıyor." }, 503))
      .mockResolvedValueOnce(json({ sessions: [] }))
      .mockResolvedValueOnce(json({ error: "authentication_required" }, 401));
    render(<SecurityManager />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Güvenlik ayarları yüklenemedi");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Güvenlik ayarları güvenle durduruldu");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login?returnTo=%2Fsecurity"));
    expect(request).toHaveBeenCalledTimes(3);
  });

  describe("password", () => {
    it("asks for sudo first, checks the confirmation locally, posts once and re-reads the inventory", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload()));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Parolayı değiştir" }));
      await waitFor(() => expect(sudo.ensureSudo).toHaveBeenCalledTimes(1));

      const form = await screen.findByRole("form", { name: "Parolayı değiştir" });
      const password = within(form).getByLabelText("Yeni parola");
      const confirmation = within(form).getByLabelText("Yeni parola (tekrar)");
      const logoutOthers = within(form).getByRole("checkbox", { name: /Diğer cihazlardaki oturumları kapat/ });
      expect(password).toHaveAttribute("type", "password");
      expect(password).toHaveAttribute("autocomplete", "new-password");
      expect(logoutOthers).toBeChecked();
      expect(within(form).getByText("En az 8 karakter")).toBeInTheDocument();
      expect(within(form).getByText("Kullanıcı adın ya da e-posta adresin olamaz")).toBeInTheDocument();

      fireEvent.change(password, { target: { value: "correct horse battery" } });
      fireEvent.change(confirmation, { target: { value: "correct horse batter" } });
      expect(within(form).getByText("Parolalar birbiriyle aynı değil.")).toBeInTheDocument();
      expect(within(form).getByRole("button", { name: "Parolayı kaydet" })).toBeDisabled();
      fireEvent.change(confirmation, { target: { value: "correct horse battery" } });
      fireEvent.click(within(form).getByRole("button", { name: "Parolayı kaydet" }));

      const status = await findNotice();
      expect(status).toHaveTextContent("Parolan değiştirildi. Diğer cihazlardaki oturumlar kapatıldı.");
      expect(status).toHaveFocus();
      const posted = recorded(request.mock.calls[1]!);
      expect(posted.url).toBe("/api/account/security/password");
      expect(posted.init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      });
      expect(posted.body).toEqual({ newPassword: "correct horse battery", logoutOtherSessions: true });
      expect(request).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("form", { name: "Parolayı değiştir" })).not.toBeInTheDocument();
    });

    it("renders the realm policy detail and keeps the static hints", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ password: false })))
        .mockResolvedValueOnce(json({
          error: "password_policy",
          detail: "Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.",
          policy: "invalidPasswordMinLengthMessage",
          params: [12],
        }, 400));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Parola belirle" }));
      const form = await screen.findByRole("form", { name: "Parola belirle" });
      fireEvent.change(within(form).getByLabelText("Yeni parola"), { target: { value: "short-one" } });
      fireEvent.change(within(form).getByLabelText("Yeni parola (tekrar)"), { target: { value: "short-one" } });
      fireEvent.click(within(form).getByRole("button", { name: "Parolayı kaydet" }));

      expect(await within(form).findByRole("alert")).toHaveTextContent("Geçersiz Şifre: En az 12 karakter uzunluğunda olmalı.");
      expect(within(form).getByText("Yeni parola realm kurallarına uymuyor.")).toBeInTheDocument();
      expect(within(form).getByText("En az 8 karakter")).toBeInTheDocument();
      expect(within(form).getByLabelText("Yeni parola")).toHaveAttribute("aria-invalid", "true");
      expect(within(form).getByLabelText("Yeni parola (tekrar)")).toHaveValue("");
      expect(screen.queryByText("İşlem tamamlandı")).not.toBeInTheDocument();
    });

    it("retries once after a 428 challenge and explains the Microsoft-only gap", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(challenge, 428))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload()));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Parolayı değiştir" }));
      const form = await screen.findByRole("form", { name: "Parolayı değiştir" });
      fireEvent.change(within(form).getByLabelText("Yeni parola"), { target: { value: "correct horse battery" } });
      fireEvent.change(within(form).getByLabelText("Yeni parola (tekrar)"), { target: { value: "correct horse battery" } });
      fireEvent.click(within(form).getByRole("button", { name: "Parolayı kaydet" }));
      expect(await findNotice()).toHaveTextContent("Parolan değiştirildi.");
      expect(sudo.ensureSudo).toHaveBeenLastCalledWith({ challenged: true });
      expect(request.mock.calls.filter((call) => call[0] === "/api/account/security/password")).toHaveLength(2);

      cleanup();
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ password: false, totp: [], passkeys: [], sudo: { methods: [], fallback: "microsoft", active: { method: "reauth", expiresAt: "2026-09-21T13:15:18.000Z" } } })))
        .mockResolvedValueOnce(json({ ...challenge, reason: "spi_token_required", methods: [], fallback: "microsoft" }, 428));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Parola belirle" }));
      const setForm = await screen.findByRole("form", { name: "Parola belirle" });
      fireEvent.change(within(setForm).getByLabelText("Yeni parola"), { target: { value: "correct horse battery" } });
      fireEvent.change(within(setForm).getByLabelText("Yeni parola (tekrar)"), { target: { value: "correct horse battery" } });
      fireEvent.click(within(setForm).getByRole("button", { name: "Parolayı kaydet" }));
      expect(await within(setForm).findByRole("alert")).toHaveTextContent(/Microsoft doğrulaması bu sayfadaki işlemler için yakında yeterli olacak/);
    });

    it("keeps the form and the password out of the page after a dismissed sudo dialog", async () => {
      sudo.ensureSudo.mockResolvedValueOnce(false);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload()));
      const { container } = render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Parolayı değiştir" }));
      await waitFor(() => expect(sudo.ensureSudo).toHaveBeenCalled());
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(container.innerHTML).not.toContain("newPassword");
    });
  });

  describe("verification app", () => {
    it("starts the setup after sudo, draws the QR and manual key, confirms with the label and code", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ totp: [] })))
        .mockResolvedValueOnce(json(totpSetupFixture))
        .mockResolvedValueOnce(json({ credential: { reference: "n".repeat(43), label: "Telefon", createdAt: "2026-09-21T13:10:41.130Z" } }, 201))
        .mockResolvedValueOnce(json(payload()));
      const { container } = render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Doğrulama uygulaması ekle" }));

      const qr = await screen.findByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" });
      expect(qr.tagName).toBe("svg");
      expect(qr.getAttribute("aria-label")).not.toContain("secret");
      expect(screen.getByLabelText("Elle giriş anahtarı")).toHaveTextContent("OR4D E4DR NFXD KZTQ JZUF MSBS KR4G 2Z3B");
      expect(screen.getByText(/6 haneli kod üretir; kod 30 saniyede bir yenilenir/)).toBeInTheDocument();
      expect(container.innerHTML).not.toContain(totpSetupFixture.otpauthUri);
      expect(sudo.ensureSudo).toHaveBeenCalled();
      const setup = recorded(request.mock.calls[1]!);
      expect(setup.url).toBe("/api/account/security/totp/setup");
      expect(setup.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": csrfToken } });

      fireEvent.change(screen.getByLabelText("Uygulama adı"), { target: { value: " Telefon " } });
      const code = screen.getByLabelText("Uygulamadaki kod");
      expect(code).toHaveAttribute("inputmode", "numeric");
      expect(code).toHaveAttribute("autocomplete", "one-time-code");
      fireEvent.change(code, { target: { value: "123 456" } });
      fireEvent.click(screen.getByRole("button", { name: "Doğrula ve ekle" }));

      expect(await findNotice()).toHaveTextContent("Doğrulama uygulaması eklendi.");
      const confirm = recorded(request.mock.calls[2]!);
      expect(confirm.url).toBe("/api/account/security/totp/confirm");
      expect(confirm.body).toEqual({ setupHandle: totpSetupFixture.setupHandle, code: "123456", label: "Telefon" });
      expect(screen.getByText("Telefon")).toBeInTheDocument();
      expect(container.innerHTML).not.toContain(totpSetupFixture.secret);
    });

    it("keeps the setup on a wrong code, blocks duplicate labels locally and restarts an expired setup", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(totpSetupFixture))
        .mockResolvedValueOnce(json({ error: "invalid_code", detail: "Kod yanlış. Uygulamandaki güncel kodu gir." }, 400))
        .mockResolvedValueOnce(json({ error: "setup_expired", detail: "Kurulumun süresi doldu. Baştan başla." }, 400))
        .mockResolvedValueOnce(json({ ...totpSetupFixture, setupHandle: "second-handle" }));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Doğrulama uygulaması ekle" }));
      await screen.findByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" });

      const label = screen.getByLabelText("Uygulama adı");
      const code = screen.getByLabelText("Uygulamadaki kod");
      fireEvent.change(label, { target: { value: "Telefon" } });
      fireEvent.change(code, { target: { value: "000000" } });
      fireEvent.click(screen.getByRole("button", { name: "Doğrula ve ekle" }));
      expect(await screen.findByText("Aynı adda bir doğrulama uygulaması zaten var. Başka bir ad seç.")).toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(2);

      fireEvent.change(label, { target: { value: "Tablet" } });
      fireEvent.click(screen.getByRole("button", { name: "Doğrula ve ekle" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Kod yanlış. Uygulamandaki güncel kodu gir.");
      expect(screen.getByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" })).toBeInTheDocument();
      expect(code).toHaveValue("");

      fireEvent.change(code, { target: { value: "111111" } });
      fireEvent.click(screen.getByRole("button", { name: "Doğrula ve ekle" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Kurulumun süresi doldu. Baştan başla.");
      expect(recorded(request.mock.calls[3]!).body).toMatchObject({ setupHandle: totpSetupFixture.setupHandle });
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Baştan başla" }));
      await screen.findByRole("img", { name: "Doğrulama uygulaması kurulumu için QR kodu" });
      expect(recorded(request.mock.calls[4]!).url).toBe("/api/account/security/totp/setup");
    });
  });

  describe("passkeys", () => {
    it("disables the add button with an explanation when the browser cannot create passkeys", async () => {
      vi.stubGlobal("PublicKeyCredential", undefined);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload()));
      render(<SecurityManager />);
      const add = await screen.findByRole("button", { name: "Passkey ekle" });
      expect(add).toBeDisabled();
      expect(add).toHaveAccessibleDescription(/Bu tarayıcı passkey eklemeyi desteklemiyor/);
    });

    it("registers a passkey: label, sudo, options, platform ceremony, register", async () => {
      const credential = {
        id: attestationFixture.id,
        rawId: base64UrlToBuffer(attestationFixture.rawId),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: base64UrlToBuffer(attestationFixture.response.clientDataJSON),
          attestationObject: base64UrlToBuffer(attestationFixture.response.attestationObject),
          getTransports: () => ["internal", "hybrid"],
        },
        getClientExtensionResults: () => ({ credProps: { rk: true } }),
      };
      class FakePublicKeyCredential {}
      Object.setPrototypeOf(credential, FakePublicKeyCredential.prototype);
      vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
      const create = vi.fn().mockResolvedValue(credential);
      vi.stubGlobal("navigator", { ...navigator, credentials: { create, get: vi.fn() } });
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(registrationOptionsFixture))
        .mockResolvedValueOnce(json({ credential: { reference: "q".repeat(43), label: "iPhone", createdAt: "2026-09-21T13:12:00.000Z", transports: ["internal"] } }, 201))
        .mockResolvedValueOnce(json(payload({
          passkeys: [...payload().passkeys, { reference: "q".repeat(43), label: "iPhone", createdAt: "2026-09-21T13:12:00.000Z", transports: ["internal"] }],
        })));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Passkey ekle" }));

      const dialog = await screen.findByRole("dialog", { name: "Passkey ekle" });
      const label = within(dialog).getByLabelText("Passkey adı");
      fireEvent.change(label, { target: { value: "MacBook" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Passkey oluştur" }));
      expect(await within(dialog).findByText("Aynı adda bir passkey zaten var. Başka bir ad seç.")).toBeInTheDocument();
      expect(create).not.toHaveBeenCalled();

      fireEvent.change(label, { target: { value: "iPhone" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Passkey oluştur" }));
      expect(await findNotice()).toHaveTextContent("Passkey eklendi.");
      expect(sudo.ensureSudo).toHaveBeenCalled();
      const publicKey = create.mock.calls[0]![0].publicKey as PublicKeyCredentialCreationOptions;
      expect(publicKey.rp).toEqual({ id: "yildizskylab.com", name: "SKY LAB" });
      expect(publicKey.challenge).toBeInstanceOf(ArrayBuffer);
      expect(publicKey.user.id).toBeInstanceOf(ArrayBuffer);
      expect(publicKey.user.name).toBe("account-fixture");
      expect(publicKey.excludeCredentials![0]!.id).toBeInstanceOf(ArrayBuffer);
      expect(publicKey.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required" });
      const options = recorded(request.mock.calls[1]!);
      expect(options.url).toBe("/api/account/security/passkeys/options");
      expect(options.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": csrfToken } });
      const register = recorded(request.mock.calls[2]!);
      expect(register.url).toBe("/api/account/security/passkeys/register");
      expect(register.body).toEqual({
        attestation: {
          id: attestationFixture.id,
          rawId: attestationFixture.rawId,
          type: "public-key",
          response: attestationFixture.response,
          authenticatorAttachment: "platform",
        },
        label: "iPhone",
      });
      expect(JSON.stringify(register.body)).not.toContain("credProps");
      expect(screen.getByText("iPhone")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("explains a cancelled ceremony and the server's registration rejections", async () => {
      vi.stubGlobal("PublicKeyCredential", class {});
      const rejection = Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
      const create = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValueOnce(null);
      vi.stubGlobal("navigator", { ...navigator, credentials: { create, get: vi.fn() } });
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(registrationOptionsFixture))
        .mockResolvedValueOnce(json({ error: "webauthn_origin_not_allowed", detail: "Passkey doğrulaması izin verilmeyen bir adresten yapıldı." }, 400));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Passkey ekle" }));
      const dialog = await screen.findByRole("dialog", { name: "Passkey ekle" });
      fireEvent.change(within(dialog).getByLabelText("Passkey adı"), { target: { value: "Yeni" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Passkey oluştur" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Passkey oluşturma tamamlanmadı ya da zaman aşımına uğradı.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Passkey oluştur" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Passkey doğrulaması izin verilmeyen bir adresten yapıldı.");
    });
  });

  describe("removal", () => {
    it("confirms, warns about the last passkey without a password, and deletes by opaque reference", async () => {
      const single = payload({
        password: false,
        passkeys: [{ reference: passkeyReference, label: "MacBook", createdAt: "2026-09-01T08:00:00.000Z" }],
      });
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(single))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json({ ...single, passkeys: [] }));
      render(<SecurityManager />);
      const trigger = await screen.findByRole("button", { name: "MacBook — Kaldır" });
      fireEvent.click(trigger);

      const dialog = await screen.findByRole("dialog", { name: "Passkey kaldırılsın mı?" });
      expect(within(dialog).getByText(/“MacBook” kaldırılacak/)).toBeInTheDocument();
      expect(within(dialog).getByRole("note")).toHaveTextContent("Bu, hesabındaki son passkey.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(trigger).toHaveFocus();

      fireEvent.click(trigger);
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Kaldır" }));
      expect(await findNotice()).toHaveTextContent("Passkey kaldırıldı.");
      const deletion = recorded(request.mock.calls[1]!);
      expect(deletion.url).toBe(`/api/account/security/credentials/${passkeyReference}`);
      expect(deletion.init).toMatchObject({ method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      expect(screen.getByText("Kayıtlı bir passkey yok.")).toBeInTheDocument();
    });

    it("does not warn when a password exists and refreshes on a vanished credential", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json({ error: "credential_not_found", detail: "Kimlik bilgisi bulunamadı." }, 404))
        .mockResolvedValueOnce(json(payload({ totp: [] })));
      render(<SecurityManager />);
      fireEvent.click(await screen.findByRole("button", { name: "Telefon — Kaldır" }));
      const dialog = await screen.findByRole("dialog", { name: "Doğrulama uygulaması kaldırılsın mı?" });
      expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Kaldır" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Kimlik bilgisi bulunamadı.");
      await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
      });
      expect(screen.getByText("Tanımlı bir doğrulama uygulaması yok.")).toBeInTheDocument();
    });
  });
});
