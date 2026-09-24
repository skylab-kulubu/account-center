import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDeletionConfirmation } from "@/components/account-deletion-confirmation";
import { AccountDeletionStatus } from "@/components/account-deletion-status";

const sudo = vi.hoisted(() => ({ ensureSudo: vi.fn() }));

vi.mock("@/components/sudo-provider", () => ({
  useSudo: () => ({ ensureSudo: sudo.ensureSudo, invalidateSudo: vi.fn(), sudoExpiresAt: null }),
}));

beforeEach(() => {
  sudo.ensureSudo.mockReset();
  sudo.ensureSudo.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function prepared(step: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ step }));
}

const startButton = () => screen.getByRole("button", { name: "Hesabımı silmek istiyorum" });

describe("account deletion UI", () => {
  it("asks for Sudo mode between the intent and the exact confirmation", async () => {
    const request = prepared("confirm");
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />);
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();

    fireEvent.click(startButton());
    const confirmation = await screen.findByLabelText(/onay metni/i);
    expect(sudo.ensureSudo).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("/api/account/deletion/prepare", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { "x-csrf-token": "session-csrf" },
    });

    const submit = screen.getByRole("button", { name: "Hesabımı kalıcı olarak sil" });
    expect(submit).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "hesabımı sil" } });
    expect(submit).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "HESABIMI SİL" } });
    expect(submit).toBeEnabled();
    expect(confirmation.closest("form")).toHaveAttribute("action", "/api/account/deletion");
  });

  it("never offers a Keycloak step, whatever the BFF answers", async () => {
    prepared("keycloak_reauthentication");
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />);

    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/kısa bir süre sonra tekrar dene/i));
    expect(screen.queryByRole("button", { name: /keycloak/i })).not.toBeInTheDocument();
    expect(document.querySelector("form[action='/api/account/deletion/reauthenticate']")).toBeNull();
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
  });

  it("asks for another try when the proof still carries nothing core can verify", async () => {
    const challenge = () => new Response(JSON.stringify({
      error: "sudo_required",
      reason: "spi_token_required",
      methods: [],
      fallback: "microsoft",
    }), { status: 428, headers: { "content-type": "application/json" } });
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(challenge());
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />);

    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/hesap silme için ek doğrulama gerekiyor/i));
    expect(request).toHaveBeenCalledTimes(2);
    expect(sudo.ensureSudo).toHaveBeenLastCalledWith({ challenged: true });
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
  });

  it("says to try again shortly when the deletion service is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "unavailable" }),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "3" } },
    ));
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />);

    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      /hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene/i,
    ));
    expect(startButton()).toBeEnabled();
  });

  it("prepares nothing when the person dismisses the Sudo mode dialog", async () => {
    const request = prepared("confirm");
    sudo.ensureSudo.mockResolvedValue(false);
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated={false} />);

    fireEvent.click(startButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/kimlik doğrulaman tamamlanmadı/i));
    expect(request).not.toHaveBeenCalled();
    expect(startButton()).toBeEnabled();
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
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
        deletionError="deletion_unavailable"
        enabled
        reauthenticated={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/kısa bir süre sonra tekrar dene/i);

    // A proof cookie alone reopens the confirmation, but an expired sudo proof
    // sends the person back through the identity step.
    cleanup();
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated />);
    expect(screen.getByLabelText(/onay metni/i)).toBeInTheDocument();

    cleanup();
    render(
      <AccountDeletionConfirmation
        csrfToken="session-csrf"
        deletionError="sudo_required"
        enabled
        reauthenticated
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/kimlik doğrulaman geçerliliğini yitirdi/i);
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
    expect(startButton()).toBeEnabled();

    // Core refused the proof: nothing changed, and the person proves themselves again.
    cleanup();
    render(
      <AccountDeletionConfirmation
        csrfToken="session-csrf"
        deletionError="sudo_rejected"
        enabled
        reauthenticated
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /kimlik doğrulaman kabul edilmedi ya da süresi doldu\. hesabında hiçbir değişiklik yapılmadı/i,
    );
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
    expect(startButton()).toBeEnabled();
  });

  it("stays inert with no start control while the flow is disabled", () => {
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled={false} reauthenticated />);
    expect(screen.getByText("Silme akışı henüz etkin değil")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/onay metni/i)).not.toBeInTheDocument();
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

  // The page cannot tell whether core accepted the request: core refused the
  // sealed credentials on the recovery replay, or the recovery window closed
  // before an answer came. Saying nothing changed would be a guess.
  it("says the request may already be under way when its outcome cannot be verified", async () => {
    const honest = async () => {
      expect(await screen.findByRole("heading", { name: "Durum doğrulanamadı" })).toBeInTheDocument();
      expect(screen.getByText(/silme isteğin işleme alınmış olabilir/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login");
      expect(screen.getByRole("button", { name: "Yeniden kontrol et" })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/değişmedi|hiçbir değişiklik/i);
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "outcome_unknown" }, { status: 409 }));
    const refused = render(<AccountDeletionStatus />);
    await honest();
    refused.unmount();

    // Sent here because the answer was lost, and the window has since closed.
    window.history.replaceState(null, "", "/account-deletion?recovery=1");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }));
      render(<AccountDeletionStatus />);
      await honest();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
