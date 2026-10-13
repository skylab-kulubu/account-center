import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/** The first block of a CSS file whose selector list starts with `selector`. */
function block(css: string, selector: string) {
  const start = css.indexOf(`${selector}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function declaration(css: string, name: string) {
  return css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
}

describe("skylcn-ui theme contract", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
  const tokensFile = createRequire(import.meta.url).resolve("@skylab-kulubu/skylcn-ui/tokens.css");
  // The dark set is the default (`:root, [data-theme='dark']`) and the only one this app shows.
  const skylcnDark = block(readFileSync(tokensFile, "utf8"), ":root,\n[data-theme='dark']");
  const accountTokens = block(css, ":root {");

  /** An Account Center token's value, followed through `var(--skylcn-token)` to a hex colour. */
  function resolveHex(name: string): string {
    const value = declaration(accountTokens, name) ?? declaration(skylcnDark, name);
    expect(value, `--${name} is defined`).toBeDefined();
    const reference = value!.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
    if (reference) return resolveHex(reference);
    expect(value, `--${name} resolves to a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
    return value!;
  }

  it("imports the skylcn-ui base theme right after Tailwind, then only the components it renders", () => {
    // Sources are named, never detected: detection would scan the whole skylcn-ui package
    expect(css).toMatch(/^@import "tailwindcss" source\(none\);\s*(?:\/\*[\s\S]*?\*\/\s*)?@source "\.\.\/";\s*(?:\/\*[\s\S]*?\*\/\s*)?@import "@skylab-kulubu\/skylcn-ui\/theme-base\.css";/);
    // theme.css scans every component (about 95 KB more CSS); one stylesheet per rendered component instead
    expect(css).not.toContain("@skylab-kulubu/skylcn-ui/theme.css");
    expect(css).not.toMatch(/@source not/);
    const sources = [...css.matchAll(/@import "@skylab-kulubu\/skylcn-ui\/sources\/([a-z-]+)\.css";/g)].map((match) => match[1]);
    expect(sources).toEqual(["button", "feedback", "form-extra", "skylab-loader", "state-card", "switch", "task-page"]);
    for (const source of sources) {
      expect(() => createRequire(import.meta.url).resolve(`@skylab-kulubu/skylcn-ui/sources/${source}.css`)).not.toThrow();
    }
  });

  it("keeps its element rules in the base layer, so skylcn component utilities win over them", () => {
    const unlayered = css.replace(/@layer base \{[\s\S]*?\n\}\n/, "");
    for (const selector of ["html {", "body {", "a {", ":focus-visible {"]) {
      expect(unlayered, selector).not.toMatch(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
    }
    expect(css).toMatch(/@layer base \{[\s\S]*?\n  :focus-visible \{/);
  });

  it("points its own colour tokens at skylcn-ui tokens", () => {
    expect(declaration(accountTokens, "surface-page")).toBe("var(--sidebar)");
    expect(declaration(accountTokens, "ink")).toBe("var(--foreground)");
    expect(declaration(accountTokens, "ink-muted")).toBe("var(--muted-foreground)");
    expect(declaration(accountTokens, "ink-faint")).toBe("var(--subtle-foreground)");
    expect(declaration(accountTokens, "danger")).toBe("var(--destructive)");
    for (const name of ["surface-card", "surface-raised", "surface-hover", "primary-muted", "danger-muted", "focus"]) {
      expect(declaration(accountTokens, name), `--${name}`).toMatch(/var\(--[a-z0-9-]+\)/);
      expect(declaration(accountTokens, name), `--${name} has no colour literal`).not.toMatch(/#|rgba?\(/);
    }
  });

  it("leaves the names skylcn-ui owns to skylcn-ui", () => {
    // skylcn's --accent is a neutral hover wash, not the lilac brand colour; its
    // components read it, so redefining it here would repaint them.
    for (const name of ["accent", "border", "border-subtle", "border-strong", "primary", "ring"]) {
      expect(declaration(accountTokens, name), `--${name}`).toBeUndefined();
    }
    expect(css).not.toMatch(/--color-skylab-\d+:/);
  });

  it("keeps primary and muted text readable on the page surface", () => {
    const surface = resolveHex("surface-page");

    expect(contrast(resolveHex("ink"), surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(resolveHex("ink-muted"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveHex("ink-faint"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveHex("danger"), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("never truncates critical status badge meaning", () => {
    expect(css).not.toMatch(/\.status-badge\s*\{[^}]*text-overflow:\s*ellipsis/s);
  });
});
