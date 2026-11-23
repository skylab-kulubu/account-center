import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/account-menu";
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

  it("exposes the account navigation and marks the current page", () => {
    render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);

    const navigation = screen.getByRole("navigation", { name: "Hesap ayarları" });
    expect(navigation).toBeInTheDocument();
    expect(Array.from(navigation.querySelectorAll("a"), (link) => link.textContent)).toEqual([
      "Özet",
      "Kimlik",
      "E-posta ve giriş",
      "Kulüp profili",
      "İletişim tercihleri",
      "Uygulama ayarları",
      "Giriş ve güvenlik",
      "Oturumlar ve cihazlar",
      "Yetkilerim",
      "Hesabı sil",
    ]);
    expect(screen.getByRole("link", { name: "Kimlik" })).toHaveAttribute("href", "/identity");
    expect(screen.getByRole("link", { name: "E-posta ve giriş" })).toHaveAttribute("href", "/email");
    expect(screen.getByRole("link", { name: "Yetkilerim" })).toHaveAttribute("href", "/permissions");
    expect(screen.getByRole("link", { name: "Kulüp profili" })).toHaveAttribute("href", "/club-profile");
    expect(screen.getByRole("link", { name: "İletişim tercihleri" })).toHaveAttribute("href", "/communication-preferences");
    expect(screen.getByRole("link", { name: "Giriş ve güvenlik" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "İçeriğe geç" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByText("İçerik")).toBeInTheDocument();
    // The sign-out is in the account menu at the top right, not at the foot of the sidebar
    expect(within(navigation).queryByText("Çıkış yap")).toBeNull();
    expect(screen.queryByRole("button", { name: "Çıkış yap" })).toBeNull();
    const signOut = document.getElementById("account-sign-out");
    expect(signOut).toHaveAttribute("action", "/api/auth/logout");
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

  it("leaves the top bar to SkyApp when embedded in its WebView", () => {
    const { container } = render(
      <AccountShell logoutCsrfToken="csrf-value" embedded account={<AccountMenu identity={null} />}>
        <p>İçerik</p>
      </AccountShell>,
    );

    expect(container.querySelector(".account-topbar")).toBeNull();
    expect(container.querySelector(".account-root")).toHaveAttribute("data-embedded", "skyapp");
    const shell = within(container);
    expect(shell.getByRole("navigation", { name: "Hesap ayarları" })).toBeInTheDocument();
    expect(shell.queryByRole("button", { name: /^Hesap/ })).toBeNull();
    expect(shell.getByText("İçerik")).toBeInTheDocument();
  });

  it("puts the account menu at the top right: the person, then Çıkış yap", () => {
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    const { container } = render(
      <AccountShell
        logoutCsrfToken="csrf-value"
        account={<AccountMenu identity={{ name: "Deniz Aydın", email: "deniz@example.com", pictureUrl: null }} />}
      >
        <p>İçerik</p>
      </AccountShell>,
    );

    const bar = container.querySelector(".account-topbar") as HTMLElement;
    const trigger = within(bar).getByRole("button", { name: "Hesap: Deniz Aydın" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Deniz Aydın");
    expect(menu).toHaveTextContent("deniz@example.com");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Çıkış yap"]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Çıkış yap" }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(requestSubmit.mock.contexts[0]).toBe(document.getElementById("account-sign-out"));
    requestSubmit.mockRestore();
  });

  it("still signs out while the person's profile is unknown", () => {
    render(<AccountShell logoutCsrfToken="csrf-value" account={<AccountMenu identity={null} />}><p>İçerik</p></AccountShell>);
    fireEvent.click(screen.getByRole("button", { name: "Hesap" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Çıkış yap"]);
  });

  it("marks the sandbox with a badge beside the account, and nothing in production", () => {
    const { unmount } = render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    expect(screen.queryByRole("note", { name: "Ortam: Sandbox" })).toBeNull();
    unmount();

    const { container } = render(<AccountShell logoutCsrfToken="csrf-value" sandbox><p>İçerik</p></AccountShell>);
    const notes = screen.getAllByRole("note", { name: "Ortam: Sandbox" });
    expect(notes).toHaveLength(1);
    expect(container.querySelector(".account-topbar")).toContainElement(notes[0]!);
  });

  it("hangs a Sandbox tab on the strip inside SkyApp, where there is no top bar", () => {
    const { container } = render(<AccountShell logoutCsrfToken="csrf-value" sandbox embedded><p>İçerik</p></AccountShell>);
    const note = screen.getByRole("note", { name: "Ortam: Sandbox" });
    expect(note).toHaveTextContent("Sandbox");
    expect(container.querySelector(".account-topbar")).toBeNull();
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

  it("lists Bildirimlerim only when SkyMail is configured", () => {
    stub(0);
    const { unmount } = render(<AccountShell logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    expect(screen.queryByRole("link", { name: /Bildirimlerim/ })).toBeNull();
    unmount();
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    const names = Array.from(screen.getByRole("navigation", { name: "Hesap ayarları" }).querySelectorAll("a"), (link) => link.textContent);
    expect(names.indexOf("Bildirimlerim")).toBe(names.indexOf("İletişim tercihleri") + 1);
  });

  it("shows the unseen count beside Bildirimlerim and clears it when the inbox is seen", async () => {
    const fetch = stub(4);
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    const link = screen.getByRole("link", { name: /Bildirimlerim/ });
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
    expect(screen.queryByRole("link", { name: /Bildirimlerim/ })).toBeNull();
    unmount();

    stub("many");
    render(<AccountShell inboxEnabled logoutCsrfToken="csrf-value"><p>İçerik</p></AccountShell>);
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Bildirimlerim" }).querySelector(".account-nav__badge")).toBeNull();
  });
});
