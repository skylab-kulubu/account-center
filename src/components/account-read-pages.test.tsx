import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
        username: "ada",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.invalid",
        emailVerified: true,
        attributes: { schoolEmail: null, personalEmail: null, skyNumber: "24017", department: "Matematik", university: null },
        attributeMetadata: [],
      },
      authentication: { passwordConfigured: true, otpConfigured: false, passkeyCount: 1 },
    },
  },
}));

vi.mock("@/server/keycloak-account/page-data", () => ({
  loadOverview: vi.fn(async () => pageData.overview),
}));

const picture = vi.hoisted(() => ({ url: null as string | null }));

vi.mock("@/server/account-shell/identity", () => ({
  loadProfilePictureUrl: vi.fn(async () => picture.url),
}));

/** The browser's image loader as Base UI's Avatar probes it: `outcome` decides load or error. */
function stubImageLoader(outcome: "load" | "error") {
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false;
    naturalWidth = 0;
    crossOrigin: string | null = null;
    set src(_value: string) {
      queueMicrotask(() => (outcome === "load" ? this.onload?.() : this.onerror?.()));
    }
  });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
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
    privileges: [{ kind: "board", label: "Yönetim Kurulu", description: "Yönetim Kurulu üyesi olarak kulüp kaynaklarını ekip sınırı olmadan yönetebilirsin." }],
    applications: [
      {
        clientId: "core",
        name: "SKY LAB hesabı",
        description: "Superadmin ve SkyApp’in arkasındaki kulüp platformu.",
        permissions: [
          { code: "url:create", label: "Kısa bağlantı oluşturma", description: "skyl.app üzerinde kısa bağlantı oluşturabilirsin." },
          { code: "certificate:issue", label: "Sertifika verme", description: "Üyesi olduğun ekiplerin etkinliklerinde katılım sertifikası verebilirsin." },
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
    picture.url = null;
  });

  it("shows the person's profile photo, the one the account menu shows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    stubImageLoader("load");
    picture.url = "https://cdn.yildizskylab.com/images/ada";
    render(await OverviewPage());
    const person = screen.getByRole("region", { name: "Ada Lovelace" });
    expect(await within(person).findByRole("img", { name: "Ada Lovelace" })).toHaveAttribute("src", "https://cdn.yildizskylab.com/images/ada");
    expect(within(person).queryByText("AL")).not.toBeInTheDocument();
  });

  it("falls back to the initials when the photo does not load", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    stubImageLoader("error");
    picture.url = "https://cdn.yildizskylab.com/images/gone";
    render(await OverviewPage());
    const person = screen.getByRole("region", { name: "Ada Lovelace" });
    await waitFor(() => expect(within(person).getByText("AL")).toBeInTheDocument());
    expect(within(person).queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows the initials when the person has no photo", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    render(await OverviewPage());
    const person = screen.getByRole("region", { name: "Ada Lovelace" });
    expect(within(person).getByText("AL")).toBeInTheDocument();
    expect(within(person).queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the person and the security status, with the next step for anything missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    render(await OverviewPage());
    expect(screen.getByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getAllByText("ada@example.invalid").length).toBeGreaterThan(0);
    expect(screen.queryByText("E-posta doğrulanmadı")).not.toBeInTheDocument();
    const status = screen.getByRole("region", { name: "Güvenlik durumu" });
    expect(status).toHaveTextContent("1 öneri");
    expect(status).toHaveTextContent("Parola");
    // A passkey makes the verification app optional; only the missing personal e-mail is advice
    expect(status).toHaveTextContent("İsteğe bağlı");
    expect(within(status).getByRole("link", { name: "Ekle" })).toHaveAttribute("href", "/email");
  });

  it("shows the K4c nudge the e-mail answer names, linking into the e-mail page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      primaryEmailNudge: "add-personal",
      personalEmail: null,
      csrfToken: "session-bound-csrf",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(await OverviewPage());
    const nudge = await screen.findByRole("region", { name: "Okul adresin kapanırsa hesabına ulaşamayabilirsin" });
    expect(screen.getByRole("link", { name: "Kişisel adres ekle" })).toHaveAttribute("href", "/email?intent=add-personal");
    expect(fetchSpy).toHaveBeenCalledWith("/api/account/email/nudge", { cache: "no-store", credentials: "same-origin" });
    expect(nudge.compareDocumentPosition(screen.getByRole("heading", { name: "Güvenlik durumu" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows one line linking to the e-mail page when SkyMail no longer mails an address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(
      String(input) === "/api/account/email/delivery" ? { undeliverable: ["personal"] } : { primaryEmailNudge: null },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    render(await OverviewPage());
    const link = await screen.findByRole("link", { name: "Bir e-posta adresine posta ulaşmıyor." });
    expect(link).toHaveAttribute("href", "/email");
    expect(link.closest("p")).toHaveTextContent(/^Bir e-posta adresine posta ulaşmıyor\.$/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/account/email/delivery", { cache: "no-store", credentials: "same-origin" });
  });

  it.each([
    ["nothing is undeliverable", () => new Response(JSON.stringify({ undeliverable: [] }), { status: 200, headers: { "content-type": "application/json" } })],
    ["the answer is not the contract", () => new Response(JSON.stringify({ undeliverable: "personal" }), { status: 200, headers: { "content-type": "application/json" } })],
    ["the read fails", () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })],
  ])("shows no delivery line when %s", async (_label, answer) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
    render(await OverviewPage());
    expect(await screen.findByRole("heading", { level: 1, name: "Ada Lovelace" })).toBeInTheDocument();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/account/email/delivery", expect.anything()));
    expect(screen.queryByText("Bir e-posta adresine posta ulaşmıyor.")).not.toBeInTheDocument();
  });

  it("leads from the overview to every section and the pages people look for most", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    render(await OverviewPage());
    for (const [name, href] of [
      ["Kişisel bilgiler", "/personal-info"],
      ["Güvenlik", "/security"],
      ["Cihazlar", "/sessions"],
      ["Kulüp profili", "/club-profile"],
      ["İletişim tercihleri", "/communication-preferences"],
      ["Veri ve gizlilik", "/privacy"],
      ["Yetkiler", "/permissions"],
      ["Uygulama ayarları", "/app-preferences"],
    ] as const) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(screen.getByText("24017")).toBeInTheDocument();
    expect(screen.getByText("Matematik")).toBeInTheDocument();
  });

  it("renders teams, privilege level and application permissions in human language", async () => {
    vi.mocked(loadPermissions).mockResolvedValue(permissionsFixture);
    render(await PermissionsPage());

    expect(screen.getByRole("heading", { level: 1, name: "Yetkiler" })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { level: 3, name: "SKY LAB hesabı" })).toBeInTheDocument();
    expect(screen.getByText("Kısa bağlantı oluşturma")).toBeInTheDocument();
    expect(screen.getByText("Sertifika verme")).toBeInTheDocument();
    expect(screen.getByText(/1 teknik yetki daha var/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "SkyMail" })).toBeInTheDocument();
    expect(screen.getByText("SkyMail’e giriş")).toBeInTheDocument();
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

    expect(screen.getByRole("heading", { level: 1, name: "Yetkiler" })).toBeInTheDocument();
    expect(screen.getByText("Yeniden giriş yapman gerekiyor")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fpermissions");
    expect(screen.queryByText("Takımlarım")).not.toBeInTheDocument();
    expect(document.querySelector("details")).toBeNull();
  });
});
