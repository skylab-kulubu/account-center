import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OverviewPage from "@/app/(account)/page";
import PermissionsPage from "@/app/(account)/permissions/page";
import { loadPermissions } from "@/server/permissions/page-data";
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
  authentication: {
    ok: true as const,
    value: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
  },
}));

vi.mock("@/server/keycloak-account/page-data", () => ({
  loadOverview: vi.fn(async () => pageData.overview),
  loadAuthentication: vi.fn(async () => pageData.authentication),
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

  it("renders the normalized overview", async () => {
    render(await OverviewPage());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("E-posta doğrulandı")).toBeInTheDocument();
  });

  it("links the overview to the identity page, the Permissions view, the club profile and the in-product security page", async () => {
    render(await OverviewPage());
    const identity = screen.getByRole("link", { name: /Kimlik/ });
    expect(identity).toHaveAttribute("href", "/identity");
    expect(identity).toHaveTextContent("Adını, kullanıcı adını ve YTÜ hesabının durumunu yönet.");
    expect(screen.queryByRole("link", { name: /Kişisel bilgiler/ })).not.toBeInTheDocument();
    const email = screen.getByRole("link", { name: /E-posta ve giriş/ });
    expect(email).toHaveAttribute("href", "/email");
    expect(email).toHaveTextContent("Kişisel e-posta ekle, birincil adresini seç.");
    expect(screen.getByRole("link", { name: /Yetkilerim/ })).toHaveAttribute("href", "/permissions");
    expect(screen.getByRole("link", { name: /Kulüp profili/ })).toHaveAttribute("href", "/club-profile");
    const security = screen.getByRole("link", { name: /Giriş ve güvenlik/ });
    expect(security).toHaveAttribute("href", "/security");
    expect(security).toHaveTextContent("Parola, passkey ve doğrulama uygulamasını buradan yönet.");
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
});
