import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OverviewPage from "@/app/(account)/page";
import PermissionsPage from "@/app/(account)/permissions/page";
import PersonalInformationPage from "@/app/(account)/personal-information/page";
import SecurityPage from "@/app/(account)/security/page";
import { loadSecurity } from "@/server/keycloak-account/page-data";
import { loadPermissions } from "@/server/permissions/page-data";
import type { AccountActionResult } from "@/server/auth/types";
import type { PermissionsPageData } from "@/server/permissions/page-data";

const pageData = vi.hoisted(() => ({
  overview: {
    ok: true as const,
    value: {
      profile: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.invalid",
        emailVerified: true,
      },
      authentication: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
    },
  },
  profile: {
    ok: true as const,
    value: {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.invalid",
      emailVerified: true,
    },
  },
  authentication: {
    ok: true as const,
    value: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
  },
  security: {
    ok: true as const,
    value: {
      passwordConfigured: true,
      otpConfigured: false,
      passkeyCount: 1,
      actionCsrfToken: "csrf-token",
      actionResult: null as AccountActionResult | null,
      credentials: [{
        kind: "passkey" as const,
        label: "MacBook Touch ID",
        createdAt: "2026-09-20T09:00:00.000Z",
        deletionReference: "opaque-delete-capability",
      }],
    },
  },
}));

vi.mock("@/server/keycloak-account/page-data", () => ({
  loadOverview: vi.fn(async () => pageData.overview),
  loadProfile: vi.fn(async () => pageData.profile),
  loadAuthentication: vi.fn(async () => pageData.authentication),
  loadSecurity: vi.fn(async () => pageData.security),
}));

vi.mock("@/server/permissions/page-data", () => ({
  loadPermissions: vi.fn(),
}));

const permissionsFixture: PermissionsPageData = {
  ok: true,
  teamsProblem: null,
  value: {
    membership: "member",
    teams: [
      { path: "/UYELER/ARGE/WEBLAB", name: "WebLab", role: "leader", roleLabel: "Lider", publicListing: true, doorScan: true },
      { path: "/UYELER/GECEKODU", name: "GECEKODU", role: "member", roleLabel: "Üye", publicListing: false, doorScan: false },
    ],
    privileges: [{ kind: "board", label: "Yönetim Kurulu", description: "Yönetim Kurulu üyesi olarak kulüp kaynaklarını takım sınırı olmadan yönetebilirsin." }],
    applications: [
      {
        clientId: "core",
        name: "SKY LAB Core",
        description: "Superadmin ve SkyApp’in arkasındaki kulüp platformu.",
        permissions: [
          { code: "url:create", label: "Kısa bağlantı oluşturma", description: "skyl.app üzerinde kısa bağlantı oluşturabilirsin." },
          { code: "certificate:issue", label: "Sertifika verme", description: "Üyesi olduğun takımların etkinliklerinde katılım sertifikası verebilirsin." },
        ],
        unlabelledCount: 1,
      },
      {
        clientId: "skymail",
        name: "SkyMail",
        description: "Kulübün toplu e-posta ve duyuru aracı.",
        permissions: [{ code: "skymail:access", label: "SkyMail’e giriş", description: "SkyMail arayüzünü açabilirsin." }],
        unlabelledCount: 0,
      },
    ],
    technical: {
      groupPaths: ["/UYELER", "/UYELER/ARGE/WEBLAB", "/UYELER/ARGE/WEBLAB/LIDERLER", "/UYELER/GECEKODU", "/UYELER/YK"],
      roles: [
        { clientId: "core", code: "certificate:issue" },
        { clientId: "core", code: "events:write" },
        { clientId: "core", code: "url:create" },
        { clientId: "skymail", code: "skymail:access" },
      ],
    },
  },
};

function textOutsideTechnicalDetails() {
  const copy = document.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("details").forEach((details) => details.remove());
  return copy.textContent ?? "";
}

