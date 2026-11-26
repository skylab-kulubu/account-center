import "server-only";

import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import tooManyRequests from "@skylab-kulubu/skylcn-ui/error-scenes/tooManyRequests.json";
import unavailable from "@skylab-kulubu/skylcn-ui/error-scenes/unavailable.json";

/**
 * Whole-page errors that a route handler answers itself (a 503 or a 429 has to carry its
 * status, which a page cannot set), drawn with skylcn-ui's error scenes as plain HTML: the
 * drawing's markup and words from `error-scenes/<kind>.json`, its rules from
 * `error-scenes/error-scene.css`. No script and no inline style attribute; the one <style>
 * element is allowed by its hash, so the page keeps a strict policy of its own (these
 * routes are under /api, which the proxy's policy does not cover).
 */

type SceneWords = { code: string; title: string; description: string; action: string };
type SceneKind = { variants: string[]; random: string[]; text: { tr: Record<string, SceneWords> }; svg: Record<string, string> };

const KINDS = {
  unavailable: unavailable as SceneKind,
  tooManyRequests: tooManyRequests as SceneKind,
};

export type HtmlSceneKind = keyof typeof KINDS;

/**
 * The scenes' rules. Read from the package at run time (next.config.ts traces the file into
 * the standalone build for these routes); without it the drawing keeps its fallback colours
 * and stands still, and the page still says what happened.
 */
let sceneRules: string | null = null;
function readSceneRules() {
  if (sceneRules === null) {
    try {
      sceneRules = readFileSync(
        join(process.cwd(), "node_modules/@skylab-kulubu/skylcn-ui/dist/error-scenes/error-scene.css"),
        "utf8",
      );
    } catch {
      sceneRules = "";
    }
  }
  return sceneRules;
}

/**
 * skylcn-ui's tokens the scenes read, dark by default and light for a light system, and the
 * page around the scene in the Account Center's type (the page has no theme script).
 */
const PAGE_RULES = `
:root{color-scheme:dark light;--background:#171717;--foreground:#f5f5f5;--secondary-foreground:#e5e5e5;--muted-foreground:#a3a3a3;--subtle-foreground:#8c8c8c;--faint-foreground:#525252;--primary:#e0c8e5;--primary-foreground:#0a0a0a;--warning:#fbbf24;--info:#93c5fd;--destructive:#f87171;--border:rgb(255 255 255/10%)}
@media (prefers-color-scheme:light){:root{--background:#f6f4f1;--foreground:#1c1a18;--secondary-foreground:#2b2825;--muted-foreground:#57524c;--subtle-foreground:#6b665f;--faint-foreground:#8a847d;--primary:#6e4576;--primary-foreground:#ffffff;--warning:#a44a07;--info:#1d4ed8;--destructive:#b91c1c;--border:rgb(0 0 0/10%)}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--background);color:var(--foreground);font-family:"Space Grotesk",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{display:flex;min-height:100dvh;flex-direction:column;align-items:center;justify-content:center;padding:2.5rem 1.25rem;text-align:center}
main .skylcn-scene{width:100%;max-width:18rem;height:auto;margin-bottom:2rem}
.code{margin:0 0 .75rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;letter-spacing:.2em;color:var(--subtle-foreground)}
h1{margin:0;font-size:1.5rem;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.line{max-width:28rem;margin:.75rem 0 0;font-size:.9375rem;line-height:1.6;color:var(--muted-foreground)}
.action{display:inline-flex;align-items:center;justify-content:center;margin-top:1.75rem;min-height:2.5rem;padding:0 1rem;border-radius:.5rem;border:1px solid var(--border);background:var(--primary);color:var(--primary-foreground);font-size:.875rem;font-weight:500;text-decoration:none}
.action:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
`;

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** The drawing for a status where a kind's drawings answer different causes; else one at random. */
function pickVariant(kind: HtmlSceneKind, status: number) {
  const scene = KINDS[kind];
  if (kind === "unavailable") return status === 504 ? "B" : "A";
  return scene.random[randomInt(scene.random.length)] ?? scene.variants[0]!;
}

export type ErrorScenePage = { body: string; contentSecurityPolicy: string };

/** The page for `kind` with HTTP `status`, its one button a link to `href`. */
export function errorSceneHtml(kind: HtmlSceneKind, status: number, href: string): ErrorScenePage {
  const scene = KINDS[kind];
  const variant = pickVariant(kind, status);
  const words = scene.text.tr[variant]!;
  const style = `${readSceneRules()}\n${PAGE_RULES}`;
  const styleHash = createHash("sha256").update(style).digest("base64");
  const body = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(words.title)} | SKY LAB Hesap Merkezi</title><style>${style}</style></head>
<body><main>${scene.svg[variant]}<p class="code">${escapeHtml(words.code)}</p><h1>${escapeHtml(words.title)}</h1><p class="line">${escapeHtml(words.description)}</p><a class="action" href="${escapeHtml(href)}">${escapeHtml(words.action)}</a></main></body>
</html>`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `style-src 'sha256-${styleHash}'`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { body, contentSecurityPolicy };
}

/** Whether the request is a browser's page load (`Accept: text/html`), not a script's fetch. */
export function wantsHtml(request: Request) {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}

/** A response for the page, with its status, its policy and no caching. */
export function errorSceneResponse(kind: HtmlSceneKind, status: number, href: string, headers: Record<string, string> = {}) {
  const page = errorSceneHtml(kind, status, href);
  return new NextResponse(page.body, {
    status,
    headers: {
      ...headers,
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": page.contentSecurityPolicy,
    },
  });
}
