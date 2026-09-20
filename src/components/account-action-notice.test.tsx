import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountActionNotice } from "@/components/account-action-notice";

describe("AccountActionNotice", () => {
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders first, then acknowledges through the session-bound endpoint", () => {
    const reference = "r".repeat(43);
    render(
      <AccountActionNotice
        result={{ action: "otp", outcome: "success" }}
        reference={reference}
        csrfToken="session-proof"
      />,
    );

    expect(screen.getByText("İşlem tamamlandı")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      `/api/auth/action-result/${reference}`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": "session-proof" },
      },
    );
  });

  it("keeps the notice visible when acknowledgement delivery fails", () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network failed"));
    render(
      <AccountActionNotice
        result={{ action: "passkey", outcome: "unverified" }}
        reference={"u".repeat(43)}
        csrfToken="session-proof"
      />,
    );

    expect(screen.getByText("İşlem doğrulanamadı")).toBeInTheDocument();
    expect(screen.getByText(/güncel hesap durumunda doğrulanamadı/)).toBeInTheDocument();
  });

  it("does not acknowledge forged query state without a server-read result", () => {
    render(
      <AccountActionNotice
        result={null}
        reference={"f".repeat(43)}
        csrfToken="session-proof"
      />,
    );

    expect(fetch).not.toHaveBeenCalled();
  });
});
