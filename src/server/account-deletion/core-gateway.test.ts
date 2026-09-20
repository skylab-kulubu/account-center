// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoreAccountDeletionConflictError,
  CoreAccountDeletionHttpGateway,
  CoreAccountDeletionNotFoundError,
  CoreAccountDeletionUnauthorizedError,
  CoreAccountDeletionUnavailableError,
} from "@/server/account-deletion/core-gateway";

const receipt = `adr_${"r".repeat(43)}`;
const valid = {
  receipt,
  status: "processing",
  partial: true,
  platformBlocked: true,
  requestedAt: "2026-09-20T12:00:01.000Z",
  updatedAt: "2026-09-20T12:00:02.000Z",
  completedAt: null,
  receiptExpiresAt: "2026-10-20T12:00:01.000Z",
};
const statusResponse = Object.fromEntries(
  Object.entries(valid).filter(([key]) => key !== "receipt"),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Core self-delete HTTP gateway", () => {
  it("sends the fresh user token and 43-char idempotency key with no subject or body", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(valid, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));

    await expect(gateway.initiate({
      accessToken: "fresh-user-token",
      reauthenticationToken: "fresh-id-token",
      idempotencyKey: "i".repeat(43),
    })).resolves.toEqual({
      receipt,
      status: "processing",
      partial: true,
      requestedAt: valid.requestedAt,
      updatedAt: valid.updatedAt,
      completedAt: null,
      receiptExpiresAt: valid.receiptExpiresAt,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.yildizskylab.com/v1/account-deletion-requests/self"),
      expect.objectContaining({
        method: "POST",
        body: null,
        redirect: "error",
        cache: "no-store",
        headers: expect.objectContaining({
          authorization: "Bearer fresh-user-token",
          "x-account-reauth-token": "fresh-id-token",
          "idempotency-key": "i".repeat(43),
          accept: "application/json",
        }),
      }),
    );
    expect(JSON.stringify(fetch.mock.calls[0]?.[1])).not.toContain("subject");
  });

  it("keeps the receipt only in the authorization header for status and retry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(statusResponse))
      .mockResolvedValueOnce(Response.json(statusResponse, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));

    await gateway.status(receipt);
    await gateway.retry(receipt);

    expect(fetch.mock.calls[0]?.[0]).toEqual(
      new URL("https://api.yildizskylab.com/v1/account-deletion-requests/status"),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      body: null,
      headers: { authorization: `DeletionReceipt ${receipt}`, accept: "application/json" },
    });
    expect(fetch.mock.calls[1]?.[0]).toEqual(
      new URL("https://api.yildizskylab.com/v1/account-deletion-requests/status/retry"),
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: null });
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain(receipt);
  });

  it("rejects malformed or overbroad responses instead of trusting Core drift", async () => {
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));
    for (const body of [
      { ...statusResponse, receipt: "raw-receipt" },
      { ...statusResponse, status: "deleted" },
      { ...statusResponse, subject: "leaked-subject" },
      { ...statusResponse, receiptExpiresAt: "not-a-date" },
      { ...statusResponse, status: "completed", completedAt: null },
      { ...statusResponse, platformBlocked: false },
      Object.fromEntries(Object.entries(statusResponse).filter(([key]) => key !== "platformBlocked")),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(gateway.status(receipt)).rejects.toBeInstanceOf(CoreAccountDeletionUnavailableError);
    }
  });

  it("accepts receipt only on initiation and strips platformBlocked from the internal result", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(valid, { status: 202 }))
      .mockResolvedValueOnce(Response.json(statusResponse));
    vi.stubGlobal("fetch", fetch);
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));

    await expect(gateway.initiate({
      accessToken: "fresh-user-token",
      reauthenticationToken: "fresh-id-token",
      idempotencyKey: "i".repeat(43),
    })).resolves.not.toHaveProperty("platformBlocked");
    await expect(gateway.status(receipt)).resolves.toMatchObject({ receipt });
  });

  it("fails closed when a command HTTP status disagrees with Core lifecycle terminality", async () => {
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));
    const manual = { ...valid, status: "manual_intervention" };
    const manualStatus = { ...statusResponse, status: "manual_intervention" };
    const pendingStatus = { ...statusResponse, status: "pending" };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(valid, { status: 200 })));
    await expect(gateway.initiate({
      accessToken: "fresh-user-token",
      reauthenticationToken: "fresh-id-token",
      idempotencyKey: "i".repeat(43),
    })).rejects.toBeInstanceOf(CoreAccountDeletionUnavailableError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(manual, { status: 202 })));
    await expect(gateway.initiate({
      accessToken: "fresh-user-token",
      reauthenticationToken: "fresh-id-token",
      idempotencyKey: "i".repeat(43),
    })).rejects.toBeInstanceOf(CoreAccountDeletionUnavailableError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(manualStatus, { status: 200 })));
    await expect(gateway.retry(receipt)).resolves.toMatchObject({ status: "manual_intervention" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(pendingStatus, { status: 202 })));
    await expect(gateway.retry(receipt)).resolves.toMatchObject({ status: "pending" });
  });

  it("maps only the fixed generic error statuses and never includes upstream bodies", async () => {
    const gateway = new CoreAccountDeletionHttpGateway(new URL("https://api.yildizskylab.com"));
    const cases = [
      [401, CoreAccountDeletionUnauthorizedError],
      [404, CoreAccountDeletionNotFoundError],
      [409, CoreAccountDeletionConflictError],
      [503, CoreAccountDeletionUnavailableError],
    ] as const;
    for (const [status, ErrorType] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret upstream detail", { status })));
      const rejection = gateway.status(receipt);
      await expect(rejection).rejects.toBeInstanceOf(ErrorType);
      await expect(rejection).rejects.not.toThrow(/secret upstream detail/);
    }
  });
});
