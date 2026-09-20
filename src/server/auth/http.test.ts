import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { AesGcmSecretCipher } from "@/server/auth/crypto";
import type { AuthConfig } from "@/server/auth/config";
import {
  mutationHasExactOrigin,
  requestWantsHtmlNavigation,
  sessionMutationHasExactOrigin,
} from "@/server/auth/http";
import type { SessionRepository } from "@/server/auth/repositories";
import { SessionManager } from "@/server/auth/sessions";

const config = { appUrl: new URL("https://my.yildizskylab.com") } as AuthConfig;
const sessions = new SessionManager(
  {} as SessionRepository,
  new AesGcmSecretCipher(Buffer.alloc(32, 1)),
  Buffer.alloc(32, 2),
  { absoluteTtlSeconds: 1, upstreamSessionMaxSeconds: 1, idleTtlSeconds: 1, rotationSeconds: 1, previousHandleGraceSeconds: 1 },
);

describe("mutation request protection", () => {
  it("requires the exact configured origin", () => {
    expect(mutationHasExactOrigin(new NextRequest("https://my.yildizskylab.com/api", {
      method: "POST",
      headers: { origin: "https://my.yildizskylab.com", "sec-fetch-site": "same-origin" },
    }), config)).toBe(true);
    expect(mutationHasExactOrigin(new NextRequest("https://my.yildizskylab.com/api", {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    }), config)).toBe(false);
    for (const origin of [
      "https://my.yildizskylab.com/",
      "https://my.yildizskylab.com/path",
      "https://user@my.yildizskylab.com",
      "https://MY.YILDIZSKYLAB.COM",
    ]) {
      expect(mutationHasExactOrigin(new NextRequest("https://my.yildizskylab.com/api", {
        method: "POST",
        headers: { origin, "sec-fetch-site": "same-origin" },
      }), config)).toBe(false);
    }
    expect(mutationHasExactOrigin(new NextRequest("https://my.yildizskylab.com/api", { method: "POST" }), config)).toBe(false);
  });

  it.each([
    "https://my.yildizskylab.com/",
    "https://my.yildizskylab.com/path",
    "https://user@my.yildizskylab.com",
    "https://my.yildizskylab.com:443",
    "HTTPS://my.yildizskylab.com",
  ])("rejects non-identical serialized session mutation origin %s", (origin) => {
    const request = new NextRequest("https://my.yildizskylab.com/api/account/sessions", {
      method: "DELETE",
      headers: { origin, "sec-fetch-site": "same-origin" },
    });

    expect(sessionMutationHasExactOrigin(request, config)).toBe(false);
  });

  it("accepts only the configured raw origin for session mutation", () => {
    const request = new NextRequest("https://my.yildizskylab.com/api/account/sessions", {
      method: "DELETE",
      headers: {
        origin: "https://my.yildizskylab.com",
        "sec-fetch-site": "same-origin",
      },
    });

    expect(sessionMutationHasExactOrigin(request, config)).toBe(true);
  });

  it("generates session-specific CSRF proofs", () => {
    const csrfToken = sessions.csrfToken("session-one");
    expect(sessions.verifyCsrf("session-one", csrfToken)).toBe(true);
    expect(sessions.verifyCsrf("session-two", csrfToken)).toBe(false);
  });

  it("recognizes only an explicit browser document navigation as HTML", () => {
    const request = new NextRequest("https://my.yildizskylab.com/api/account/deletion", {
      method: "POST",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    expect(requestWantsHtmlNavigation(request)).toBe(true);
    const invalidHeaders: Array<Record<string, string>> = [
      { accept: "application/json", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      { accept: "text/html", "sec-fetch-mode": "cors", "sec-fetch-dest": "document" },
      { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty" },
      { accept: "text/html" },
    ];
    for (const headers of invalidHeaders) {
      expect(requestWantsHtmlNavigation(new NextRequest(request.url, {
        method: "POST",
        headers,
      }))).toBe(false);
    }
  });
});
