import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountDeletionConfirmation } from "@/components/account-deletion-confirmation";
import { AccountDeletionStatus } from "@/components/account-deletion-status";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("account deletion UI", () => {
  it("requires fresh reauthentication before showing the exact confirmation", () => {
    const { rerender } = render(
      <AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />,
    );
    expect(screen.getByRole("button", { name: "Kimliğimi yeniden doğrula" })).toBeEnabled();
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();

    rerender(
      <AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated />,
    );
    const confirmation = screen.getByLabelText(/onay metni/i);
    const submit = screen.getByRole("button", { name: "Hesabımı kalıcı olarak sil" });
    expect(submit).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "hesabımı sil" } });
    expect(submit).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "HESABIMI SİL" } });
    expect(submit).toBeEnabled();
  });

  it("shows only allowlisted Turkish recovery feedback", () => {
    const { rerender } = render(
      <AccountDeletionConfirmation
        csrfToken="session-csrf"
        deletionError="proof_expired"
        enabled
        reauthenticated={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/doğrulama süren doldu/i);

    rerender(
      <AccountDeletionConfirmation
        csrfToken="session-csrf"
        deletionError="reauth_unavailable"
        enabled
        reauthenticated={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/yeniden doğrulama başlatılamadı/i);
  });

  it("polls status without putting the receipt in HTML, URL, or browser storage", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: "processing",
      partial: true,
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      csrfToken: "c".repeat(43),
    }));
    const { container } = render(<AccountDeletionStatus />);

    expect(await screen.findByRole("heading", { name: "Hesabın siliniyor" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("/api/account/deletion/status", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(container.innerHTML).not.toContain("adr_");
    expect(window.location.href).not.toContain("adr_");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("adr_");
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("adr_");
  });

  it("offers an idempotent retry only for manual intervention", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        status: "manual_intervention",
        partial: true,
        updatedAt: "2026-09-20T12:00:02.000Z",
        completedAt: null,
        csrfToken: "c".repeat(43),
      }))
      .mockResolvedValueOnce(Response.json({
        status: "pending",
        partial: true,
        updatedAt: "2026-09-20T12:00:03.000Z",
        completedAt: null,
        csrfToken: "c".repeat(43),
      }));
    render(<AccountDeletionStatus />);

    fireEvent.click(await screen.findByRole("button", { name: "İşlemi yeniden dene" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(
      "/api/account/deletion/status/retry",
      {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": "c".repeat(43) },
      },
    ));
    expect(await screen.findByRole("heading", { name: "Silme isteğin sırada" })).toBeInTheDocument();
  });

  it("shows generic retryable and missing-receipt states without upstream details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "upstream_internal_secret" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const first = render(<AccountDeletionStatus />);
    expect(await screen.findByRole("heading", { name: "Durum alınamadı" })).toBeInTheDocument();
    expect(first.container.textContent).not.toContain("upstream_internal_secret");
    first.unmount();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
    render(<AccountDeletionStatus />);
    expect(await screen.findByRole("heading", { name: "Silme isteği bulunamadı" })).toBeInTheDocument();
  });
});
