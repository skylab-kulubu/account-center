import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailManager, parseEmailPayload } from "@/components/email-manager";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const sudo = vi.hoisted(() => ({
  ensureSudo: vi.fn<(options?: { challenged?: boolean }) => Promise<boolean>>(),
  invalidateSudo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/email",
}));

vi.mock("@/components/sudo-provider", () => ({
  useSudo: () => ({ ensureSudo: sudo.ensureSudo, invalidateSudo: sudo.invalidateSudo, sudoExpiresAt: null }),
}));

const csrfToken = "session-bound-csrf";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    email: "ada@std.yildiz.edu.tr",
    emailVerified: true,
    primary: "school",
    schoolEmail: "ada@std.yildiz.edu.tr",
    verifiedYtu: true,
    personalEmail: null,
    personalEmailVerified: false,
    csrfToken,
    ...overrides,
  };
}

const withPersonal = { personalEmail: "ada@example.com", personalEmailVerified: true };

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
const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();

async function findNotice(text: string | RegExp) {
  const detail = await screen.findByText(text);
  return detail.closest<HTMLElement>("[role='status']")!;
}

async function sendCode(address: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Kişisel e-posta ekle" }));
  const form = await screen.findByRole("form", { name: "Kişisel e-posta ekle" });
  fireEvent.change(within(form).getByLabelText("E-posta adresi"), { target: { value: address } });
  fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
  return form;
}

async function codeForm() {
  return screen.findByRole("form", { name: "Doğrulama kodunu gir" });
}

function enterCode(form: HTMLElement, code: string) {
  fireEvent.change(within(form).getByLabelText("Doğrulama kodu"), { target: { value: code } });
  fireEvent.click(within(form).getByRole("button", { name: "Doğrula" }));
}

beforeEach(() => {
  sudo.ensureSudo.mockReset();
  sudo.ensureSudo.mockResolvedValue(true);
  sudo.invalidateSudo.mockReset();
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseEmailPayload", () => {
  it("accepts the BFF payload and refuses anything outside it", () => {
    expect(parseEmailPayload(payload(withPersonal))).toEqual(payload(withPersonal));
    expect(parseEmailPayload(payload({ primary: "work" }))).toBeNull();
    expect(parseEmailPayload(payload({ personalEmail: 42 }))).toBeNull();
    expect(parseEmailPayload(payload({ verifiedYtu: "yes" }))).toBeNull();
    expect(parseEmailPayload(payload({ csrfToken: "" }))).toBeNull();
    expect(parseEmailPayload(null)).toBeNull();
  });
});

