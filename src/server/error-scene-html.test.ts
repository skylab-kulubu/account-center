import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { errorSceneHtml, errorSceneResponse, wantsHtml } from "@/server/error-scene-html";

function styleOf(body: string) {
  return /<style>([\s\S]*)<\/style>/.exec(body)![1]!;
}

describe("error scene pages for route handlers", () => {
  it("draws the 503 scene with its words, and the time limit for a 504", () => {
    const unavailable = errorSceneHtml("unavailable", 503, "/").body;
    expect(unavailable).toContain('data-kind="unavailable" data-variant="A"');
    expect(unavailable).toContain("<h1>Sunucumuz yerinde yok</h1>");
    expect(unavailable).toContain('<a class="action" href="/">Yeniden dene</a>');
    expect(errorSceneHtml("unavailable", 504, "/").body).toContain('data-variant="B"');
  });

  it("draws one of the 429 drawings with that drawing's words", () => {
    const body = errorSceneHtml("tooManyRequests", 429, "/").body;
    expect(body).toMatch(/data-kind="tooManyRequests" data-variant="[AB]"/);
    expect(body).toMatch(/<h1>(Biraz yavaşla|Bir dakika bekle)<\/h1>/);
    expect(body).toContain('<p class="code">429</p>');
  });

  it("runs under a strict policy: no script, no style attribute, its one style element allowed by hash", () => {
    const { body, contentSecurityPolicy } = errorSceneHtml("unavailable", 503, "/");
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/\sstyle=/i);
    const hash = createHash("sha256").update(styleOf(body)).digest("base64");
    expect(contentSecurityPolicy).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    // The scenes' rules came along from the package
    expect(styleOf(body)).toContain(".skylcn-scene");
  });

  it("escapes the link it is given", () => {
    const body = errorSceneHtml("tooManyRequests", 429, '/api/auth/login?returnTo="><script>').body;
    expect(body).toContain('href="/api/auth/login?returnTo=&#34;&#62;&#60;script&#62;"');
  });

  it("answers with its status, its policy and no caching", async () => {
    const response = errorSceneResponse("unavailable", 503, "/", { "Retry-After": "3" });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    expect(await response.text()).toMatch(/^<!doctype html>/);
  });

  it("tells a browser's page load from a script's request", () => {
    expect(wantsHtml(new Request("https://x.test", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }))).toBe(true);
    expect(wantsHtml(new Request("https://x.test", { headers: { accept: "application/json" } }))).toBe(false);
    expect(wantsHtml(new Request("https://x.test"))).toBe(false);
  });
});
