import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/components/session-manager";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const currentSession = {
  reference: null,
  startedAt: "2026-09-20T08:00:00.000Z",
  lastAccessAt: "2026-09-20T10:00:00.000Z",
  expiresAt: "2026-09-20T16:00:00.000Z",
  browser: "Chrome/140.0",
  current: true,
  device: {
    name: "MacBook",
    operatingSystem: "macOS",
    operatingSystemVersion: "15.6",
    mobile: false,
  },
};

const otherReference = "o".repeat(43);
const otherSession = {
  reference: otherReference,
  startedAt: "2026-09-19T08:00:00.000Z",
  lastAccessAt: "2026-09-19T10:00:00.000Z",
  expiresAt: "2026-09-20T16:00:00.000Z",
  browser: "Mobile Safari/26.0",
  current: false,
  device: {
    name: "iPhone",
    operatingSystem: "iOS",
    operatingSystemVersion: "26.0",
    mobile: true,
  },
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function sessionsResponse(sessions = [currentSession, otherSession]) {
  return json({ sessions, csrfToken: "session-bound-csrf" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionManager", () => {
  it("shows safe device details and exposes revoke only for another session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionsResponse());

    const { container } = render(<SessionManager />);

    expect(await screen.findByText("MacBook · macOS · 15.6")).toBeInTheDocument();
    expect(screen.getByText("iPhone · iOS · 26.0")).toBeInTheDocument();
    expect(screen.getByText("Bu oturum")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Oturumu kapat" })).toHaveLength(1);
    expect(container.textContent).not.toContain(otherReference);
  });

  it("confirms and idempotently revokes one opaque session reference", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionsResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(sessionsResponse([currentSession]));
    render(<SessionManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Oturumu kapat" }));
    const dialog = screen.getByRole("dialog", { name: "Oturumu kapat" });
    expect(within(dialog).getByText(/cihazındaki hesabına erişim sona erecek/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Oturumu kapat" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      `/api/account/sessions/${encodeURIComponent(otherReference)}`,
      {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-csrf-token": "session-bound-csrf" },
      },
    ));
    const success = await screen.findByText("Oturum kapatıldı.");
    expect(success).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("iPhone · iOS · 26.0")).not.toBeInTheDocument());
    await waitFor(() => expect(success).toHaveFocus());
  });

  it("requires confirmation before revoking every other session", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionsResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(sessionsResponse([currentSession]));
    render(<SessionManager />);

    const trigger = await screen.findByRole("button", { name: "Diğer tüm oturumları kapat" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Diğer tüm oturumları kapat" });
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Diğer tüm oturumları kapat" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith(
      "/api/account/sessions",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(await screen.findByText("Diğer oturumlar kapatıldı.")).toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-disabled", "true");
  });

  it("opens a native modal and restores trigger focus after keyboard cancellation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionsResponse());
    render(<SessionManager />);

    const trigger = await screen.findByRole("button", { name: "Oturumu kapat" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Oturumu kapat" });
    expect(dialog).toHaveAttribute("open");
    const close = within(dialog).getByRole("button", { name: "Pencereyi kapat" });
    const confirm = within(dialog).getByRole("button", { name: "Oturumu kapat" });
    expect(close).toHaveFocus();

    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each([
    { label: "zero", sessions: [otherSession] },
    {
      label: "multiple",
      sessions: [{ ...currentSession }, { ...currentSession, browser: "Firefox/142.0" }],
    },
  ])("fails closed when a non-empty browser payload has $label current sessions", async ({ sessions }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sessionsResponse(sessions));
    render(<SessionManager />);

    expect(await screen.findByText("Oturumlar güvenle durduruldu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Oturumu kapat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diğer tüm oturumları kapat" })).not.toBeInTheDocument();
  });

  it("keeps an empty state and a retryable upstream-unavailable state usable", async () => {
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({
        title: "Kimlik hizmetine şu anda ulaşılamıyor",
        detail: "Hesap bilgilerin değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      }, 503))
      .mockResolvedValueOnce(sessionsResponse([]));
    render(<SessionManager />);

    expect(await screen.findByText("Kimlik hizmetine şu anda ulaşılamıyor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));

    expect(await screen.findByText("Açık oturum bulunamadı")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves the visible list when an upstream revoke is unavailable", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionsResponse())
      .mockResolvedValueOnce(json({
        title: "Kimlik hizmetine şu anda ulaşılamıyor",
        detail: "Oturumların değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.",
      }, 503));
    render(<SessionManager />);

    fireEvent.click(await screen.findByRole("button", { name: "Oturumu kapat" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Oturumu kapat" }));

    expect(await screen.findByText("Oturumların değişmedi. Kısa bir süre sonra yeniden deneyebilirsin.")).toBeInTheDocument();
    expect(screen.getByText("iPhone · iOS · 26.0")).toBeInTheDocument();
  });
});
