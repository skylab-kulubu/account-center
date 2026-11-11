import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPreferencesList } from "@/components/app-preferences-list";

let fetchMock: ReturnType<typeof vi.fn>;

const forms = { app: "forms", keys: 2, updatedAt: "2026-11-08T10:00:00Z" };
const panel = { app: "panel", keys: 1, updatedAt: "2026-11-07T09:00:00Z" };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderList(initial = [forms, panel]) {
  return render(<AppPreferencesList initial={initial} csrfToken="session-bound-csrf" />);
}

describe("AppPreferencesList", () => {
  it("says there is nothing stored when the list is empty", () => {
    renderList([]);
    expect(screen.getByText("Kayıtlı ayar yok.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sıfırla/i })).not.toBeInTheDocument();
  });

  it("shows each app's Turkish name and key count, never a value", () => {
    renderList();
    expect(screen.getByText("Forms")).toBeInTheDocument();
    expect(screen.getByText("Yönetim paneli")).toBeInTheDocument();
    expect(screen.getByText(/2 ayar · Son değişiklik/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tümünü sıfırla" })).toBeInTheDocument();
  });

  it("offers no reset-all for a single app", () => {
    renderList([forms]);
    expect(screen.queryByRole("button", { name: "Tümünü sıfırla" })).not.toBeInTheDocument();
  });

  it("asks first, then resets one app with DELETE", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "Forms ayarlarını sıfırla" }));
    const dialog = screen.getByRole("alertdialog", { name: "Forms ayarları varsayılana dönsün mü?" });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sıfırla" }));

    expect(await screen.findByText("Forms ayarları sıfırlandı.")).toHaveAttribute("role", "status");
    expect(fetchMock).toHaveBeenCalledWith("/api/account/app-preferences/forms", expect.objectContaining({
      method: "DELETE",
      credentials: "same-origin",
      headers: { "x-csrf-token": "session-bound-csrf" },
    }));
    expect(screen.queryByText("Forms")).not.toBeInTheDocument();
    expect(screen.getByText("Yönetim paneli")).toBeInTheDocument();
  });

  it("resets every app with reset-all", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "Tümünü sıfırla" }));
    const dialog = screen.getByRole("alertdialog", { name: "Bütün uygulama ayarları varsayılana dönsün mü?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tümünü sıfırla" }));

    expect(await screen.findByText("Bütün uygulama ayarları sıfırlandı.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Kayıtlı ayar yok.")).toBeInTheDocument();
  });

  it("keeps the app and says why when the reset fails", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ title: "Çok fazla istek" }), { status: 429 }));
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "Forms ayarlarını sıfırla" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Sıfırla" }));

    expect(await within(dialog).findByText("Çok fazla istek")).toBeInTheDocument();
    expect(screen.getAllByText("Forms").length).toBeGreaterThan(0);
  });
});
