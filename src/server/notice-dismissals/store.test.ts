// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "@/server/auth/crypto";
import { NoticeDismissals } from "@/server/notice-dismissals/store";
import type { NoticeDismissalRepository } from "@/server/notice-dismissals/store";

const secret = Buffer.alloc(32, 7);
const now = new Date("2026-10-03T12:00:00.000Z");

function repository(): NoticeDismissalRepository & { [K in keyof NoticeDismissalRepository]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn().mockResolvedValue([]),
    dismiss: vi.fn().mockResolvedValue(undefined),
    forget: vi.fn().mockResolvedValue(undefined),
  };
}

describe("NoticeDismissals", () => {
  it("keys every row by an HMAC of the subject, never the subject itself", async () => {
    const rows = repository();
    const store = new NoticeDismissals(rows, secret, () => now);
    const digest = hmacSha256(secret, "notice-dismissal-subject", "kc-subject");

    await store.dismiss("kc-subject", "add-personal");
    await store.list("kc-subject");
    await store.forget("kc-subject");

    expect(rows.dismiss).toHaveBeenCalledWith(digest, "add-personal", now);
    expect(rows.list).toHaveBeenCalledWith(digest);
    expect(rows.forget).toHaveBeenCalledWith(digest);
    expect(JSON.stringify([rows.dismiss.mock.calls, rows.list.mock.calls, rows.forget.mock.calls])).not.toContain("kc-subject");
    expect(digest).not.toEqual(hmacSha256(secret, "account-deletion-subject", "kc-subject"));
  });

  it("answers the known nudges only, ignoring a row an older or newer build wrote", async () => {
    const rows = repository();
    rows.list.mockResolvedValue(["add-personal", "something-else"]);
    const store = new NoticeDismissals(rows, secret, () => now);

    expect([...await store.list("kc-subject")]).toEqual(["add-personal"]);
  });
});
