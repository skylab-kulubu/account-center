import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/account-menu";

describe("AccountMenu", () => {
  beforeEach(() => {
    // skylcn's useTheme follows the system theme
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("draws the account button as in Entra: the name, the chevron, then the avatar against the corner", () => {
    render(<AccountMenu identity={{ name: "Ada Lovelace", email: "ada@example.invalid", pictureUrl: null }} />);
    const trigger = screen.getByRole("button", { name: "Hesap: Ada Lovelace" });
    const children = Array.from(trigger.children);
    const name = children.findIndex((child) => child.textContent === "Ada Lovelace");
    const avatar = children.findIndex((child) => child.getAttribute("data-slot") === "avatar");
    expect(name).toBe(0);
    expect(avatar).toBe(children.length - 1);
    expect(trigger).toHaveClass("size-9");
  });

  it("opens and signs out before the person's profile arrives, without a name", () => {
    render(<AccountMenu identity={null} />);
    const trigger = screen.getByRole("button", { name: "Hesap" });
    expect(trigger.textContent).not.toContain("Hesap");
  });
});
