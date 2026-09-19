import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountShell } from "@/components/account-shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/security" }));
vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    const imageProps = { ...props };
    delete imageProps.priority;
    return createElement("img", { ...imageProps, alt: imageProps.alt ?? "" });
  },
}));

describe("AccountShell", () => {
  it("exposes the account navigation and marks the current page", () => {
    render(<AccountShell><p>İçerik</p></AccountShell>);

    expect(screen.getByRole("navigation", { name: "Hesap ayarları" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Giriş ve güvenlik" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "İçeriğe geç" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByText("İçerik")).toBeInTheDocument();
  });
});
