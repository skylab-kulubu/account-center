import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogoLoader } from "@/components/logo-loader";

describe("LogoLoader", () => {
  it("announces the supplied loading state without announcing the decorative mark", () => {
    const { container } = render(<LogoLoader label="Hesap yükleniyor" />);

    expect(screen.getByRole("status")).toHaveTextContent("Hesap yükleniyor");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll(".logo-loader__path").length).toBeGreaterThan(0);
    expect(container.querySelector("animate")).not.toBeInTheDocument();
  });

  it("creates a distinct gradient for each loader instance", () => {
    const { container } = render(<><LogoLoader /><LogoLoader /></>);
    const ids = Array.from(container.querySelectorAll("linearGradient"), (node) => node.id);

    expect(new Set(ids).size).toBe(2);
  });
});
