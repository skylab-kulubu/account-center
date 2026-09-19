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
});
