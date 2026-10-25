import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentCardRow } from "@/components/student-card-row";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRow(initialLinked = true) {
  return render(<StudentCardRow initialLinked={initialLinked} csrfToken="session-bound-csrf" />);
}

describe("StudentCardRow", () => {
  it("offers no removal while no card is bound", () => {
    renderRow(false);
    expect(screen.getByText("Öğrenci kartı bağlı değil")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kartı kaldır" })).not.toBeInTheDocument();
  });

  it("asks first, then removes the card with DELETE", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ profile: { studentCardLinked: false } }), { status: 200 }));
    renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Kartı kaldır" }));
    const dialog = screen.getByRole("dialog", { name: "Kart kaydı kaldırılsın mı?" });
    expect(dialog).toHaveTextContent("çip numarası silinir");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Kartı kaldır" }));

    expect(await screen.findByText("Kart kaydı kaldırıldı.")).toHaveAttribute("role", "status");
    expect(fetchMock).toHaveBeenCalledWith("/api/account/club-profile/student-card", expect.objectContaining({
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-csrf-token": "session-bound-csrf" },
    }));
    expect(screen.getByText("Öğrenci kartı bağlı değil")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kartı kaldır" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does nothing when the dialog is cancelled", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Kartı kaldır" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Vazgeç/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Öğrenci kartı bağlı")).toBeInTheDocument();
  });

  it("keeps the card shown as bound when the removal fails", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "Kulüp profiline şu anda ulaşılamıyor" }), { status: 503 }));
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Kartı kaldır" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Kartı kaldır" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Kulüp profiline şu anda ulaşılamıyor");
    expect(screen.getByText("Öğrenci kartı bağlı")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kartı kaldır" })).toBeInTheDocument();
  });

  it("links to login when the session has ended", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "Oturumun sona erdi" }), { status: 401 }));
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Kartı kaldır" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Kartı kaldır" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");
  });
});
