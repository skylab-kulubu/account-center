import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeCooldown, IdentityManager, parseIdentityPayload } from "@/components/identity-manager";

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

const csrfToken = "session-bound-csrf";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    nameLocked: true,
    username: "account-fixture",
    usernameChangeAvailableAt: null,
    verifiedYtu: true,
    schoolEmail: "ada@std.yildiz.edu.tr",
    email: "ada@std.yildiz.edu.tr",
    emailVerified: true,
    csrfToken,
    ...overrides,
  };
}

const unlocked = { nameLocked: false, verifiedYtu: false, schoolEmail: null, email: "ada@example.invalid" };

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

async function findNotice(text: string) {
  const detail = await screen.findByText(text);
  return detail.closest<HTMLElement>("[role='status']")!;
}

async function openNameForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Adı düzenle" }));
  return screen.findByRole("form", { name: "Adı düzenle" });
}

async function openUsernameForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Kullanıcı adını değiştir" }));
  return screen.findByRole("form", { name: "Kullanıcı adını değiştir" });
}

async function requestUsernameChange(username: string) {
  const form = await openUsernameForm();
  fireEvent.change(within(form).getByLabelText("Yeni kullanıcı adı"), { target: { value: username } });
  fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
  const dialog = await screen.findByRole("dialog", { name: "Kullanıcı adın değişsin mi?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Onayla ve doğrula" }));
  return form;
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