describe("EmailManager", () => {
  it("shows the verified school address, the personal address and the primary choice with the club-mail rule", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload(withPersonal)));
    const { container } = render(<EmailManager />);

    expect(await screen.findByRole("heading", { level: 2, name: "Okul e-postası" })).toBeInTheDocument();
    const school = screen.getByText("ada@std.yildiz.edu.tr", { selector: "strong" }).closest<HTMLElement>(".settings-row")!;
    expect(within(school).getByText("Doğrulandı")).toBeInTheDocument();
    expect(within(school).queryByRole("button")).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "Kişisel e-posta" })).toBeInTheDocument();
    const personal = screen.getByText("ada@example.com", { selector: "strong" }).closest<HTMLElement>(".settings-row")!;
    expect(within(personal).getByText("Doğrulandı")).toBeInTheDocument();
    expect(within(personal).getByRole("button", { name: "ada@example.com — Kaldır" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Kişisel e-posta ekle" })).not.toBeInTheDocument();

    const primary = screen.getByRole("group", { name: "Birincil e-posta" });
    expect(within(primary).getByRole("radio", { name: /Okul e-postası/ })).toBeChecked();
    expect(within(primary).getByRole("radio", { name: /Kişisel e-posta/ })).not.toBeChecked();
    expect(within(primary).getByRole("radio", { name: /Kişisel e-posta/ })).toBeEnabled();
    expect(screen.getByText("Kulüp postaları birincil adrese gider; iki adresle de giriş yapabilirsin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Birincil adresi kaydet" })).toBeDisabled();

    expect(fetch).toHaveBeenCalledWith("/api/account/email", { cache: "no-store", credentials: "same-origin" });
    expect(container.innerHTML).not.toContain(csrfToken);
  });

  it("offers only the addresses that exist and sends an unlinked school address to the YTÜ link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload({
      ...withPersonal,
      email: "ada@example.com",
      primary: "personal",
      verifiedYtu: false,
    })));
    render(<EmailManager />);

    const school = (await screen.findByText("ada@std.yildiz.edu.tr", { selector: "strong" })).closest<HTMLElement>(".settings-row")!;
    expect(within(school).queryByText("Doğrulandı")).not.toBeInTheDocument();
    expect(within(school).getByRole("link", { name: "YTÜ hesabını bağla" })).toHaveAttribute("href", "/identity");

    const primary = screen.getByRole("group", { name: "Birincil e-posta" });
    const schoolOption = within(primary).getByRole("radio", { name: /Okul e-postası/ });
    expect(schoolOption).toBeDisabled();
    expect(schoolOption).toHaveAccessibleDescription(/YTÜ hesabın bağlanmadan birincil adres yapılamaz/);
    expect(within(primary).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
    expect(within(primary).getByRole("link", { name: "YTÜ hesabını bağla" })).toHaveAttribute("href", "/identity");
    cleanup();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload({ personalEmail: null })));
    render(<EmailManager />);
    const onlySchool = await screen.findByRole("group", { name: "Birincil e-posta" });
    expect(within(onlySchool).getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText("Henüz kişisel e-posta eklemedin.")).toBeInTheDocument();
    cleanup();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload({
      ...withPersonal,
      email: "ada@example.com",
      primary: "personal",
      schoolEmail: null,
      verifiedYtu: false,
    })));
    render(<EmailManager />);
    const onlyPersonal = await screen.findByRole("group", { name: "Birincil e-posta" });
    expect(within(onlyPersonal).getAllByRole("radio")).toHaveLength(1);
    expect(within(onlyPersonal).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
    expect(screen.getByText("Kayıtlı değil")).toBeInTheDocument();
  });

  it("redirects to the login on 401 and shows a retryable card when the addresses cannot be read", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unavailable", detail: "Kimlik hizmetine şu anda ulaşılamıyor." }, 503))
      .mockResolvedValueOnce(json({ email: 42 }))
      .mockResolvedValueOnce(json({ error: "authentication_required" }, 401));
    render(<EmailManager />);
    expect(await screen.findByRole("alert")).toHaveTextContent("E-posta adreslerin yüklenemedi");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-posta adreslerin güvenle durduruldu");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login?returnTo=%2Femail"));
    expect(request).toHaveBeenCalledTimes(3);
  });

  describe("adding a personal address", () => {
    it("sends the code behind Sudo mode, then confirms the typed code with the session only", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(challenge, 428))
        .mockImplementationOnce(async () => json({ expiresAt: inTenMinutes() }, 202))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload(withPersonal)));
      render(<EmailManager />);
      await sendCode("  New.Address@Example.com ");

      const form = await codeForm();
      expect(within(form).getByText(/new\.address@example\.com adresine 6 haneli bir kod gönderdik/)).toBeInTheDocument();
      expect(within(form).getByRole("timer")).toHaveTextContent(/Kalan süre: (?:10:00|9:\d{2})$/);
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      const sent = recorded(request.mock.calls[2]!);
      expect(sent.url).toBe("/api/account/email/change-request");
      expect(sent.init).toMatchObject({
        method: "POST",
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      });
      expect(sent.body).toEqual({ address: "new.address@example.com" });

      const input = within(form).getByLabelText("Doğrulama kodu");
      expect(input).toHaveAttribute("autocomplete", "one-time-code");
      expect(input).toHaveAttribute("inputmode", "numeric");
      enterCode(form, "123 456");

      const notice = await findNotice("new.address@example.com doğrulandı. Artık bu adresle de giriş yapabilirsin.");
      await waitFor(() => expect(notice).toHaveFocus());
      const confirmed = recorded(request.mock.calls[3]!);
      expect(confirmed.url).toBe("/api/account/email/confirm");
      expect(confirmed.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": csrfToken } });
      expect(confirmed.body).toEqual({ code: "123456" });
      expect(sudo.ensureSudo).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("ada@example.com", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
    });

    it("refuses a malformed address or one already on the account before any request", async () => {
      const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(payload()));
      render(<EmailManager />);
      const form = await sendCode("not-an-address");
      expect(await within(form).findByRole("alert")).toHaveTextContent("Geçerli bir e-posta adresi gir.");
      const input = within(form).getByLabelText("E-posta adresi");
      expect(input).toHaveAttribute("aria-invalid", "true");
      await waitFor(() => expect(input).toHaveFocus());

      fireEvent.change(input, { target: { value: "ADA@std.yildiz.edu.tr" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu adres zaten hesabında kayıtlı.");
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("puts a taken address on the field and explains a mail that could not be sent", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json({ error: "email_taken", detail: "Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.", field: "address" }, 409))
        .mockResolvedValueOnce(json({ error: "email_not_sent", detail: "Doğrulama e-postası gönderilemedi. Lütfen daha sonra tekrar dene." }, 503));
      render(<EmailManager />);
      const form = await sendCode("taken@example.com");
      expect(await within(form).findByText("Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.")).toBeInTheDocument();
      expect(within(form).getByLabelText("E-posta adresi")).toHaveAttribute("aria-invalid", "true");

      fireEvent.change(within(form).getByLabelText("E-posta adresi"), { target: { value: "free@example.com" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Doğrulama e-postası gönderilemedi.");
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
    });

    it("tells a wrong code, an exhausted code and a vanished change apart", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json({ expiresAt: inTenMinutes() }, 202))
        .mockResolvedValueOnce(json({ error: "invalid_code", detail: "Doğrulama kodu yanlış. 3 deneme hakkın kaldı.", attemptsLeft: 3 }, 400))
        .mockResolvedValueOnce(json({ error: "invalid_code", detail: "Doğrulama kodu yanlış ve deneme hakkın bitti. Yeni bir kod iste.", attemptsLeft: 0 }, 400))
        .mockResolvedValueOnce(json({ expiresAt: inTenMinutes() }, 202))
        .mockResolvedValueOnce(json({ error: "no_pending_change", detail: "Bekleyen bir doğrulama kodu yok." }, 404));
      render(<EmailManager />);
      await sendCode("new@example.com");
      const form = await codeForm();
      const input = within(form).getByLabelText("Doğrulama kodu");

      enterCode(form, "000000");
      expect(await within(form).findByRole("alert")).toHaveTextContent("Kod yanlış. 3 deneme hakkın kaldı.");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toBeEnabled();
      expect(input).toHaveValue("");

      enterCode(form, "111111");
      expect(await within(form).findByText(
        "Kodu çok kez yanlış girdin; bu kod artık geçersiz. Yeni kod iste.",
      )).toBeInTheDocument();
      expect(input).toBeDisabled();
      expect(within(form).getByRole("button", { name: "Doğrula" })).toBeDisabled();

      fireEvent.click(within(form).getByRole("button", { name: "Yeni kod gönder" }));
      await waitFor(() => expect(input).toBeEnabled());
      expect(await within(form).findByText("Yeni bir kod gönderdik. Önceki kod artık geçersiz.")).toBeInTheDocument();
      expect(recorded(request.mock.calls[4]!).body).toEqual({ address: "new@example.com" });

      enterCode(form, "222222");
      expect(await within(form).findByText(
        "Bu kodun süresi dolmuş ya da kod artık geçerli değil. Yeni kod iste.",
      )).toBeInTheDocument();
      expect(input).toBeDisabled();
    });

    it("counts the ten minutes down and stops accepting the code when they run out", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        // The deadline is minted when the request is answered, like the SPI does.
        .mockImplementationOnce(async () => json({ expiresAt: inTenMinutes() }, 202));
      render(<EmailManager />);
      await sendCode("new@example.com");
      const form = await codeForm();
      const timer = within(form).getByRole("timer");
      expect(timer).toHaveTextContent(/Kalan süre: (?:10:00|9:\d{2})$/);
      // Let the countdown's effect start its interval before the clock jumps.
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });
      await waitFor(() => expect(timer).toHaveTextContent(/Kalan süre: [56]:\d{2}$/));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000 + 5_000);
      });
      expect(await within(form).findByText("Kodun süresi doldu. Yeni kod iste.")).toBeInTheDocument();
      expect(within(form).getByLabelText("Doğrulama kodu")).toBeDisabled();
      expect(within(form).getByRole("button", { name: "Doğrula" })).toBeDisabled();
      expect(within(form).getByRole("button", { name: "Yeni kod gönder" })).toBeEnabled();
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("shows the wait after too many requests for a code or too many tries", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json({ expiresAt: inTenMinutes() }, 202))
        .mockResolvedValueOnce(json({ error: "rate_limited", detail: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.", retryAfter: 120 }, 429))
        .mockResolvedValueOnce(json({ error: "rate_limited", detail: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.", retryAfter: 1_800 }, 429));
      render(<EmailManager />);
      await sendCode("new@example.com");
      const form = await codeForm();
      enterCode(form, "123456");
      expect(await within(form).findByRole("alert")).toHaveTextContent(
        "Çok fazla deneme yaptın. Biraz sonra yeniden dene. Yeniden denemek için bekle: 2 dakika.",
      );
      expect(within(form).getByRole("button", { name: "Doğrula" })).toBeDisabled();

      fireEvent.click(within(form).getByRole("button", { name: "Yeni kod gönder" }));
      expect(await within(form).findByText(/bekle: 30 dakika/)).toBeInTheDocument();
      expect(within(form).getByRole("button", { name: "Yeni kod gönder" })).toBeDisabled();
    });

    it("leaves the account untouched when Sudo mode is dismissed", async () => {
      sudo.ensureSudo.mockResolvedValue(false);
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload()))
        .mockResolvedValueOnce(json(challenge, 428));
      render(<EmailManager />);
      const form = await sendCode("new@example.com");
      expect(await within(form).findByRole("alert")).toHaveTextContent("Kimliğini doğrulamadığın için değişiklik yapılmadı.");
      expect(request).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
    });
  });

  describe("primary address", () => {
    it("switches the primary behind Sudo mode and re-reads the addresses", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(withPersonal)))
        .mockResolvedValueOnce(json(challenge, 428))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload({ ...withPersonal, email: "ada@example.com", primary: "personal" })));
      render(<EmailManager />);
      const group = await screen.findByRole("group", { name: "Birincil e-posta" });
      fireEvent.click(within(group).getByRole("radio", { name: /Kişisel e-posta/ }));
      const save = screen.getByRole("button", { name: "Birincil adresi kaydet" });
      expect(save).toBeEnabled();
      fireEvent.click(save);

      const notice = await findNotice("Birincil adresin güncellendi. Kulüp postaları artık ada@example.com adresine gider.");
      await waitFor(() => expect(notice).toHaveFocus());
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      const switched = recorded(request.mock.calls[2]!);
      expect(switched.url).toBe("/api/account/email/primary");
      expect(switched.body).toEqual({ which: "personal" });
      // The selector is rebuilt from the re-read addresses, not from the click.
      const refreshed = screen.getByRole("group", { name: "Birincil e-posta" });
      expect(within(refreshed).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
      expect(screen.getByRole("button", { name: "Birincil adresi kaydet" })).toBeDisabled();
    });

    it("explains a refusal for an unproven address with the way to the YTÜ link", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ ...withPersonal, email: "ada@example.com", primary: "personal" })))
        .mockResolvedValueOnce(json({
          error: "email_not_verified",
          detail: "Okul e-postan, YTÜ hesabın bağlanmadan birincil adres yapılamaz. YTÜ hesabını Kimlik sayfasından bağlayabilirsin.",
        }, 409));
      render(<EmailManager />);
      const group = await screen.findByRole("group", { name: "Birincil e-posta" });
      fireEvent.click(within(group).getByRole("radio", { name: /Okul e-postası/ }));
      fireEvent.click(screen.getByRole("button", { name: "Birincil adresi kaydet" }));
      const alert = await screen.findByText(/YTÜ hesabın bağlanmadan birincil adres yapılamaz/, { selector: ".security-feedback span" });
      expect(alert).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "YTÜ hesabını bağla" }).some((link) => link.getAttribute("href") === "/identity")).toBe(true);
    });
  });

  describe("removing the personal address", () => {
    it("confirms, runs Sudo mode and re-reads the addresses", async () => {
      const request = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload(withPersonal)))
        .mockResolvedValueOnce(json(challenge, 428))
        .mockResolvedValueOnce(noContent())
        .mockResolvedValueOnce(json(payload()));
      render(<EmailManager />);
      fireEvent.click(await screen.findByRole("button", { name: "ada@example.com — Kaldır" }));
      const dialog = await screen.findByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
      expect(dialog).toHaveTextContent("ada@example.com hesabından kaldırılacak. Bu adresle artık giriş yapamazsın.");
      expect(dialog).toHaveTextContent("Onayladıktan sonra kimliğini doğrulaman istenir.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Kaldır" }));

      await findNotice("Kişisel e-postan kaldırıldı.");
      const removed = recorded(request.mock.calls[2]!);
      expect(removed.url).toBe("/api/account/email/personal");
      expect(removed.init).toMatchObject({ method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      expect(await screen.findByRole("button", { name: "Kişisel e-posta ekle" })).toBeEnabled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("warns when the address is primary and keeps it when nothing can take over", async () => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(json(payload({ ...withPersonal, email: "ada@example.com", primary: "personal", verifiedYtu: false })))
        .mockResolvedValueOnce(json({
          error: "no_fallback_email",
          detail: "Kişisel e-postan birincil adresin ve yerine geçebilecek doğrulanmış bir okul e-postan yok; kaldırırsan giriş yapabileceğin bir adres kalmaz. Önce YTÜ hesabını bağla ve okul e-postanı birincil yap.",
        }, 409));
      render(<EmailManager />);
      fireEvent.click(await screen.findByRole("button", { name: "ada@example.com — Kaldır" }));
      const dialog = await screen.findByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
      expect(dialog).toHaveTextContent("Bu adres birincil adresin; kaldırınca kulüp postaları okul e-postana gider.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Kaldır" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("kaldırırsan giriş yapabileceğin bir adres kalmaz");
      expect(dialog).toBeInTheDocument();
    });
  });
});
