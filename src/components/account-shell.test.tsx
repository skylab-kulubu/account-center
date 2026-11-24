import { act, cleanup, render, screen, within } from "@testing-library/react";
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
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the sections, marks the current one and keeps the sign-out form", () => {
    render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);

    const navigation = screen.getByRole("navigation", { name: "Hesap ayarları" });
    expect(Array.from(navigation.querySelectorAll("a"), (link) => link.textContent)).toEqual([
      "Ana sayfa",
      "Kişisel bilgiler",
      "Güvenlik",
      "Veri ve gizlilik",
      "Biletlerim",
      "Uygulamalar",
    ]);
    const nav = within(navigation);
    expect(nav.getByRole("link", { name: "Kişisel bilgiler" })).toHaveAttribute("href", "/personal-info");
    expect(nav.getByRole("link", { name: "Veri ve gizlilik" })).toHaveAttribute("href", "/privacy");
    expect(nav.getByRole("link", { name: "Uygulamalar" })).toHaveAttribute("href", "/apps");
    // /security is the Güvenlik section's own page
    expect(nav.getByRole("link", { name: "Güvenlik" })).toHaveAttribute("aria-current", "page");
    // Phones get the same sections as tabs under the top bar
    const tabs = screen.getByRole("navigation", { name: "Hesap bölümleri" });
    expect(Array.from(tabs.querySelectorAll("a"), (link) => link.textContent)).toEqual(
      Array.from(navigation.querySelectorAll("a"), (link) => link.textContent),
    );
    expect(screen.getByRole("banner")).toHaveTextContent("SKY LAB");
    expect(screen.getByRole("banner")).toHaveTextContent("Hesap");
    expect(screen.getByRole("link", { name: "İçeriğe geç" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByText("İçerik")).toBeInTheDocument();
    const signOut = document.querySelector('form[action="/api/auth/logout"]');
    expect(signOut).toHaveAttribute("method", "post");
    expect(signOut?.querySelector('input[name="csrfToken"]')).toHaveValue("csrf-value");
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/session/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": "csrf-value" },
      }),
    );
  });

  it("puts the account at the top right, and marks a sub-page's section", () => {
    render(
      <AccountShell logoutCsrfToken="csrf-value" account={<button type="button">Hesap: Ada</button>}>
        <p>İçerik</p>
      </AccountShell>,
    );
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Hesap: Ada" })).toBeInTheDocument();
  });

  it("leaves the top bar to SkyApp when embedded in its WebView, and keeps the section tabs", () => {
    const { container } = render(
      <AccountShell logoutCsrfToken="csrf-value" embedded account={<button type="button">Hesap: Ada</button>}>
        <p>İçerik</p>
      </AccountShell>,
    );

    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hesap: Ada" })).toBeNull();
    expect(container.querySelector(".shell")).toHaveAttribute("data-embedded", "skyapp");
    const shell = within(container);
    expect(shell.getByRole("navigation", { name: "Hesap bölümleri" })).toBeInTheDocument();
    expect(container.querySelector('form[action="/api/auth/logout"]')).not.toBeNull();
    expect(shell.getByText("İçerik")).toBeInTheDocument();
  });

  it("marks the sandbox at the top and beside the account; production draws nothing", () => {
    const { unmount } = render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    expect(screen.queryByText("Sandbox")).toBeNull();
    unmount();
    render(<AccountShell logoutCsrfToken="csrf-value" sandbox><p>İçerik</p></AccountShell>);
    expect(within(screen.getByRole("banner")).getByText("Sandbox")).toBeInTheDocument();
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

describe("AccountShell inbox badge", () => {
  beforeEach(() => cleanup());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function stub(unseen: unknown) {
    const fetch = vi.fn().mockImplementation(async (url: string) =>
      url === "/api/account/inbox/counts"
        ? new Response(JSON.stringify({ counts: { unseen, unread: 3 } }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  function sideNav() {
    return within(screen.getByRole("navigation", { name: "Hesap ayarları" }));
  }

  it("lists Bildirimler only when SkyMail is configured", () => {
    stub(0);
    const { unmount } = render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    expect(sideNav().queryByRole("link", { name: /Bildirimler/ })).toBeNull();
    unmount();
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    const names = Array.from(screen.getByRole("navigation", { name: "Hesap ayarları" }).querySelectorAll("a"), (link) => link.textContent);
    expect(names.indexOf("Bildirimler")).toBe(names.indexOf("Veri ve gizlilik") + 1);
  });

  it("shows the unseen count beside Bildirimler and clears it when the inbox is seen", async () => {
    const fetch = stub(4);
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    const link = sideNav().getByRole("link", { name: /Bildirimler/ });
    expect(link).toHaveAttribute("href", "/notifications");
    expect(await within(link).findByText("4")).toBeInTheDocument();
    // The refresh first, the counts after it: never both at once. (A later refresh in this test comes from
    // the mocked useRouter returning a new object per render, which re-runs the shell's refresh effect.)
    const urls = fetch.mock.calls.map(([url]) => url as string);
    expect(urls.indexOf("/api/auth/session/refresh")).toBeGreaterThan(-1);
    expect(urls.indexOf("/api/auth/session/refresh")).toBeLessThan(urls.indexOf("/api/account/inbox/counts"));
    expect(within(link).getByText("yeni bildirim", { exact: false })).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("account-center:inbox-seen"));
    });
    expect(within(link).queryByText("4")).toBeNull();
  });

  it("reads no counts without SkyMail, and shows nothing for zero or a body it does not know", async () => {
    const fetch = stub(0);
    const { unmount } = render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    expect(fetch.mock.calls.some(([url]) => url === "/api/account/inbox/counts")).toBe(false);
    expect(sideNav().queryByRole("link", { name: /Bildirimler/ })).toBeNull();
    unmount();

    stub("many");
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    await act(async () => {});
    expect(sideNav().getByRole("link", { name: "Bildirimler" }).querySelector(".shell-nav__badge")).toBeNull();
  });
});
