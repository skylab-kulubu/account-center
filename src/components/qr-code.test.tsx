import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { QrCode } from "@/components/qr-code";

afterEach(cleanup);

describe("QR code", () => {
  it("draws its modules in a skylcn token, kept dark whatever the page theme", () => {
    render(<QrCode label="Kurulum kodu" value="otpauth://totp/SKY%20LAB:ada?secret=AAAA" />);

    const symbol = screen.getByRole("img", { name: "Kurulum kodu" });
    // The dark token set, so the modules stay dark on the white paper in either theme
    expect(symbol).toHaveAttribute("data-theme", "dark");
    const modules = symbol.querySelector("path");
    expect(modules).toHaveClass("qr-code__modules");
    expect(modules).not.toHaveAttribute("fill");
  });
});
