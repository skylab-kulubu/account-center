import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClubProfilePage from "@/app/(account)/club-profile/page";
import { loadClubProfilePage } from "@/server/club-profile/page-data";
import type { ClubProfilePageData } from "@/server/club-profile/page-data";
import type { ClubProfileView } from "@/server/club-profile/service";

vi.mock("@/server/club-profile/page-data", () => ({
  loadClubProfilePage: vi.fn(),
}));

vi.mock("@/components/club-profile-editor", () => ({
  ClubProfileEditor: ({ initial, csrfToken }: { initial: ClubProfileView; csrfToken: string }) => (
    <div data-testid="club-profile-editor" data-csrf={csrfToken}>{initial.faculty}</div>
  ),
}));

const clubProfile: ClubProfileView = {
  skyNumber: "SKY-0000042",
  studentCardLinked: true,
  schoolEmail: "ada@std.yildiz.edu.tr",
  phone: "+905551112233",
  university: "Yıldız Teknik Üniversitesi",
  faculty: "Elektrik-Elektronik Fakültesi",
  department: "Bilgisayar Mühendisliği",
  linkedin: "https://www.linkedin.com/in/ada-lovelace",
  profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/picture.webp",
  ytuLinked: false,
  updatedAt: "2026-09-21T13:10:41.130Z",
};

const identity: ClubProfilePageData["identity"] = {
  ok: true,
  value: {
    displayName: "Ada Lovelace",
    email: "ada@std.yildiz.edu.tr",
    schoolEmail: "ada@std.yildiz.edu.tr",
    skyNumber: "SKY-0000042",
  },
};

const reauthProblem = {
  type: "https://my.yildizskylab.com/problems/reauthentication-required",
  title: "Yeniden giriş yapman gerekiyor",
  status: 401,
  detail: "Kimlik oturumun yenilenemedi. Güvenli biçimde devam etmek için yeniden giriş yap.",
};

function pageData(overrides: Partial<ClubProfilePageData> = {}): ClubProfilePageData {
  return {
    identity,
    clubProfile: { status: "ready", value: clubProfile },
    csrfToken: "session-bound-csrf",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Kulüp profili page", () => {
  it("renders the read-only membership rows and mounts the editor with the session proof", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData());
    render(await ClubProfilePage());

    expect(screen.getByRole("heading", { level: 1, name: "Kulüp profili" })).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("SKY-0000042")).toBeInTheDocument();
    expect(screen.getByText("Öğrenci kartı bağlı")).toBeInTheDocument();
    expect(screen.getByText(/SkyPass ekranından bağlayabilir/)).toBeInTheDocument();
    expect(screen.getByText("Okul e-postası")).toBeInTheDocument();
    expect(screen.getByText("YTÜ hesabından gelir")).toBeInTheDocument();
    expect(screen.getByText(/\+905551112233/)).toBeInTheDocument();
    expect(screen.getByText(/Yönetim ekibi günceller; doğrulama geldiğinde buradan düzenleyebileceksin/)).toBeInTheDocument();
    const editor = screen.getByTestId("club-profile-editor");
    expect(editor).toHaveAttribute("data-csrf", "session-bound-csrf");
    expect(editor).toHaveTextContent("Elektrik-Elektronik Fakültesi");
    expect(screen.getByText(/yeniden doğrulama istemez/)).toBeInTheDocument();
  });

  it("shows the unlinked card and missing phone states without ever offering to edit them", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData({
      clubProfile: { status: "ready", value: { ...clubProfile, studentCardLinked: false, phone: null, skyNumber: null } },
      identity: { ...identity, value: { ...identity.value, skyNumber: null } },
    }));
    render(await ClubProfilePage());

    expect(screen.getByText("Öğrenci kartı bağlı değil")).toBeInTheDocument();
    expect(screen.getByText(/Kayıtlı değil · Yönetim ekibi günceller/)).toBeInTheDocument();
    expect(screen.getByText("Henüz verilmedi")).toBeInTheDocument();
    expect(document.querySelector('input[name="phone"], input[name="skyNumber"], input[name="firstName"]')).toBeNull();
  });

  it("keeps the Keycloak identity and explains the disabled state when core is off", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData({ clubProfile: { status: "disabled" } }));
    render(await ClubProfilePage());

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Kulüp profili bu ortamda kapalı");
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getAllByText("ada@std.yildiz.edu.tr")).toHaveLength(2);
    expect(screen.getByText("SKY-0000042")).toBeInTheDocument();
    expect(screen.getAllByText("Bu ortamda kapalı")).toHaveLength(2);
    expect(screen.queryByTestId("club-profile-editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Öğrenci kartı bağlı")).not.toBeInTheDocument();
  });

  it("shows a 503 banner with retry while still rendering the identity summary when core is down", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData({
      clubProfile: {
        status: "problem",
        problem: {
          type: "https://my.yildizskylab.com/problems/club-profile-unavailable",
          title: "Kulüp profiline şu anda ulaşılamıyor",
          status: 503,
          detail: "Core hizmeti yanıt vermedi. Kulüp profilin değişmedi; kısa bir süre sonra yeniden deneyebilirsin.",
        },
      },
    }));
    render(await ClubProfilePage());

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Kulüp profiline şu anda ulaşılamıyor");
    expect(within(notice).getByRole("link", { name: "Yeniden dene" })).toHaveAttribute("href", "/club-profile");
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getAllByText("ada@std.yildiz.edu.tr")).toHaveLength(2);
    expect(screen.getAllByText("Şu anda görüntülenemiyor")).toHaveLength(2);
    expect(screen.queryByTestId("club-profile-editor")).not.toBeInTheDocument();
  });

  it("offers a single re-login card when both reads failed on the session token", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData({
      identity: { ok: false, problem: reauthProblem },
      clubProfile: { status: "problem", problem: { ...reauthProblem, type: "https://my.yildizskylab.com/problems/club-profile-reauthentication" } },
    }));
    render(await ClubProfilePage());

    expect(screen.getByRole("heading", { level: 1, name: "Kulüp profili" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Yeniden giriş yap" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");
    expect(screen.queryByTestId("club-profile-editor")).not.toBeInTheDocument();
  });

  it("links a core-only re-login problem to the login page while the identity still renders", async () => {
    vi.mocked(loadClubProfilePage).mockResolvedValue(pageData({
      clubProfile: {
        status: "problem",
        problem: {
          type: "https://my.yildizskylab.com/problems/club-profile-reauthentication",
          title: "Kulüp profili için yeniden giriş yapman gerekiyor",
          status: 401,
          detail: "Oturumunun core erişimi doğrulanamadı.",
        },
      },
    }));
    render(await ClubProfilePage());

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");
  });
});
