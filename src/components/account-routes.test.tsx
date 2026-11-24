import { render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import nextConfig from "../../next.config";
import { AccountPageHeader } from "@/components/settings";
import {
  accountRoute,
  accountRoutes,
  accountSections,
  matchAccountRoute,
} from "@/config/account-routes";

describe("account route metadata", () => {
  it("defines every live page once, grouped under its section", () => {
    expect(accountRoutes.map(({ href }) => href)).toEqual([
      "/",
      "/personal-info",
      "/identity",
      "/email",
      "/club-profile",
      "/security",
      "/sessions",
      "/privacy",
      "/communication-preferences",
      "/delete-account",
      "/notifications",
      "/tickets",
      "/apps",
      "/permissions",
      "/app-preferences",
    ]);
    expect(new Set(accountRoutes.map(({ href }) => href)).size).toBe(accountRoutes.length);
  });

  it("has the six sections of Google Account and Biletlerim, each with its own page", () => {
    expect(accountSections.map(({ href, label }) => [href, label])).toEqual([
      ["/", "Ana sayfa"],
      ["/personal-info", "Kişisel bilgiler"],
      ["/security", "Güvenlik"],
      ["/privacy", "Veri ve gizlilik"],
      ["/notifications", "Bildirimler"],
      ["/tickets", "Biletlerim"],
      ["/apps", "Uygulamalar"],
    ]);
    for (const { href } of accountSections) expect(accountRoute(href).section).toBe(href);
    expect(accountRoute("/identity").section).toBe("/personal-info");
    expect(accountRoute("/email").section).toBe("/personal-info");
    expect(accountRoute("/club-profile").section).toBe("/personal-info");
    expect(accountRoute("/sessions").section).toBe("/security");
    expect(accountRoute("/communication-preferences").section).toBe("/privacy");
    expect(accountRoute("/delete-account").section).toBe("/privacy");
    expect(accountRoute("/permissions").section).toBe("/apps");
    expect(accountRoute("/app-preferences").section).toBe("/apps");
  });

  it("keeps exact page lookup inside the AccountRoutePath domain", () => {
    expect(accountRoute("/security").href).toBe("/security");
    expectTypeOf(accountRoute).parameter(0).toEqualTypeOf<
      | "/"
      | "/personal-info"
      | "/identity"
      | "/email"
      | "/club-profile"
      | "/security"
      | "/sessions"
      | "/privacy"
      | "/communication-preferences"
      | "/delete-account"
      | "/notifications"
      | "/tickets"
      | "/apps"
      | "/permissions"
      | "/app-preferences"
    >();
  });

  it("matches dynamic paths only on an exact route segment boundary", () => {
    expect(matchAccountRoute("/security")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/security/")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/security/result")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/club-profile")).toBe(accountRoute("/club-profile"));
    expect(matchAccountRoute("/communication-preferences")).toBe(accountRoute("/communication-preferences"));
    expect(matchAccountRoute("/app-preferences")).toBe(accountRoute("/app-preferences"));
    expect(matchAccountRoute("/notifications")).toBe(accountRoute("/notifications"));
    expect(matchAccountRoute("/identity")).toBe(accountRoute("/identity"));
    expect(matchAccountRoute("/identity-card")).toBeNull();
    expect(matchAccountRoute("/email")).toBe(accountRoute("/email"));
    expect(matchAccountRoute("/emails")).toBeNull();
    expect(matchAccountRoute("/personal-information")).toBeNull();
    expect(matchAccountRoute("/club-profile-picture")).toBeNull();
    expect(matchAccountRoute("/security-center")).toBeNull();
    expect(matchAccountRoute("/unknown")).toBeNull();
    expect(matchAccountRoute("/overview")).toBeNull();
  });

  it("redirects the retired /personal-information path to /identity permanently", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({ source: "/personal-information", destination: "/identity", permanent: true });
  });

  it("titles a page from its metadata and links a sub-page back to its section, with no description", () => {
    const { container, unmount } = render(<AccountPageHeader route={accountRoute("/identity")} />);
    expect(screen.getByRole("heading", { level: 1, name: "Kimlik" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kişisel bilgiler" })).toHaveAttribute("href", "/personal-info");
    expect(container.querySelector("p")).toBeNull();
    unmount();

    render(<AccountPageHeader route={accountRoute("/security")} />);
    expect(screen.getByRole("heading", { level: 1, name: "Güvenlik" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