describe("IdentityManager", () => {
  it("locks the name of a Verified YTÜ account and shows the YTÜ and e-mail rows without leaking the CSRF proof", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload()));
    const { container } = render(<IdentityManager />);

    expect(await screen.findByRole("heading", { level: 2, name: "Ad soyad" })).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("YTÜ hesabından gelir; yönetim ekibi düzeltebilir.")).toBeInTheDocument();
    expect(screen.getByText("YTÜ kaydından")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adı düzenle" })).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "Kullanıcı adı" })).toBeInTheDocument();
    expect(screen.getByText("account-fixture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kullanıcı adını değiştir" })).toBeEnabled();

    expect(screen.getByRole("heading", { level: 2, name: "YTÜ durumu" })).toBeInTheDocument();
    expect(screen.getByText("Doğrulanmış YTÜ hesabı")).toBeInTheDocument();
    expect(screen.getByText(/ada@std\.yildiz\.edu\.tr adresiyle bağlı/)).toBeInTheDocument();
    expect(screen.getAllByText("Doğrulandı", { selector: ".status-badge" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "YTÜ hesabımı bağla" })).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "E-posta" })).toBeInTheDocument();
    expect(screen.getByText("Birincil e-posta")).toBeInTheDocument();
    expect(screen.getByText("Okul e-postası")).toBeInTheDocument();
    expect(screen.getByText("YTÜ hesabından gelir")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "E-posta ayarları" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledWith("/api/account/identity", { cache: "no-store", credentials: "same-origin" });
    expect(container.innerHTML).not.toContain(csrfToken);
    expect(container.querySelector("a[href='/email']")).toBeNull();
  });

  it("offers the name form and the disabled YTÜ link for an unverified account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload(unlocked)));
    render(<IdentityManager />);
    expect(await screen.findByRole("button", { name: "Adı düzenle" })).toBeEnabled();
    expect(screen.queryByText("YTÜ kaydından")).not.toBeInTheDocument();
    expect(screen.getByText("YTÜ hesabın bağlı değil")).toBeInTheDocument();
    const link = screen.getByRole("button", { name: "YTÜ hesabımı bağla" });
    expect(link).toBeDisabled();
    expect(link).toHaveAccessibleDescription("YTÜ hesabını bağlama yakında bu sayfaya gelecek.");
    expect(screen.getAllByText("Yakında").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Kayıtlı değil · YTÜ hesabından gelir; buradan değiştirilemez.")).toBeInTheDocument();
  });

  it("shows a retryable card when the identity cannot be read and redirects on 401", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unavailable", detail: "Kimlik hizmetine şu anda ulaşılamıyor." }, 503))
      .mockResolvedValueOnce(json({ username: 42 }))
      .mockResolvedValueOnce(json({ error: "authentication_required" }, 401));
    render(<IdentityManager />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Kimlik bilgileri yüklenemedi");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Kimlik bilgileri güvenle durduruldu");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login?returnTo=%2Fidentity"));
    expect(request).toHaveBeenCalledTimes(3);
  });

  describe("name", () => {
    it("patches the normalised name without Sudo mode, announces the result and re-reads the identity", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(unlocked)))
        .mockResolvedValueOnce(json({ coreSync: "synced" }))
        .mockResolvedValueOnce(json(payload({ ...unlocked, firstName: "Augusta Ada", lastName: "King" })));
      render(<IdentityManager />);
      const form = await openNameForm();
      const first = within(form).getByLabelText("Ad");
      const last = within(form).getByLabelText("Soyad");
      expect(first).toHaveValue("Ada");
      expect(first).toHaveAttribute("autocomplete", "given-name");
      expect(last).toHaveValue("Lovelace");
      fireEvent.change(first, { target: { value: "  Augusta   Ada " } });
      fireEvent.change(last, { target: { value: "King" } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));

      const notice = await findNotice("Adın güncellendi.");
      expect(notice).toHaveFocus();
      expect(screen.queryByText("Kulüp profilindeki adın daha sonra eşitlenecek.")).not.toBeInTheDocument();
      expect(sudo.ensureSudo).not.toHaveBeenCalled();
      const patched = recorded(request.mock.calls[1]!);
      expect(patched.url).toBe("/api/account/identity/name");
      expect(patched.init).toMatchObject({
        method: "PATCH",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      });
      expect(patched.body).toEqual({ firstName: "Augusta Ada", lastName: "King" });
      expect(request).toHaveBeenCalledTimes(3);
      expect(await screen.findByText("Augusta Ada King")).toBeInTheDocument();
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });

    it("adds the soft notice when the core shadow could not be updated", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(unlocked)))
        .mockResolvedValueOnce(json({ coreSync: "failed" }))
        .mockResolvedValueOnce(json(payload({ ...unlocked, lastName: "Byron" })));
      render(<IdentityManager />);
      const form = await openNameForm();
      fireEvent.change(within(form).getByLabelText("Soyad"), { target: { value: "Byron" } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      const notice = await findNotice("Adın güncellendi.");
      expect(notice).toHaveTextContent("Kulüp profili henüz eşitlenmedi");
      expect(notice).toHaveTextContent("Kulüp profilindeki adın daha sonra eşitlenecek.");
    });

    it("refuses invisible characters, empty fields and an unchanged name before any request", async () => {
      const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload(unlocked)));
      render(<IdentityManager />);
      const form = await openNameForm();
      const first = within(form).getByLabelText("Ad");
      fireEvent.change(first, { target: { value: "Ada​Augusta" } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Ad görünmez, biçimlendirme ya da kontrol karakteri içeremez.");
      expect(first).toHaveAttribute("aria-invalid", "true");
      expect(first).toHaveFocus();

      fireEvent.change(first, { target: { value: "" } });
      expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(form).getByRole("button", { name: "Adı kaydet" })).toBeDisabled();

      fireEvent.change(first, { target: { value: " Ada " } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Adında değişiklik yok.");
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("renders the SPI field rejection on the field and the lock answer as a notice with a fresh read", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(unlocked)))
        .mockResolvedValueOnce(json({ error: "invalid_name", detail: "Soyad boş olamaz.", field: "lastName" }, 400))
        .mockResolvedValueOnce(json({ error: "name_locked", detail: "Doğrulanmış YTÜ hesabının adı YTÜ kaydından gelir ve değiştirilemez." }, 403))
        .mockResolvedValueOnce(json(payload()));
      render(<IdentityManager />);
      const form = await openNameForm();
      fireEvent.change(within(form).getByLabelText("Soyad"), { target: { value: "Byron" } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Soyad boş olamaz.");
      expect(within(form).getByLabelText("Soyad")).toHaveFocus();

      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      const notice = await findNotice("Doğrulanmış YTÜ hesabının adı YTÜ kaydından gelir ve değiştirilemez.");
      expect(notice).toHaveTextContent("Ad değiştirilemedi");
      expect(await screen.findByText("YTÜ kaydından")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Adı düzenle" })).not.toBeInTheDocument();
    });

    it("reloads the CSRF proof after a plain 403 and maps a rate limit to a countdown", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(unlocked)))
        .mockResolvedValueOnce(json({ error: "forbidden" }, 403))
        .mockResolvedValueOnce(json(payload({ ...unlocked, csrfToken: "renewed-csrf" })))
        .mockResolvedValueOnce(json({ error: "rate_limited", detail: "Çok fazla deneme yaptın.", retryAfter: 90 }, 429));
      render(<IdentityManager />);
      const form = await openNameForm();
      fireEvent.change(within(form).getByLabelText("Soyad"), { target: { value: "Byron" } });
      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Oturum bilgin yenilendi. Lütfen yeniden dene.");
      await waitFor(() => expect(sudo.invalidateSudo).toHaveBeenCalled());

      fireEvent.click(within(form).getByRole("button", { name: "Adı kaydet" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent(/Çok fazla deneme yaptın\. Yeniden denemek için bekle: 2 dakika\./);
      expect(within(form).getByRole("button", { name: "Adı kaydet" })).toBeDisabled();
    });
  });

  describe("username", () => {
    it("lower-cases the input, states the consequences, then posts behind Sudo mode and re-reads", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(challenge, 428))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload({ username: "ada.lovelace" })));
      const { container } = render(<IdentityManager />);
      const form = await openUsernameForm();
      const input = within(form).getByLabelText("Yeni kullanıcı adı");
      expect(input).toHaveAttribute("autocapitalize", "none");
      expect(input).toHaveAttribute("maxlength", "30");
      fireEvent.change(input, { target: { value: "Ada.Lovelace" } });
      expect(input).toHaveValue("ada.lovelace");
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));

      const dialog = await screen.findByRole("dialog", { name: "Kullanıcı adın değişsin mi?" });
      expect(dialog).toHaveTextContent("Yeni kullanıcı adın ada.lovelace olacak.");
      expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "Giriş yaparken yeni adını kullanacaksın.",
        "Eski adın boşa çıkar ve başkası alabilir.",
        "Kullanıcı adını 14 günde bir değiştirebilirsin.",
      ]);
      expect(request).toHaveBeenCalledTimes(1);
      expect(sudo.ensureSudo).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(input).toHaveFocus();
      expect(request).toHaveBeenCalledTimes(1);

      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Onayla ve doğrula" }));
      const notice = await findNotice("Kullanıcı adın ada.lovelace olarak değiştirildi. Bundan sonra giriş yaparken bu adı kullan.");
      expect(notice).toHaveFocus();
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      const posts = request.mock.calls.filter((call) => call[0] === "/api/account/identity/username").map(recorded);
      expect(posts).toHaveLength(2);
      for (const post of posts) {
        expect(post.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": csrfToken } });
        expect(post.body).toEqual({ username: "ada.lovelace" });
      }
      expect(request).toHaveBeenCalledTimes(4);
      expect(await screen.findByText("ada.lovelace")).toBeInTheDocument();
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(container.innerHTML).not.toContain(csrfToken);
    });

    it("keeps invalid, unchanged and taken usernames on the field", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ username: "ada.lovelace" })))
        .mockResolvedValueOnce(json({ error: "username_taken", detail: "Bu kullanıcı adı kullanılıyor.", field: "username" }, 409));
      render(<IdentityManager />);
      const form = await openUsernameForm();
      const input = within(form).getByLabelText("Yeni kullanıcı adı");
      fireEvent.change(input, { target: { value: "ab" } });
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Kullanıcı adı en az 3 karakter olmalı.");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: "ada lovelace" } });
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent(/yalnız küçük harf/);

      fireEvent.change(input, { target: { value: "Ada.Lovelace" } });
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu zaten kullanıcı adın.");
      expect(request).toHaveBeenCalledTimes(1);

      fireEvent.change(input, { target: { value: "ada.byron" } });
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Onayla ve doğrula" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu kullanıcı adı kullanılıyor.");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveFocus();
      expect(screen.queryByText(/olarak değiştirildi/)).not.toBeInTheDocument();
    });

    it("explains the cooldown answer with the next allowed moment and keeps a dismissed sudo out of the page", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json({
          error: "username_cooldown",
          detail: "Kullanıcı adını 14 günde bir değiştirebilirsin.",
          retryAfter: 604_800,
          availableAt: "2099-09-28T13:10:41.000Z",
        }, 409))
        .mockResolvedValueOnce(json(challenge, 428));
      render(<IdentityManager />);
      const form = await requestUsernameChange("ada.lovelace");
      const alert = await within(form).findByRole("alert");
      expect(alert).toHaveTextContent("Kullanıcı adını 14 günde bir değiştirebilirsin.");
      expect(alert).toHaveTextContent(/en erken 28 Eylül 2099 16:10 tarihinde yeniden değiştirebilirsin \(\d+ gün sonra\)/);

      sudo.ensureSudo.mockResolvedValueOnce(false);
      fireEvent.click(within(form).getByRole("button", { name: "Devam et" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Onayla ve doğrula" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Kimliğini doğrulamadığın için değişiklik yapılmadı.");
    });

    it("disables the change while the server reports a running cooldown", async () => {
      const availableAt = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload({ usernameChangeAvailableAt: availableAt })));
      render(<IdentityManager />);
      const button = await screen.findByRole("button", { name: "Kullanıcı adını değiştir" });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(/Kullanıcı adını en erken .* tarihinde yeniden değiştirebilirsin \(3 gün sonra\)\./);
    });
  });

  it("words the cooldown in minutes, hours or days and drops one that already passed", () => {
    const now = new Date("2026-09-21T13:00:00Z");
    expect(describeCooldown(new Date("2026-09-21T13:20:00Z"), now)).toEqual({ relative: "20 dakika sonra", absolute: "21 Eylül 2026 16:20" });
    expect(describeCooldown(new Date("2026-09-21T18:30:00Z"), now)).toEqual({ relative: "6 saat sonra", absolute: "21 Eylül 2026 21:30" });
    expect(describeCooldown(new Date("2026-09-28T13:10:41Z"), now)).toEqual({ relative: "8 gün sonra", absolute: "28 Eylül 2026 16:10" });
    expect(describeCooldown(new Date("2026-09-21T12:59:59Z"), now)).toBeNull();
  });

  it("parses only a well-formed payload", () => {
    expect(parseIdentityPayload(payload())).toEqual(payload());
    expect(parseIdentityPayload(payload({ usernameChangeAvailableAt: "2026-09-28T13:10:41Z" }))).toMatchObject({
      usernameChangeAvailableAt: "2026-09-28T13:10:41Z",
    });
    for (const broken of [
      null,
      payload({ username: "" }),
      payload({ nameLocked: "yes" }),
      payload({ usernameChangeAvailableAt: "soon" }),
      payload({ email: 42 }),
      payload({ csrfToken: "" }),
      payload({ firstName: "x".repeat(256) }),
    ]) expect(parseIdentityPayload(broken)).toBeNull();
  });
});
