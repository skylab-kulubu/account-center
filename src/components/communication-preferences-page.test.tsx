import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommunicationPreferencesPage from "@/app/(account)/communication-preferences/page";
import type { CommunicationPreferencesView } from "@/lib/communication-preferences";
import { loadCommunicationPreferencesPage } from "@/server/communication-preferences/page-data";
import type { CommunicationPreferencesPageData } from "@/server/communication-preferences/page-data";

vi.mock("@/server/communication-preferences/page-data", () => ({
  loadCommunicationPreferencesPage: vi.fn(),
}));

vi.mock("@/components/communication-preferences-editor", () => ({
  CommunicationPreferencesEditor: ({ csrfToken, focusCategory }: { csrfToken: string; focusCategory: string | null }) => (
    <div data-csrf={csrfToken} data-focus={focusCategory ?? ""} data-testid="preferences-editor" />
  ),
}));

const cell = { explicit: null, enabled: true, origin: "default", from: null, effective: true } as const;
const view: CommunicationPreferencesView = {
  master: cell,
  club: { duyuru: cell, haber: cell },
  teams: [],
  following: [],
  followable: [],
  tracking: null,
};

function pageData(overrides: Partial<CommunicationPreferencesPageData> = {}): CommunicationPreferencesPageData {
  return {
    preferences: { status: "ready", value: view },
    promotional: { status: "hidden" },
    primaryEmail: "ada@std.yildiz.edu.tr",
    csrfToken: "session-bound-csrf",
    ...overrides,
  };
}

async function renderPage(search: Record<string, string | string[]> = {}) {
  return render(await CommunicationPreferencesPage({ searchParams: Promise.resolve(search) }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("İletişim tercihleri page", () => {
  it("explains why the mail comes, what it never touches and where it goes", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData());
    await renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "İletişim tercihleri" })).toBeInTheDocument();
    expect(screen.getByText("Bu postaları SKY LAB üyesi olduğun ya da takip ettiğin için alıyorsun.")).toBeInTheDocument();
    expect(screen.getByText("Giriş kodu, bilet, sertifika gibi hesap postaların bu ayarlardan etkilenmez.")).toBeInTheDocument();
    expect(screen.getByText("ada@std.yildiz.edu.tr")).toBeInTheDocument();
    expect(screen.getByText(/Mezun olunca okul adresin kapanır/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "E-posta ayarları" })).toHaveAttribute("href", "/email");
    expect(screen.getByTestId("preferences-editor")).toHaveAttribute("data-csrf", "session-bound-csrf");
  });

  it("hands the editor the mail link's category, and only a well-formed one", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData());
    await renderPage({ kanal: "email", kategori: "team:abc:duyuru" });
    expect(screen.getByTestId("preferences-editor")).toHaveAttribute("data-focus", "team:abc:duyuru");
    cleanup();

    await renderPage({ kanal: "email", kategori: "team:<x>:duyuru" });
    expect(screen.getByTestId("preferences-editor")).toHaveAttribute("data-focus", "");
  });

  it("says the preferences are not available yet while core has no key", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: {
        status: "problem",
        problem: {
          type: "https://my.yildizskylab.com/problems/communication-preferences-unavailable",
          title: "İletişim tercihleri şu an kullanılamıyor",
          status: 503,
          detail: "Duyuru ve haber postası tercihleri henüz açılmadı.",
          code: "communication_preferences_unavailable",
        },
      },
    }));
    await renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("İletişim tercihleri şu an kullanılamıyor");
    expect(screen.queryByTestId("preferences-editor")).toBeNull();
    expect(screen.queryByRole("link", { name: "Yeniden dene" })).toBeNull();
    // The address line stays: it is useful whether or not the switches are on.
    expect(screen.getByRole("link", { name: "E-posta ayarları" })).toBeInTheDocument();
  });

  it("offers a retry on a passing failure and a login on a refused session", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: { status: "problem", problem: { type: "x", title: "Ulaşılamıyor", status: 503, detail: "Core yanıt vermedi." } },
    }));
    await renderPage();
    expect(screen.getByRole("link", { name: "Yeniden dene" })).toHaveAttribute("href", "/communication-preferences");
    cleanup();

    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: { status: "problem", problem: { type: "x", title: "Giriş", status: 401, detail: "Yeniden giriş yap." } },
      primaryEmail: null,
    }));
    await renderPage();
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" }))
      .toHaveAttribute("href", "/login?returnTo=%2Fcommunication-preferences");
    expect(screen.getByText(/Postalar birincil e-posta adresine gider/)).toBeInTheDocument();
  });

  it("keeps the mail's row in the retry and login links", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: { status: "problem", problem: { type: "x", title: "Ulaşılamıyor", status: 503, detail: "Core yanıt vermedi." } },
    }));
    await renderPage({ kanal: "email", kategori: "team:abc:duyuru" });
    expect(screen.getByRole("link", { name: "Yeniden dene" }))
      .toHaveAttribute("href", "/communication-preferences?kanal=email&kategori=team%3Aabc%3Aduyuru");
    cleanup();

    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: { status: "problem", problem: { type: "x", title: "Giriş", status: 401, detail: "Yeniden giriş yap." } },
    }));
    await renderPage({ kanal: "email", kategori: "team:abc:duyuru" });
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fcommunication-preferences%3Fkanal%3Demail%26kategori%3Dteam%253Aabc%253Aduyuru",
    );
  });

  it("shows the promotional box apart from the preferences, unticked unless the consent is active", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({ promotional: { status: "shown", value: "pending" } }));
    await renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Tanıtım içerikleri" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /tanıtım içerikli e-postalar/ })).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Açık Rıza Metni" })).toHaveAttribute("href", "https://yildizskylab.com/acik-riza-metni.pdf");
    cleanup();

    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({ promotional: { status: "shown", value: "active" } }));
    await renderPage();
    expect(screen.getByRole("switch", { name: /tanıtım içerikli e-postalar/ })).toBeChecked();
  });

  it("leaves the promotional box out while core records no consents, and says so when the list failed", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData());
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Tanıtım içerikleri" })).toBeNull();
    cleanup();

    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({ promotional: { status: "shown", value: null } }));
    await renderPage();
    expect(screen.getByText("Tanıtım izni okunamadı. Sayfayı yenileyip yeniden dene.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /tanıtım/ })).toBeNull();
  });

  it("server-renders without an inline style", async () => {
    vi.mocked(loadCommunicationPreferencesPage).mockResolvedValue(pageData({
      preferences: { status: "problem", problem: { type: "x", title: "Ulaşılamıyor", status: 503, detail: "x" } },
    }));
    const html = renderToString(await CommunicationPreferencesPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toMatch(/\sstyle=/);
  });
});
