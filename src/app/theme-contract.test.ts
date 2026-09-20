import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const [red, green, blue] = hex.match(/[a-f\d]{2}/gi)!.map((value) => channel(Number.parseInt(value, 16)));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(foreground: string, background: string) {
  const [bright, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (bright! + 0.05) / (dark! + 0.05);
}

describe("Skyforms-derived theme contract", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

  it("keeps primary and muted text readable on the page surface", () => {
    const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    const surface = token("surface-page");

    expect(surface).toBeDefined();
    expect(contrast(token("ink")!, surface!)).toBeGreaterThanOrEqual(7);
    expect(contrast(token("ink-muted")!, surface!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink-faint")!, surface!)).toBeGreaterThanOrEqual(4.5);
  });

  it("never truncates critical status badge meaning", () => {
    expect(css).not.toMatch(/\.status-badge\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});
