import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppleMobile, SkyPassWalletCard } from "@/components/skypass-wallet-card";

const sudo = vi.hoisted(() => ({
  ensureSudo: vi.fn(),
  invalidateSudo: vi.fn(),
  sudoExpiresAt: null as Date | null,
}));

vi.mock("@/components/sudo-provider", () => ({ useSudo: () => sudo }));

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const macSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const android = "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const saveUrl = "https://pay.google.com/gp/v/save/eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJza3lsYWIifQ.c2lnbmF0dXJl";

function problem(value: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify({ status, ...value }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

type FakeTab = {
  opener: unknown;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  location: { replace: ReturnType<typeof vi.fn> };
  document: { title: string; body: { textContent: string } };
};

function fakeTab(): FakeTab {
  return {
    opener: "parent",
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
    document: { title: "", body: { textContent: "" } },
  };
}

function renderCard(initialIssued = false) {
  return render(<SkyPassWalletCard initialIssued={initialIssued} csrfToken="session-bound-csrf" />);
}

function addButton() {
  return screen.getByRole("button", { name: "Google Cüzdana ekle" });
}

let fetchMock: ReturnType<typeof vi.fn>;
let openMock: ReturnType<typeof vi.fn>;
let tab: FakeTab;
const storageWrites = vi.fn();
const consoleWrites = vi.fn();

beforeEach(() => {
  sudo.sudoExpiresAt = new Date(Date.now() + 5 * 60_000);
  sudo.ensureSudo.mockResolvedValue(true);
  tab = fakeTab();
  fetchMock = vi.fn();
  openMock = vi.fn(() => tab);
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "open").mockImplementation(openMock as unknown as typeof window.open);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(storageWrites);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(consoleWrites);
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storageWrites.mockReset();
  consoleWrites.mockReset();
});

describe("isAppleMobile", () => {
  it("hides the button on iPhone and iPad, also when iPadOS asks for the desktop site, but not on a Mac", () => {
    expect(isAppleMobile(iphone, 5)).toBe(true);
    expect(isAppleMobile("Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X)", 5)).toBe(true);
    expect(isAppleMobile(macSafari, 5)).toBe(true);
    expect(isAppleMobile(macSafari, 0)).toBe(false);
    expect(isAppleMobile(android, 5)).toBe(false);
  });
});

describe("SkyPassWalletCard", () => {
  it("shows a note instead of the button on an iPhone and still lets the pass be ended", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    renderCard(true);

    expect(screen.queryByRole("button", { name: "Google Cüzdana ekle" })).not.toBeInTheDocument();
    expect(screen.getByText("Google Cüzdan iPhone’da yok; Apple Cüzdan desteği daha sonra gelecek.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cüzdandan kaldır/ })).toBeInTheDocument();
  });

  it("verifies first when there is no fresh Sudo proof and opens nothing until the next press", async () => {
    sudo.sudoExpiresAt = null;
    renderCard();

    fireEvent.click(addButton());

    expect(await screen.findByText(/Kimliğin doğrulandı/)).toBeInTheDocument();
    expect(sudo.ensureSudo).toHaveBeenCalledWith(undefined);
    expect(openMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(addButton()).toHaveFocus());
  });

  it("renews a proof that would expire while core writes the pass", async () => {
    sudo.sudoExpiresAt = new Date(Date.now() + 10_000);
    renderCard();

    fireEvent.click(addButton());

    await waitFor(() => expect(sudo.ensureSudo).toHaveBeenCalled());
    expect(openMock).not.toHaveBeenCalled();
  });

  it("stays quiet when the person closes the Sudo dialog", async () => {
    sudo.sudoExpiresAt = null;
    sudo.ensureSudo.mockResolvedValue(false);
    renderCard();

    fireEvent.click(addButton());

    await waitFor(() => expect(addButton()).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the tab and verifies again when the server says the proof is gone", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "sudo_required", reason: "expired", methods: ["password"], fallback: null }), { status: 428 }));
    renderCard();

    fireEvent.click(addButton());

    expect(await screen.findByText(/Kimliğin doğrulandı/)).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(sudo.invalidateSudo).toHaveBeenCalled();
    expect(sudo.ensureSudo).toHaveBeenCalledWith({ challenged: true });
  });

  it("shows Google's own button and no revoke action before a pass exists", () => {
    renderCard();
    const image = within(addButton()).getByRole("img", { name: "Google Cüzdana ekle" });
    expect(image).toHaveAttribute("src", "/google-wallet/tr_add_to_google_wallet_button.svg");
    const condensed = addButton().querySelector("source");
    expect(condensed).toHaveAttribute("srcset", "/google-wallet/tr_add_to_google_wallet_badge.svg");
    expect(condensed).toHaveAttribute("media", "(max-width: 359px)");
    expect(screen.getByText("Pas yok")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cüzdandan kaldır/ })).not.toBeInTheDocument();
  });

  it("opens a tab inside the click and sends it to the save link without an opener or any trace", async () => {
    fetchMock.mockResolvedValue(Response.json({ saveUrl }));
    renderCard();

    fireEvent.click(addButton());

    // The tab is opened synchronously, inside the user gesture, before the request settles.
    expect(openMock).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(saveUrl));
    expect(fetchMock).toHaveBeenCalledWith("/api/account/skypass/wallet/google", expect.objectContaining({
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-csrf-token": "session-bound-csrf" },
    }));
    expect(await screen.findByText(/Google Cüzdan yeni sekmede açıldı/)).toBeInTheDocument();
    expect(screen.getByText("Pas etkin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cüzdandan kaldır/ })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("gp/v/save");
    expect(storageWrites).not.toHaveBeenCalled();
    expect(consoleWrites).not.toHaveBeenCalled();
  });

  it("goes to Google in this tab when the browser refuses a new one", async () => {
    openMock.mockReturnValue(null);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fetchMock.mockResolvedValue(Response.json({ saveUrl }));
    renderCard();

    fireEvent.click(addButton());

    await waitFor(() => expect(assign).toHaveBeenCalledWith(saveUrl));
  });

  it("never navigates to a link that is not Google's save URL", async () => {
    fetchMock.mockResolvedValue(Response.json({ saveUrl: "https://evil.example/gp/v/save/a.b.c" }));
    renderCard();

    fireEvent.click(addButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("Google Cüzdan işlemi güvenle durduruldu");
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(screen.getByText("Pas yok")).toBeInTheDocument();
  });

  it.each([
    [409, { title: "Pas hazırlanırken sona erdi", detail: "Bağlantı verilmedi.", code: "skypass_wallet_pass_ended" }, /Pas hazırlanırken sona erdi/],
    [429, { title: "Çok fazla deneme", detail: "Biraz bekle.", code: "skypass_wallet_rate_limited", retryAfterSeconds: 42 }, /Yaklaşık 42 saniye sonra/],
    [502, { title: "Google Cüzdan yanıt vermedi", detail: "Biraz sonra yeniden dene.", code: "skypass_google_wallet_unavailable" }, /Google Cüzdan yanıt vermedi/],
  ])("closes the pending tab and explains a %i", async (status, body, text) => {
    fetchMock.mockResolvedValue(problem(body, status));
    renderCard();

    fireEvent.click(addButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(tab.close).toHaveBeenCalled();
    expect(addButton()).toBeEnabled();
  });

  it("hides the button once core says Google Wallet is off", async () => {
    fetchMock.mockResolvedValue(problem({ title: "Google Cüzdan şu anda kullanılamıyor", detail: "Kapalı.", code: "skypass_google_wallet_off" }, 503));
    renderCard();

    fireEvent.click(addButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("Google Cüzdan şu anda kullanılamıyor");
    expect(screen.queryByRole("button", { name: "Google Cüzdana ekle" })).not.toBeInTheDocument();
    expect(screen.getByText(/Google Cüzdan şu anda kapalı/)).toBeInTheDocument();
  });

  it("offers a new login on 401 and reports a network failure", async () => {
    fetchMock.mockResolvedValueOnce(problem({ title: "Yeniden giriş yapman gerekiyor", detail: "Oturum." }, 401));
    renderCard();
    fireEvent.click(addButton());
    expect(await screen.findByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(addButton());
    expect(await screen.findByText("Bağlantı kurulamadı")).toBeInTheDocument();
  });

  it("asks before revoking, then ends the pass with DELETE", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderCard(true);

    fireEvent.click(screen.getByRole("button", { name: /Cüzdandan kaldır/ }));
    const dialog = screen.getByRole("dialog", { name: "Pas Google Cüzdan’dan kaldırılsın mı?" });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Pası kaldır" }));

    expect(await screen.findByText(/Pas kaldırıldı/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/account/skypass/wallet/google", expect.objectContaining({
      method: "DELETE",
      headers: { "x-csrf-token": "session-bound-csrf" },
    }));
    expect(screen.getByText("Pas yok")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("keeps the pass shown as active when the revoke fails", async () => {
    fetchMock.mockResolvedValue(problem({ title: "Çok fazla deneme", detail: "Biraz bekle.", retryAfterSeconds: 20 }, 429));
    renderCard(true);

    fireEvent.click(screen.getByRole("button", { name: /Cüzdandan kaldır/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pası kaldır" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Yaklaşık 20 saniye sonra/);
    expect(screen.getByText("Pas etkin")).toBeInTheDocument();
  });
});
