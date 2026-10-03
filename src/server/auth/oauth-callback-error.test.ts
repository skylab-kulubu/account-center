import { describe, expect, it } from "vitest";
import { oauthCallbackError } from "@/server/auth/oauth-callback-error";

describe("OAuth callback error allowlist", () => {
  it.each([
    "access_denied",
    "login_required",
    "interaction_required",
    "consent_required",
    "temporarily_unavailable",
    "server_error",
    "invalid_request",
    "unauthorized_client",
    "invalid_scope",
  ])("names %s as itself", (error) => {
    expect(oauthCallbackError(new URLSearchParams({ error, error_description: "free text" }))).toBe(error);
  });

  it("calls anything else other, and says nothing when there is no error", () => {
    expect(oauthCallbackError(new URLSearchParams({ error: "ACCESS_DENIED" }))).toBe("other");
    expect(oauthCallbackError(new URLSearchParams({ error: "access_denied ada@example.com" }))).toBe("other");
    expect(oauthCallbackError(new URLSearchParams({ error: "" }))).toBe("other");
    expect(oauthCallbackError(new URLSearchParams({ code: "x", state: "y" }))).toBeUndefined();
  });
});
