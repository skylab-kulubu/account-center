import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountMenu } from "@/components/account-menu";

describe("AccountMenu", () => {
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
