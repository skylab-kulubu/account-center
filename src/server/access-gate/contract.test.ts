// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ACCESS_ISSUER,
  ACCOUNT_ACCESS_MARKER_PREFIX,
  accountAccessMarkerKey,
  accountAccessSubjectDigest,
} from "@/server/access-gate/contract";

describe("account access v1 key contract", () => {
  it("matches the cross-language golden vector exactly", () => {
    const subject = "11111111-1111-1111-1111-111111111111";
    const digest = accountAccessSubjectDigest(ACCOUNT_ACCESS_ISSUER, subject);

    expect(digest).toBe("0be50f44b14aa5ca5ae10cfedf7e4986d4d56ddf17b9055e99f3fedcbdb880ff");
    expect(accountAccessMarkerKey(ACCOUNT_ACCESS_ISSUER, subject)).toBe(
      `${ACCOUNT_ACCESS_MARKER_PREFIX}${digest}`,
    );
    expect(accountAccessMarkerKey(ACCOUNT_ACCESS_ISSUER, subject)).not.toContain(subject);
  });

  it("does not normalize issuer or subject input", () => {
    const subject = "Case-Sensitive-Subject";
    expect(accountAccessSubjectDigest(`${ACCOUNT_ACCESS_ISSUER}/`, subject)).not.toBe(
      accountAccessSubjectDigest(ACCOUNT_ACCESS_ISSUER, subject),
    );
    expect(accountAccessSubjectDigest(ACCOUNT_ACCESS_ISSUER, subject.toLowerCase())).not.toBe(
      accountAccessSubjectDigest(ACCOUNT_ACCESS_ISSUER, subject),
    );
  });
});
