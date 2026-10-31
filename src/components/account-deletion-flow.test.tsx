import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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

  it("says what backups and old addresses keep, as part of the confirmation", () => {
    render(<AccountDeletionConfirmation csrfToken="session-csrf" enabled reauthenticated />);
    const confirmation = screen.getByLabelText(/onay metni/i);
    const limits = screen.getAllByRole("listitem");

    expect(limits.map((limit) => limit.textContent)).toEqual([
      "Verilerin şifreli yedeklerde en çok 90 gün daha kalır. Bu sürede bir yedekten geri dönülürse silme yeniden uygulanır.",
      "Eski e-posta adreslerin saklanmaz. Bu yüzden yalnız eski bir adresinle kaydedilmiş veriler silinmeyebilir.",
    ]);
    for (const limit of limits) {
      // Read in order before the field, not announced as a status or hidden.
      expect(limit.compareDocumentPosition(confirmation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(limit.closest("[role='status'], [aria-live], [aria-hidden='true']")).toBeNull();
    }
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

  it("server-renders the waiting page with its loader and without inline styles, which the page's CSP refuses", () => {
    const html = renderToString(<AccountDeletionStatus />);

    expect(html).toContain("Silme isteğinin durumu alınıyor");
    expect(html).toContain('data-slot="skylab-loader"');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("shows the loader under the page's one heading until the status arrives", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: "pending",
      partial: false,
      requestedAt: "2026-09-20T12:00:01.000Z",
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      awaitingManualStep: false,
      csrfToken: "c".repeat(43),
    }));
    render(<AccountDeletionStatus />);

    const waiting = screen.getByRole("heading", { level: 1, name: "Silme isteğinin durumu alınıyor" });
    expect(waiting.parentElement).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("heading", { level: 1, name: "Verilerin siliniyor" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("polls status without putting the receipt in HTML, URL, or browser storage", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      status: "processing",
      partial: true,
      requestedAt: "2026-09-20T12:00:01.000Z",
      updatedAt: "2026-09-20T12:00:02.000Z",
      completedAt: null,
      awaitingManualStep: false,
      csrfToken: "c".repeat(43),
    }));
    const { container } = render(<AccountDeletionStatus />);

    expect(await screen.findByRole("heading", { name: "Verilerin siliniyor" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith("/api/account/deletion/status", {
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(container.innerHTML).not.toContain("adr_");
    expect(window.location.href).not.toContain("adr_");
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("adr_");
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("adr_");
  });

  // Three steps, whatever core's twelve are doing: received, being erased
  // (with the last day, 30 days after the request), done. A request core
  // holds for its team is still being erased.
  it("shows three steps and the request's last day, never core's steps", async () => {
    for (const [status, title, current] of [
      ["blocking", "Talebin alınıyor", "Talep alındı"],
      ["pending", "Verilerin siliniyor", "Veriler siliniyor"],
      ["processing", "Verilerin siliniyor", "Veriler siliniyor"],
      ["manual_intervention", "Verilerin siliniyor", "Veriler siliniyor"],
      ["completed", "Hesabın silindi", null],
    ] as const) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
        status,
        partial: status !== "completed" && status !== "blocking",
        requestedAt: "2026-10-31T21:30:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        completedAt: status === "completed" ? "2026-11-01T10:00:00.000Z" : null,
        awaitingManualStep: false,
        csrfToken: "c".repeat(43),
      }));
      const view = render(<AccountDeletionStatus />);
      expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      const steps = screen.getAllByRole("listitem");
      expect(steps).toHaveLength(3);
      ["Talep alındı", "Veriler siliniyor", "Tamamlandı"].forEach((label, i) => expect(steps[i]).toHaveTextContent(label));
      const active = steps.filter((step) => step.getAttribute("aria-current") === "step");
      if (current === null) {
        expect(active).toHaveLength(0);
        expect(screen.queryByText(/En geç/)).not.toBeInTheDocument();
      } else {
        expect(active).toHaveLength(1);
        expect(active[0]).toHaveTextContent(current);
        // 21:30 UTC on 31 October is 1 November in Istanbul: the last day is 1 December.
        expect(screen.getByText("En geç 01.12.2026")).toBeInTheDocument();
      }
      expect(document.body.textContent).not.toMatch(/erase_|anonymi|identity|adım/i);
      view.unmount();
    }
  });

  it("offers an idempotent retry only for manual intervention", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        status: "manual_intervention",
        partial: true,
        requestedAt: "2026-09-20T12:00:01.000Z",
        updatedAt: "2026-09-20T12:00:02.000Z",
        completedAt: null,
        awaitingManualStep: false,
        csrfToken: "c".repeat(43),
      }))
      .mockResolvedValueOnce(Response.json({
        status: "pending",
        partial: true,
        requestedAt: "2026-09-20T12:00:01.000Z",
        updatedAt: "2026-09-20T12:00:03.000Z",
        completedAt: null,
        awaitingManualStep: false,
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
    expect(await screen.findByRole("heading", { name: "Verilerin siliniyor" })).toBeInTheDocument();
  });

  // The CMS has no erase endpoint yet: an operator carries out its step by
  // hand and the request goes on by itself. The page only says the data is
  // being erased and by when; a retry would only fail again.
  it("offers no retry while an operator carries out a step by hand", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      status: "manual_intervention",
      partial: true,
      requestedAt: "2026-10-31T21:30:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      completedAt: null,
      awaitingManualStep: true,
      csrfToken: "c".repeat(43),
    }));
    render(<AccountDeletionStatus />);

    expect(await screen.findByRole("heading", { level: 1, name: "Verilerin siliniyor" })).toBeInTheDocument();
    expect(screen.getByText("En geç 01.12.2026")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
