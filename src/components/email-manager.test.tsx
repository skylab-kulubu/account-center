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

type Endpoint = "email" | "pending" | "change" | "confirm" | "primary" | "personal";
type Answer = { status?: number; body?: unknown };
type Recorded = { endpoint: Endpoint; url: string; init: RequestInit; body: unknown };

const endpoints: Record<string, Endpoint> = {
  "/api/account/email": "email",
  "/api/account/email/pending": "pending",
  "/api/account/email/change-request": "change",
  "/api/account/email/confirm": "confirm",
  "/api/account/email/primary": "primary",
  "/api/account/email/personal": "personal",
};

/**
 * Answers the page's calls by route instead of by order: each route has a
 * queue whose last answer repeats. An answer may be a function, evaluated
 * when the request arrives (deadlines are minted then, like the SPI does).
 * Nothing waits for a code unless a test says so.
 */
function mockApi(answers: Partial<Record<Endpoint, Array<Answer | (() => Answer)>>>) {
  const queues: Partial<Record<Endpoint, Array<Answer | (() => Answer)>>> = {
    pending: [{ body: { pending: null } }],
    ...answers,
  };
  const calls: Recorded[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const endpoint = endpoints[url];
    const queue = endpoint ? queues[endpoint] : undefined;
    if (!endpoint || !queue || queue.length === 0) throw new Error(`unexpected request ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const answer = typeof next === "function" ? next() : next;
    calls.push({ endpoint, url, init: init ?? {}, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (answer.status === 204) return new Response(null, { status: 204 });
    return json(answer.body, answer.status ?? 200);
  });
  return { spy, calls, of: (endpoint: Endpoint) => calls.filter((call) => call.endpoint === endpoint) };
}

const challenge = { status: 428, body: { error: "sudo_required", reason: "missing", methods: ["password"], fallback: null } };
const done = { status: 204 };
/**
 * The BFF counts `secondsLeft` on its own clock; `expiresAt` is display-only,
 * so these deadlines deliberately disagree with the test's clock.
 */
const codeSent = { status: 202, body: { expiresAt: "2026-09-23T00:10:00.000Z", secondsLeft: 600 } };
const waiting = (address: string, attemptsLeft: number, secondsLeft = 360, expiresAt = "2026-09-23T00:06:00.000Z") => ({
  body: { pending: { address, expiresAt, attemptsLeft, secondsLeft } },
});
const codeLimit = {
  status: 429,
  body: { error: "code_limit", detail: "Bir saatte en fazla üç doğrulama kodu isteyebilirsin.", retryAfter: 1_800 },
};

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
    const api = mockApi({ email: [{ body: payload(withPersonal) }] });
    const { container } = render(<EmailManager />);

    expect(await screen.findByRole("heading", { level: 2, name: "Okul e-postası" })).toBeInTheDocument();
    const school = screen.getByText("ada@std.yildiz.edu.tr", { selector: "strong" }).closest<HTMLElement>(".settings-row")!;
    expect(within(school).getByText("Doğrulandı")).toBeInTheDocument();
    expect(within(school).queryByRole("button")).not.toBeInTheDocument();

    expect(screen.getByRole("heading", { level: 2, name: "Kişisel e-posta" })).toBeInTheDocument();
    const personal = screen.getByText("ada@example.com", { selector: "strong" }).closest<HTMLElement>(".settings-row")!;
    expect(within(personal).getByText("Doğrulandı")).toBeInTheDocument();
    expect(within(personal).getByRole("button", { name: "ada@example.com — Değiştir" })).toBeEnabled();
    expect(within(personal).getByRole("button", { name: "ada@example.com — Kaldır" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Kişisel e-posta ekle" })).not.toBeInTheDocument();

    const primary = screen.getByRole("group", { name: "Birincil e-posta" });
    expect(within(primary).getByRole("radio", { name: /Okul e-postası/ })).toBeChecked();
    expect(within(primary).getByRole("radio", { name: /Kişisel e-posta/ })).not.toBeChecked();
    expect(within(primary).getByRole("radio", { name: /Kişisel e-posta/ })).toBeEnabled();
    expect(screen.getByText("Kulüp postaları birincil adrese gider; iki adresle de giriş yapabilirsin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Birincil adresi kaydet" })).toBeDisabled();

    expect(api.spy).toHaveBeenCalledWith("/api/account/email", { cache: "no-store", credentials: "same-origin" });
    await waitFor(() => expect(api.spy).toHaveBeenCalledWith("/api/account/email/pending", { cache: "no-store", credentials: "same-origin" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(csrfToken);
  });

  it("offers only the addresses that exist and sends an unlinked school address to the YTÜ link", async () => {
    mockApi({ email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal", verifiedYtu: false }) }] });
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
    vi.restoreAllMocks();

    mockApi({ email: [{ body: payload({ personalEmail: null }) }] });
    render(<EmailManager />);
    const onlySchool = await screen.findByRole("group", { name: "Birincil e-posta" });
    expect(within(onlySchool).getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText("Henüz kişisel e-posta eklemedin.")).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockApi({ email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal", schoolEmail: null, verifiedYtu: false }) }] });
    render(<EmailManager />);
    const onlyPersonal = await screen.findByRole("group", { name: "Birincil e-posta" });
    expect(within(onlyPersonal).getAllByRole("radio")).toHaveLength(1);
    expect(within(onlyPersonal).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
    expect(screen.getByText("Kayıtlı değil")).toBeInTheDocument();
  });

  it("never shows the school badge without a school address", async () => {
    mockApi({ email: [{ body: payload({ schoolEmail: null, verifiedYtu: true }) }] });
    render(<EmailManager />);
    const school = (await screen.findByText("Kayıtlı değil", { selector: "strong" })).closest<HTMLElement>(".settings-row")!;
    expect(within(school).queryByText("Doğrulandı")).not.toBeInTheDocument();
    expect(within(school).queryByRole("link")).not.toBeInTheDocument();
    expect(school).toHaveTextContent("YTÜ hesabın bağlı ama okul e-postan henüz gelmedi; bir sonraki YTÜ girişinde gelir.");
  });

  it("redirects to the login on 401 and shows a retryable card when the addresses cannot be read", async () => {
    const api = mockApi({
      email: [
        { status: 503, body: { error: "unavailable", detail: "Kimlik hizmetine şu anda ulaşılamıyor." } },
        { body: { email: 42 } },
        { status: 401, body: { error: "authentication_required" } },
      ],
    });
    render(<EmailManager />);
    expect(await screen.findByRole("alert")).toHaveTextContent("E-posta adreslerin yüklenemedi");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-posta adreslerin güvenle durduruldu");
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login?returnTo=%2Femail"));
    expect(api.of("email")).toHaveLength(3);
    expect(api.of("pending")).toHaveLength(0);
  });

  describe("adding a personal address", () => {
    it("sends the code behind Sudo mode, then confirms the typed code with the session only", async () => {
      const api = mockApi({
        email: [{ body: payload() }, { body: payload(withPersonal) }],
        change: [challenge, codeSent],
        confirm: [done],
      });
      render(<EmailManager />);
      await sendCode("  New.Address@Example.com ");

      const form = await codeForm();
      expect(within(form).getByText(/new\.address@example\.com adresine 6 haneli bir kod gönderdik/)).toBeInTheDocument();
      expect(within(form).getByRole("timer")).toHaveTextContent(/Kalan süre: (?:10:00|9:\d{2})$/);
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      const sent = api.of("change")[1]!;
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
      const confirmed = api.of("confirm")[0]!;
      expect(confirmed.init).toMatchObject({ method: "POST", headers: { "x-csrf-token": csrfToken } });
      expect(confirmed.body).toEqual({ code: "123456" });
      expect(sudo.ensureSudo).toHaveBeenCalledTimes(1);
      expect(await screen.findByText("ada@example.com", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
    });

    it("refuses a malformed address or one already on the account before any request", async () => {
      const api = mockApi({ email: [{ body: payload() }] });
      render(<EmailManager />);
      const form = await sendCode("not-an-address");
      expect(await within(form).findByRole("alert")).toHaveTextContent("Geçerli bir e-posta adresi gir.");
      const input = within(form).getByLabelText("E-posta adresi");
      expect(input).toHaveAttribute("aria-invalid", "true");
      await waitFor(() => expect(input).toHaveFocus());

      fireEvent.change(input, { target: { value: "ADA@std.yildiz.edu.tr" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu adres zaten hesabında kayıtlı.");
      expect(api.of("change")).toHaveLength(0);
    });

    it("puts a taken address on the field and explains a mail that could not be sent", async () => {
      mockApi({
        email: [{ body: payload() }],
        change: [
          { status: 409, body: { error: "email_taken", detail: "Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.", field: "address" } },
          { status: 503, body: { error: "email_not_sent", detail: "Doğrulama e-postası gönderilemedi. Lütfen daha sonra tekrar dene." } },
        ],
      });
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
      const api = mockApi({
        email: [{ body: payload() }],
        change: [codeSent, codeSent],
        confirm: [
          { status: 400, body: { error: "invalid_code", detail: "Doğrulama kodu yanlış. 3 deneme hakkın kaldı.", attemptsLeft: 3 } },
          { status: 400, body: { error: "invalid_code", detail: "Doğrulama kodu yanlış ve deneme hakkın bitti. Yeni bir kod iste.", attemptsLeft: 0 } },
          { status: 404, body: { error: "no_pending_change", detail: "Bekleyen bir doğrulama kodu yok." } },
        ],
      });
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
      expect(api.of("change")[1]!.body).toEqual({ address: "new@example.com" });

      enterCode(form, "222222");
      expect(await within(form).findByText(
        "Bu kodun süresi dolmuş ya da kod artık geçerli değil. Yeni kod iste.",
      )).toBeInTheDocument();
      expect(input).toBeDisabled();
    });

    it("counts the server's seconds down on a monotonic clock and stops accepting the code when they run out", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const api = mockApi({ email: [{ body: payload() }], change: [codeSent] });
      render(<EmailManager />);
      await sendCode("new@example.com");
      const form = await codeForm();
      const timer = within(form).getByRole("timer");
      expect(timer).toHaveTextContent(/Kalan süre: (?:10:00|9:\d{2})$/);
      // Let the countdown's effect start its interval before the clock jumps.
      await act(async () => {});
      // The browser's wall clock jumping an hour ahead changes nothing.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(timer).toHaveTextContent(/Kalan süre: 9:\d{2}$/);
      expect(within(form).getByLabelText("Doğrulama kodu")).toBeEnabled();
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
      expect(api.of("confirm")).toHaveLength(0);
    });

    it("says three codes an hour and when to ask again, and keeps the generic wait for too many tries", async () => {
      mockApi({
        email: [{ body: payload() }],
        change: [codeSent, codeLimit],
        confirm: [{ status: 429, body: { error: "rate_limited", detail: "Çok fazla deneme yaptın. Biraz sonra yeniden dene.", retryAfter: 120 } }],
      });
      render(<EmailManager />);
      await sendCode("new@example.com");
      const form = await codeForm();
      enterCode(form, "123456");
      expect(await within(form).findByRole("alert")).toHaveTextContent(
        "Çok fazla deneme yaptın. Biraz sonra yeniden dene. Yeniden denemek için bekle: 2 dakika.",
      );
      expect(within(form).getByRole("button", { name: "Doğrula" })).toBeDisabled();

      fireEvent.click(within(form).getByRole("button", { name: "Yeni kod gönder" }));
      expect(await within(form).findByText(
        "Bir saatte en fazla üç doğrulama kodu isteyebilirsin. Yeniden denemek için bekle: 30 dakika.",
      )).toBeInTheDocument();
      expect(within(form).getByRole("button", { name: "Yeni kod gönder" })).toBeDisabled();
    });

    it("says three codes an hour on the first request too", async () => {
      mockApi({ email: [{ body: payload() }], change: [codeLimit] });
      render(<EmailManager />);
      const form = await sendCode("new@example.com");
      expect(await within(form).findByRole("alert")).toHaveTextContent(
        "Bir saatte en fazla üç doğrulama kodu isteyebilirsin. Yeniden denemek için bekle: 30 dakika.",
      );
      expect(within(form).getByRole("button", { name: "Kod gönder" })).toBeDisabled();
    });

    it("goes back to the address when it was taken while the code was on its way, and never mails it again", async () => {
      const api = mockApi({
        email: [{ body: payload() }],
        change: [codeSent],
        confirm: [{ status: 409, body: { error: "email_taken", detail: "Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.", field: "address" } }],
      });
      render(<EmailManager />);
      await sendCode("taken@example.com");
      enterCode(await codeForm(), "123456");

      const form = await screen.findByRole("form", { name: "Kişisel e-posta ekle" });
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Yeni kod gönder" })).not.toBeInTheDocument();
      const input = within(form).getByLabelText("E-posta adresi");
      expect(input).toHaveValue("taken@example.com");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(within(form).getByRole("alert")).toHaveTextContent("Bu e-posta adresi başka bir hesapta kayıtlı. Başka bir adres dene.");
      await waitFor(() => expect(input).toHaveFocus());

      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu e-posta adresi başka bir hesapta kayıtlı.");
      fireEvent.change(input, { target: { value: " TAKEN@example.com" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu e-posta adresi başka bir hesapta kayıtlı.");
      expect(api.of("change")).toHaveLength(1);

      fireEvent.change(input, { target: { value: "free@example.com" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      await codeForm();
      expect(api.of("change").map(({ body }) => body)).toEqual([{ address: "taken@example.com" }, { address: "free@example.com" }]);
    });

    it("leaves the account untouched when Sudo mode is dismissed", async () => {
      sudo.ensureSudo.mockResolvedValue(false);
      const api = mockApi({ email: [{ body: payload() }], change: [challenge] });
      render(<EmailManager />);
      const form = await sendCode("new@example.com");
      expect(await within(form).findByRole("alert")).toHaveTextContent("Kimliğini doğrulamadığın için değişiklik yapılmadı.");
      expect(api.of("change")).toHaveLength(1);
      expect(screen.queryByRole("form", { name: "Doğrulama kodunu gir" })).not.toBeInTheDocument();
    });
  });

  describe("a change still waiting for its code", () => {
    it("brings the code panel back on load with the deadline and the tries left, without mailing a new code", async () => {
      const api = mockApi({
        email: [{ body: payload() }, { body: payload({ personalEmail: "new@example.com", personalEmailVerified: true }) }],
        pending: [waiting("new@example.com", 3)],
        confirm: [done],
      });
      render(<EmailManager />);
      const form = await codeForm();
      expect(within(form).getByText(/new@example\.com adresine 6 haneli bir kod gönderdik/)).toBeInTheDocument();
      expect(within(form).getByRole("timer")).toHaveTextContent(/Kalan süre: (?:6:00|5:5\d)$/);
      expect(within(form).getByText("3 deneme hakkın kaldı.")).toBeInTheDocument();
      await waitFor(() => expect(within(form).getByLabelText("Doğrulama kodu")).toHaveFocus());
      expect(api.of("change")).toHaveLength(0);
      expect(sudo.ensureSudo).not.toHaveBeenCalled();

      enterCode(form, "654321");
      await findNotice("new@example.com doğrulandı. Artık bu adresle de giriş yapabilirsin.");
      expect(api.of("confirm")[0]!.body).toEqual({ code: "654321" });
      // Only the first load asks what is waiting.
      expect(api.of("pending")).toHaveLength(1);
    });

    it("reopens on return from the mail app, but after Vazgeç only offers the same code", async () => {
      const first = waiting("new@example.com", 5, 540, "2026-09-23T00:09:00.000Z");
      const second = waiting("other@example.com", 5, 580, "2026-09-23T00:09:40.000Z");
      const api = mockApi({ email: [{ body: payload() }], pending: [first, first, first, second] });
      const returnToPage = () => act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      render(<EmailManager />);
      const opened = await codeForm();
      expect(api.of("pending")).toHaveLength(1);

      fireEvent.click(within(opened).getByRole("button", { name: "Vazgeç" }));
      const offer = await screen.findByRole("button", { name: "Bekleyen bir kod var — gir" });
      expect(screen.queryByRole("form")).not.toBeInTheDocument();

      returnToPage();
      await waitFor(() => expect(api.of("pending")).toHaveLength(2));
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Bekleyen bir kod var — gir" })).toBeInTheDocument();

      fireEvent.click(offer);
      const reopened = await codeForm();
      expect(within(reopened).getByText(/new@example\.com adresine 6 haneli bir kod gönderdik/)).toBeInTheDocument();
      expect(api.of("pending")).toHaveLength(3);
      expect(screen.queryByRole("button", { name: "Bekleyen bir kod var — gir" })).not.toBeInTheDocument();

      // A different change (asked for elsewhere) is not the one the person closed.
      fireEvent.click(within(reopened).getByRole("button", { name: "Vazgeç" }));
      await screen.findByRole("button", { name: "Bekleyen bir kod var — gir" });
      returnToPage();
      const other = await codeForm();
      expect(within(other).getByText(/other@example\.com adresine 6 haneli bir kod gönderdik/)).toBeInTheDocument();
    });

    it("never opens over a form in use, and drops the offer once nothing waits", async () => {
      const api = mockApi({
        email: [{ body: payload() }],
        pending: [{ body: { pending: null } }, { body: { pending: null } }],
        change: [codeSent],
      });
      render(<EmailManager />);
      await screen.findByRole("heading", { level: 2, name: "Kişisel e-posta" });
      await waitFor(() => expect(api.of("pending")).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "Kişisel e-posta ekle" }));
      await screen.findByRole("form", { name: "Kişisel e-posta ekle" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(api.of("pending")).toHaveLength(1);

      const addForm = screen.getByRole("form", { name: "Kişisel e-posta ekle" });
      fireEvent.change(within(addForm).getByLabelText("E-posta adresi"), { target: { value: "new@example.com" } });
      fireEvent.click(within(addForm).getByRole("button", { name: "Kod gönder" }));
      fireEvent.click(within(await codeForm()).getByRole("button", { name: "Vazgeç" }));
      await screen.findByRole("button", { name: "Bekleyen bir kod var — gir" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Bekleyen bir kod var — gir" })).not.toBeInTheDocument());
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });

    it("restores a replacement of the existing personal address as a change", async () => {
      mockApi({ email: [{ body: payload(withPersonal) }], pending: [waiting("new@example.com", 4)] });
      render(<EmailManager />);
      const form = await codeForm();
      expect(within(form).getByText("Kodu girdiğinde ada@example.com yerine bu adres kişisel e-postan olur.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "ada@example.com — Değiştir" })).toBeDisabled();
    });
  });

  describe("changing the personal address", () => {
    it("mails a code to the new address and replaces the old one, primary included, once it is confirmed", async () => {
      const replaced = { personalEmail: "new@example.com", personalEmailVerified: true, email: "new@example.com", primary: "personal" };
      const api = mockApi({
        email: [
          { body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal" }) },
          { body: payload(replaced) },
        ],
        change: [challenge, codeSent],
        confirm: [done],
      });
      render(<EmailManager />);
      fireEvent.click(await screen.findByRole("button", { name: "ada@example.com — Değiştir" }));
      const form = await screen.findByRole("form", { name: "Kişisel e-postayı değiştir" });
      expect(form).toHaveTextContent("Kodu girene kadar ada@example.com kişisel adresin olarak kalır.");
      expect(form).toHaveTextContent("Birincil adresin de yeni adrese geçer.");
      const input = within(form).getByLabelText("Yeni e-posta adresi");

      fireEvent.change(input, { target: { value: "ADA@example.com" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("Bu adres zaten hesabında kayıtlı.");
      expect(api.of("change")).toHaveLength(0);

      fireEvent.change(input, { target: { value: "new@example.com" } });
      fireEvent.click(within(form).getByRole("button", { name: "Kod gönder" }));
      const code = await codeForm();
      expect(within(code).getByText("Kodu girdiğinde ada@example.com yerine bu adres kişisel e-postan olur.")).toBeInTheDocument();
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      expect(api.of("change")[1]!.body).toEqual({ address: "new@example.com" });
      enterCode(code, "123456");

      await findNotice("new@example.com doğrulandı; kişisel e-postan artık bu adres. ada@example.com ile artık giriş yapamazsın.");
      expect(await screen.findByText("new@example.com", { selector: "strong" })).toBeInTheDocument();
      expect(screen.queryByText("ada@example.com", { selector: "strong" })).not.toBeInTheDocument();
      expect(within(screen.getByRole("group", { name: "Birincil e-posta" })).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
    });
  });

  describe("primary address", () => {
    it("switches the primary behind Sudo mode and re-reads the addresses", async () => {
      const api = mockApi({
        email: [{ body: payload(withPersonal) }, { body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal" }) }],
        primary: [challenge, done],
      });
      render(<EmailManager />);
      const group = await screen.findByRole("group", { name: "Birincil e-posta" });
      fireEvent.click(within(group).getByRole("radio", { name: /Kişisel e-posta/ }));
      const save = screen.getByRole("button", { name: "Birincil adresi kaydet" });
      expect(save).toBeEnabled();
      fireEvent.click(save);

      const notice = await findNotice("Birincil adresin güncellendi. Kulüp postaları artık ada@example.com adresine gider.");
      await waitFor(() => expect(notice).toHaveFocus());
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      expect(api.of("primary")[1]!.body).toEqual({ which: "personal" });
      // The selector is rebuilt from the re-read addresses, not from the click.
      const refreshed = screen.getByRole("group", { name: "Birincil e-posta" });
      expect(within(refreshed).getByRole("radio", { name: /Kişisel e-posta/ })).toBeChecked();
      expect(screen.getByRole("button", { name: "Birincil adresi kaydet" })).toBeDisabled();
    });

    it("relays a refusal for an unproven school address with the way to the YTÜ link", async () => {
      mockApi({
        email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal" }) }],
        primary: [{
          status: 409,
          body: {
            error: "email_not_verified",
            detail: "Bu adres henüz kanıtlanmadı. Kişisel adres için adrese gönderilen kodu gir; okul adresi için YTÜ hesabını bağla.",
          },
        }],
      });
      render(<EmailManager />);
      const group = await screen.findByRole("group", { name: "Birincil e-posta" });
      fireEvent.click(within(group).getByRole("radio", { name: /Okul e-postası/ }));
      fireEvent.click(screen.getByRole("button", { name: "Birincil adresi kaydet" }));
      expect(await screen.findByText(/okul adresi için YTÜ hesabını bağla/, { selector: ".security-feedback span" })).toBeInTheDocument();
      expect(screen.getAllByRole("link", { name: "YTÜ hesabını bağla" }).some((link) => link.getAttribute("href") === "/identity")).toBe(true);
    });
  });

  describe("removing the personal address", () => {
    it("confirms, runs Sudo mode and re-reads the addresses", async () => {
      const api = mockApi({
        email: [{ body: payload(withPersonal) }, { body: payload() }],
        personal: [challenge, done],
      });
      render(<EmailManager />);
      fireEvent.click(await screen.findByRole("button", { name: "ada@example.com — Kaldır" }));
      const dialog = await screen.findByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
      expect(dialog).toHaveTextContent("ada@example.com hesabından kaldırılacak. Bu adresle artık giriş yapamazsın.");
      expect(dialog).toHaveTextContent("Onayladıktan sonra kimliğini doğrulaman istenir.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Kaldır" }));

      await findNotice("Kişisel e-postan kaldırıldı.");
      expect(api.of("personal")[1]!.init).toMatchObject({ method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
      expect(await screen.findByRole("button", { name: "Kişisel e-posta ekle" })).toBeEnabled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("says the school address takes over when a primary personal address is removed and one can", async () => {
      mockApi({
        email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal" }) }],
        personal: [{
          status: 409,
          body: {
            error: "no_fallback_email",
            detail: "Kişisel e-posta şu anda birincil adresin ve yerine geçebilecek, YTÜ hesabıyla kanıtlanmış bir okul e-postan yok; kaldırılırsa giriş yapabileceğin bir adres kalmaz. Önce YTÜ hesabını bağla ya da başka bir kişisel adres ekle.",
          },
        }],
      });
      render(<EmailManager />);
      fireEvent.click(await screen.findByRole("button", { name: "ada@example.com — Kaldır" }));
      const dialog = await screen.findByRole("dialog", { name: "Kişisel e-posta kaldırılsın mı?" });
      expect(dialog).toHaveTextContent("Bu adres birincil adresin; kaldırınca kulüp postaları okul e-postana gider.");
      // Should the account have changed since the page loaded, the SPI's refusal is shown and nothing is lost.
      fireEvent.click(within(dialog).getByRole("button", { name: "Kaldır" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("kaldırılırsa giriş yapabileceğin bir adres kalmaz");
      expect(dialog).toBeInTheDocument();
    });

    it("does not offer removing a primary personal address that nothing can replace, and says what to do instead", async () => {
      const api = mockApi({ email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal", verifiedYtu: false }) }] });
      render(<EmailManager />);
      const remove = await screen.findByRole("button", { name: "ada@example.com — Kaldır" });
      expect(remove).toBeDisabled();
      expect(remove).toHaveAccessibleDescription(
        "Bu adres birincil adresin ve yerine geçebilecek, YTÜ hesabınla doğrulanmış bir okul e-postan yok; kaldırırsan giriş yapabileceğin bir adres kalmaz. YTÜ hesabını bağlayabilir ya da adresi değiştirebilirsin.",
      );
      const personal = screen.getByText("ada@example.com", { selector: "strong" }).closest<HTMLElement>("section")!;
      expect(within(personal).getByRole("link", { name: "YTÜ hesabını bağla" })).toHaveAttribute("href", "/identity");
      expect(screen.getByRole("button", { name: "ada@example.com — Değiştir" })).toBeEnabled();
      fireEvent.click(remove);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.of("personal")).toHaveLength(0);
      cleanup();
      vi.restoreAllMocks();

      // Linked to YTÜ but without a school address yet: still nothing to fall back to, and no link to offer.
      mockApi({ email: [{ body: payload({ ...withPersonal, email: "ada@example.com", primary: "personal", schoolEmail: null, verifiedYtu: true }) }] });
      render(<EmailManager />);
      expect(await screen.findByRole("button", { name: "ada@example.com — Kaldır" })).toBeDisabled();
      expect(screen.queryByRole("link", { name: "YTÜ hesabını bağla" })).not.toBeInTheDocument();
    });
  });
});
