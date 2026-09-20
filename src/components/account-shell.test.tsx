import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountShell, SESSION_REFRESH_INTERVAL_MS } from "@/components/account-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/security",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    const imageProps = { ...props };
    delete imageProps.priority;
    return createElement("img", { ...imageProps, alt: imageProps.alt ?? "" });
  },
}));

describe("AccountShell", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exposes the account navigation and marks the current page", () => {
    render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);

    expect(screen.getByRole("navigation", { name: "Hesap ayarları" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Giriş ve güvenlik" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "İçeriğe geç" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByText("İçerik")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Çıkış yap" })).toHaveLength(2);
    expect(document.querySelector('input[name="csrfToken"]')).toHaveValue("csrf-value");
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/session/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": "csrf-value" },
      }),
    );
  });

  it("refreshes periodically and on focus/visibility, then cleans up", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>,
    );
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const requestsBeforeFocus = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requestsBeforeFocus);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const requestsBeforeVisibility = fetchMock.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(requestsBeforeVisibility);
    visibility.mockRestore();

    const requestsBeforeUnmount = fetchMock.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeUnmount);
  });
});
