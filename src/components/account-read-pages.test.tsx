import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OverviewPage from "@/app/(account)/page";
import PersonalInformationPage from "@/app/(account)/personal-information/page";
import SecurityPage from "@/app/(account)/security/page";
import SessionsPage from "@/app/(account)/sessions/page";

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
  sessions: {
    ok: true as const,
    value: [{
      id: "server-session-id",
      startedAt: "2026-09-20T09:00:00.000Z",
      lastAccessAt: "2026-09-20T10:00:00.000Z",
      expiresAt: "2026-09-20T17:00:00.000Z",
      browser: "Chrome/140.0",
      current: true,
      device: {
        name: "MacBook",
        operatingSystem: "macOS",
        operatingSystemVersion: "15.6",
        mobile: false,
      },
    }],
  },
}));

vi.mock("@/server/keycloak-account/page-data", () => ({
  loadOverview: vi.fn(async () => pageData.overview),
  loadProfile: vi.fn(async () => pageData.profile),
  loadAuthentication: vi.fn(async () => pageData.authentication),
  loadSessions: vi.fn(async () => pageData.sessions),
}));

describe("Account REST-backed pages", () => {
  it("renders the normalized overview and personal profile", async () => {
    const { unmount } = render(await OverviewPage());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.invalid")).toBeInTheDocument();
    expect(screen.getByText("E-posta doğrulandı")).toBeInTheDocument();
    unmount();

    render(await PersonalInformationPage());
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Doğrulandı")).toBeInTheDocument();
  });

  it("renders authentication status and canonical session device hints", async () => {
    const { unmount } = render(await SecurityPage());
    expect(screen.getByText("1 passkey")).toBeInTheDocument();
    expect(screen.getAllByText("Ayarlı değil")).toHaveLength(1);
    unmount();

    const rendered = render(await SessionsPage());
    expect(screen.getByText("MacBook · macOS · 15.6")).toBeInTheDocument();
    expect(screen.getByText("Bu oturum")).toBeInTheDocument();
    expect(rendered.container.textContent).not.toContain("server-session-id");
    expect(rendered.container.textContent).not.toContain("203.0.113.42");
  });
});
