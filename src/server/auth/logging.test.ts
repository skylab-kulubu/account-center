import { describe, expect, it } from "vitest";
import { redactAuthMaterial } from "@/server/auth/logging";

describe("authentication log redaction", () => {
  it("redacts authentication material and PII recursively", () => {
    expect(redactAuthMaterial({
      event: "failure",
      authorization: "Bearer secret",
      nested: { refreshToken: "refresh", email: "person@example.com" },
    })).toEqual({
      event: "failure",
      authorization: "[REDACTED]",
      nested: { refreshToken: "[REDACTED]", email: "[REDACTED]" },
    });
  });

  it("keeps the failed login's flow and allowlisted OAuth error", () => {
    expect(redactAuthMaterial({
      event: "oidc_login_failed",
      providerStage: "authorization_response",
      purpose: "ytu_link",
      oauthError: "access_denied",
    })).toEqual({
      event: "oidc_login_failed",
      providerStage: "authorization_response",
      purpose: "ytu_link",
      oauthError: "access_denied",
    });
  });

  it("keeps the e-mail page's action kind while any e-mail-named key is blanked", () => {
    expect(redactAuthMaterial({
      event: "email_action",
      addressAction: "confirm",
      reason: "code_exhausted",
      emailAction: "would-be-redacted",
    })).toEqual({
      event: "email_action",
      addressAction: "confirm",
      reason: "code_exhausted",
      emailAction: "[REDACTED]",
    });
  });
});
