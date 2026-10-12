import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LoginPage from "@/app/login/page";

afterEach(cleanup);

async function renderLogin(parameters: Record<string, string>) {
  render(await LoginPage({ searchParams: Promise.resolve(parameters) }));
}

describe("login page", () => {
  it("is one task: a named main region, one heading and the sign-in link", async () => {
    await renderLogin({ returnTo: "/sessions" });

    const main = screen.getByRole("main");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(main.querySelector("section")).toHaveAccessibleName("Hesap Merkezi’ne giriş yap");
    expect(screen.getByRole("link", { name: "SKY LAB ile giriş yap" }))
      .toHaveAttribute("href", "/api/auth/login?returnTo=%2Fsessions");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("alerts a failed sign-in and tells a signed-out person their session closed", async () => {
    await renderLogin({ error: "unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent("Giriş tamamlanamadı. Lütfen yeniden dene.");
    cleanup();

    await renderLogin({ loggedOut: "1" });
    expect(screen.getByRole("status")).toHaveTextContent("Bu cihazdaki Hesap Merkezi oturumu kapatıldı.");
  });
});
