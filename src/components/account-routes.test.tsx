import { render, screen } from "@testing-library/react";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AccountPageHeader } from "@/components/settings";
import {
  accountRoute,
  accountRoutes,
  matchAccountRoute,
} from "@/config/account-routes";

describe("account route metadata", () => {
  it("defines the seven live product routes once and in navigation order", () => {
    expect(accountRoutes.map(({ href }) => href)).toEqual([
      "/",
      "/personal-information",
      "/club-profile",
      "/security",
      "/sessions",
      "/permissions",
      "/delete-account",
    ]);
    expect(new Set(accountRoutes.map(({ href }) => href)).size).toBe(accountRoutes.length);
  });

  it("keeps exact page lookup inside the AccountRoutePath domain", () => {
    expect(accountRoute("/security").href).toBe("/security");
    expectTypeOf(accountRoute).parameter(0).toEqualTypeOf<
      "/" | "/personal-information" | "/club-profile" | "/security" | "/sessions" | "/permissions" | "/delete-account"
    >();
  });

  it("matches dynamic paths only on an exact route segment boundary", () => {
    expect(matchAccountRoute("/security")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/security/")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/security/result")).toBe(accountRoute("/security"));
    expect(matchAccountRoute("/club-profile")).toBe(accountRoute("/club-profile"));
    expect(matchAccountRoute("/club-profile-picture")).toBeNull();
    expect(matchAccountRoute("/security-center")).toBeNull();
    expect(matchAccountRoute("/unknown")).toBeNull();
    expect(matchAccountRoute("/overview")).toBeNull();
  });

  it("drives page chrome from the same metadata used by navigation", () => {
    const route = accountRoute("/personal-information");
    render(<AccountPageHeader route={route} />);

    expect(screen.getByRole("heading", { level: 1, name: route.title })).toBeInTheDocument();
    expect(screen.getByText(route.description)).toBeInTheDocument();
  });
});
