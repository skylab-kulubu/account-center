import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OverviewPage from "@/app/(account)/page";
import PersonalInformationPage from "@/app/(account)/personal-information/page";
import SecurityPage from "@/app/(account)/security/page";

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
}));

vi.mock("@/server/keycloak-account/page-data", () => ({
  loadOverview: vi.fn(async () => pageData.overview),
  loadProfile: vi.fn(async () => pageData.profile),
  loadAuthentication: vi.fn(async () => pageData.authentication),
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

  it("renders authentication status", async () => {
    render(await SecurityPage());
    expect(screen.getByText("1 passkey")).toBeInTheDocument();
    expect(screen.getAllByText("Ayarlı değil")).toHaveLength(1);
  });
});