describe("Account REST-backed pages", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the normalized overview and personal profile", async () => {
    const { unmount } = render(await OverviewPage());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("E-posta doğrulandı")).toBeInTheDocument();
    unmount();

    render(await PersonalInformationPage());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Doğrulandı")).toBeInTheDocument();
    expect(screen.getByText(/yalnızca görüntüleyebilirsin/i)).toBeInTheDocument();
    expect(screen.queryByText(/görüntüle ve yönet/i)).not.toBeInTheDocument();
  });

  it("links the overview to the read-only Permissions view and the club profile", async () => {
    render(await OverviewPage());
    expect(screen.getByRole("link", { name: /Yetkilerim/ })).toHaveAttribute("href", "/permissions");
    expect(screen.getByRole("link", { name: /Kulüp profili/ })).toHaveAttribute("href", "/club-profile");
  });

  it("renders teams, privilege level and application permissions in human language", async () => {
    vi.mocked(loadPermissions).mockResolvedValue(permissionsFixture);
    render(await PermissionsPage());

    expect(screen.getByRole("heading", { level: 1, name: "Yetkilerim" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Takımlarım" })).toBeInTheDocument();
    expect(screen.getByText("WebLab")).toBeInTheDocument();
    expect(screen.getByText("Lider")).toBeInTheDocument();
    expect(screen.getByText("Ekip kapı taraması açık")).toBeInTheDocument();
    expect(screen.getByText("Herkese açık listede")).toBeInTheDocument();
    expect(screen.getByText("GECEKODU")).toBeInTheDocument();
    expect(screen.getByText("Üye")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Yetki seviyesi" })).toBeInTheDocument();
    expect(screen.getByText("Yönetim Kurulu")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Uygulama yetkileri" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "SKY LAB Core" })).toBeInTheDocument();
    expect(screen.getByText("Kısa bağlantı oluşturma")).toBeInTheDocument();
    expect(screen.getByText("Sertifika verme")).toBeInTheDocument();
    expect(screen.getByText(/1 teknik yetki daha var/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "SkyMail" })).toBeInTheDocument();
    expect(screen.getByText("SkyMail’e giriş")).toBeInTheDocument();
    expect(screen.getByText(/Değişiklik için yönetim ekibiyle iletişime geç\./)).toBeInTheDocument();
    expect(document.querySelector("form, button")).toBeNull();

    const outside = textOutsideTechnicalDetails();
    for (const code of ["url:create", "certificate:issue", "events:write", "skymail:access", "/UYELER"]) {
      expect(outside).not.toContain(code);
    }
    const details = document.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("Teknik ayrıntılar");
    expect(screen.getByText("events:write")).not.toBeVisible();
    expect(screen.getByText("/UYELER/ARGE/WEBLAB/LIDERLER")).not.toBeVisible();
    expect(screen.getByText("url:create")).not.toBeVisible();
  });

  it("keeps application permissions and shows a banner when Account REST groups are unavailable", async () => {
    vi.mocked(loadPermissions).mockResolvedValue({
      ...permissionsFixture,
      teamsProblem: {
        type: "https://my.yildizskylab.com/problems/identity-unavailable",
        title: "Kimlik hizmetine şu anda ulaşılamıyor",
        status: 503,
        detail: "Hesap bilgilerin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      },
      value: {
        ...permissionsFixture.value,
        membership: "guest",
        teams: [],
        privileges: [],
        technical: { groupPaths: [], roles: permissionsFixture.value.technical.roles },
      },
    });
    render(await PermissionsPage());

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Kimlik hizmetine şu anda ulaşılamıyor");
    expect(banner).toHaveTextContent(/Uygulama yetkilerin aşağıda görünmeye devam eder/);
    expect(screen.getByRole("link", { name: "Yeniden dene" })).toHaveAttribute("href", "/permissions");
    expect(screen.queryByText("Henüz bir takımda değilsin")).not.toBeInTheDocument();
    expect(screen.getByText("Kısa bağlantı oluşturma")).toBeInTheDocument();
    expect(screen.getByText("Kullanıcı")).toBeInTheDocument();
  });

  it("renders the empty states for a person without teams or application roles", async () => {
    vi.mocked(loadPermissions).mockResolvedValue({
      ok: true,
      teamsProblem: null,
      value: { membership: "member", teams: [], privileges: [], applications: [], technical: { groupPaths: ["/UYELER"], roles: [] } },
    });
    render(await PermissionsPage());

    expect(screen.getByText("Henüz bir takımda değilsin")).toBeInTheDocument();
    expect(screen.getByText("Üye")).toBeInTheDocument();
    expect(screen.getByText("Uygulama yetkisi tanımlı değil")).toBeInTheDocument();
    expect(screen.queryByText("Rol kodları")).not.toBeInTheDocument();
    expect(screen.getByText("Grup yolları")).not.toBeVisible();
  });

  it("shows the safe problem card and keeps the page chrome when the token cannot be read", async () => {
    vi.mocked(loadPermissions).mockResolvedValue({
      ok: false,
      problem: {
        type: "https://my.yildizskylab.com/problems/reauthentication-required",
        title: "Yeniden giriş yapman gerekiyor",
        status: 401,
        detail: "Kimlik oturumun yenilenemedi. Güvenli biçimde devam etmek için yeniden giriş yap.",
      },
    });
    render(await PermissionsPage());

    expect(screen.getByRole("heading", { level: 1, name: "Yetkilerim" })).toBeInTheDocument();
    expect(screen.getByText("Yeniden giriş yapman gerekiyor")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fpermissions");
    expect(screen.queryByText("Takımlarım")).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.getByText(/Değişiklik için yönetim ekibiyle iletişime geç\./)).toBeInTheDocument();
  });

  it("renders authentication status and account security actions", async () => {
    render(await SecurityPage({}));
    expect(screen.getByText("1 kayıtlı")).toBeInTheDocument();
    expect(screen.getAllByText("Ayarlı değil")).toHaveLength(1);
    expect(screen.getByText("MacBook Touch ID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Şifreyi değiştir" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yeni passkey ekle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Doğrulama uygulaması ekle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MacBook Touch ID yöntemini kaldır" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("credential-passkey-one");
  });

  it("renders only a server-read one-time action result", async () => {
    const reference = "r".repeat(43);
    const noResult = render(await SecurityPage({
      searchParams: Promise.resolve({ result: reference }),
    }));
    expect(loadSecurity).toHaveBeenCalledWith(reference);
    expect(screen.queryByText("İşlem tamamlandı")).not.toBeInTheDocument();
    noResult.unmount();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    pageData.security.value.actionResult = { action: "otp", outcome: "success" };
    render(await SecurityPage({ searchParams: Promise.resolve({ result: reference }) }));
    expect(screen.getByText("İşlem tamamlandı")).toBeInTheDocument();
    expect(screen.getByText(/Keycloak’taki güncel durumla doğrulandı/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/auth/action-result/${reference}`,
      expect.objectContaining({
        method: "POST",
        headers: { "x-csrf-token": "csrf-token" },
      }),
    );
    pageData.security.value.actionResult = null;
  });
});
