import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
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
    expect(sources).toEqual(["button", "dialog", "form-extra", "notice", "skylab-loader", "state-card", "switch", "task-page"]);
    for (const source of sources) {
      expect(() => createRequire(import.meta.url).resolve(`@skylab-kulubu/skylcn-ui/sources/${source}.css`)).not.toThrow();
    }
  });

  it("scans the module of every skylcn component the app renders", () => {
    // A component that moves to a module of its own loses its classes until its sheet is
    // imported above: Notice left feedback for notice in skylcn-ui 0.2.1.
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve("@skylab-kulubu/skylcn-ui"));
    const moduleOf = new Map<string, string>();
    for (const [, names, file] of readFileSync(join(dist, "index.js"), "utf8").matchAll(/export \{([^}]*)\} from '\.\/([^']+)';/g)) {
      for (const name of names!.split(",").map((part) => part.trim()).filter(Boolean)) moduleOf.set(name, file!);
    }
    const scanned = new Set(
      [...css.matchAll(/@import "(@skylab-kulubu\/skylcn-ui\/sources\/[a-z-]+\.css)";/g)].flatMap(([, sheet]) =>
        [...readFileSync(require.resolve(sheet!), "utf8").matchAll(/@source '\.\.\/\.\.\/([^']+)';/g)].map(([, file]) => file!),
      ),
    );
    const rendered = new Map<string, string>();
    for (const file of readdirSync(resolve(process.cwd(), "src"), { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx$/.test(file) || /\.test\.tsx$/.test(file)) continue;
      const source = readFileSync(resolve(process.cwd(), "src", file), "utf8");
      for (const [, names] of source.matchAll(/import \{([^}]*)\} from "@skylab-kulubu\/skylcn-ui";/g)) {
        for (const name of names!.split(",").map((part) => part.trim()).filter((part) => part && !part.startsWith("type "))) {
          expect(moduleOf.has(name), `${name} (${file}) is a skylcn-ui export`).toBe(true);
          rendered.set(name, moduleOf.get(name)!);
        }
      }
    }
    // Rendered without their sheet before 0.2.1 too; adding one changes how they look, so it is left to its own change.
    const notScannedYet = ["components/badge.js", "components/display-extra.js", "components/list.js"];
    const missing = [...rendered]
      .filter(([, file]) => file.startsWith("components/") && !scanned.has(file) && !notScannedYet.includes(file))
      .map(([name, file]) => `${name} needs sources/${file.slice("components/".length).replace(/\.js$/, ".css")}`);
    expect(missing).toEqual([]);
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
