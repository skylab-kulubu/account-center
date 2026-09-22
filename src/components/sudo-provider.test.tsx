import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSudoRequired,
  SUDO_REQUEST_EVENT,
  SUDO_RESULT_EVENT,
  SudoProvider,
  useSudo,
} from "@/components/sudo-provider";

const navigation = vi.hoisted(() => ({
  pathname: "/security",
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace }),
}));

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function methods(overrides: Record<string, unknown> = {}) {
  return json({ methods: ["password"], fallback: null, active: null, csrfToken: "session-bound-csrf", ...overrides });
}

function Consumer({ onResult }: { onResult: (verified: boolean) => void }) {
  const { ensureSudo, invalidateSudo, sudoExpiresAt } = useSudo();
  return (
    <>
      <button type="button" onClick={() => void ensureSudo().then(onResult)}>Hassas işlem</button>
      <button type="button" onClick={() => void ensureSudo({ challenged: true }).then(onResult)}>428 sonrası</button>
      <button type="button" onClick={invalidateSudo}>Unut</button>
      <span data-testid="deadline">{sudoExpiresAt ? sudoExpiresAt.toISOString() : "none"}</span>
    </>
  );
}

beforeEach(() => {
  navigation.pathname = "/security";
  navigation.search = "";
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SudoProvider", () => {
  it("opens the dialog on demand, resolves every waiter once and remembers the deadline", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods())
      .mockResolvedValueOnce(json({ method: "password", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() }));
    const results: boolean[] = [];
    render(<SudoProvider><Consumer onResult={(verified) => results.push(verified)} /></SudoProvider>);

    const trigger = screen.getByRole("button", { name: "Hassas işlem" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Kimliğini doğrula" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const input = await screen.findByLabelText("Parola", { selector: "input" });
    fireEvent.change(input, { target: { value: "hunter2-correct-horse" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(results).toEqual([true, true]));
    expect(dialog).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByTestId("deadline").textContent).not.toBe("none");

    fireEvent.click(trigger);
    await waitFor(() => expect(results).toEqual([true, true, true]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resolves false when the person dismisses the dialog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(methods());
    const onResult = vi.fn();
    render(<SudoProvider><Consumer onResult={onResult} /></SudoProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Hassas işlem" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pencereyi kapat" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("serves callers outside the React tree through the window events", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(methods({ methods: ["totp"] }))
      .mockResolvedValueOnce(json({ method: "totp", expiresAt: "2026-09-21T13:15:18.000Z" }));
    render(<SudoProvider><p>İçerik</p></SudoProvider>);
    const results: unknown[] = [];
    window.addEventListener(SUDO_RESULT_EVENT, (event) => results.push((event as CustomEvent).detail));

    act(() => {
      window.dispatchEvent(new CustomEvent(SUDO_REQUEST_EVENT));
    });
    const input = await screen.findByLabelText("Doğrulama kodu", { selector: "input" });
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(results).toEqual([{ verified: true, expiresAt: "2026-09-21T13:15:18.000Z" }]));
  });

  it("announces the Microsoft re-authentication outcome, cleans the URL and trusts only the server's proof", async () => {
    navigation.search = "sudo=confirmed&tab=passkeys";
    const replaceState = vi.spyOn(window.history, "replaceState");
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(methods({
      active: { method: "reauth", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() },
    }));
    const onResult = vi.fn();
    render(<SudoProvider><Consumer onResult={onResult} /></SudoProvider>);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Kimliğin doğrulandı");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/security?tab=passkeys");
    // The URL alone proves nothing: no local deadline until the server reports the proof.
    expect(screen.getByTestId("deadline").textContent).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Hassas işlem" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(request).toHaveBeenCalledWith("/api/account/sudo/methods", expect.anything());
    expect(screen.getByTestId("deadline").textContent).not.toBe("none");

    cleanup();
    navigation.search = "sudo=cancelled";
    render(<SudoProvider><p>İçerik</p></SudoProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("Yeniden doğrulama tamamlanmadı");
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/security");

    cleanup();
    navigation.search = "sudo=unavailable";
    render(<SudoProvider><p>İçerik</p></SudoProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("Yeniden doğrulama kaydedilemedi");

    cleanup();
    navigation.search = "sudo=method_available";
    render(<SudoProvider><p>İçerik</p></SudoProvider>);
    expect(await screen.findByRole("status")).toHaveTextContent("Microsoft ile doğrulama gerekmiyor");

    cleanup();
    navigation.search = "sudo=<script>";
    render(<SudoProvider><p>İçerik</p></SudoProvider>);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("drops the remembered deadline after a 428 challenge or an explicit invalidation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/methods")) return methods();
      return json({ method: "password", expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() });
    });
    const results: boolean[] = [];
    render(<SudoProvider><Consumer onResult={(verified) => results.push(verified)} /></SudoProvider>);

    const prove = async () => {
      const input = await screen.findByLabelText("Parola", { selector: "input" });
      fireEvent.change(input, { target: { value: "hunter2-correct-horse" } });
      fireEvent.submit(input.closest("form")!);
    };
    fireEvent.click(screen.getByRole("button", { name: "Hassas işlem" }));
    await prove();
    await waitFor(() => expect(results).toEqual([true]));
    fireEvent.click(screen.getByRole("button", { name: "Hassas işlem" }));
    await waitFor(() => expect(results).toEqual([true, true]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // The server said 428: the cached deadline is stale, so the dialog opens again.
    fireEvent.click(screen.getByRole("button", { name: "428 sonrası" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("deadline").textContent).toBe("none");
    await prove();
    await waitFor(() => expect(results).toEqual([true, true, true]));
    expect(screen.getByTestId("deadline").textContent).not.toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "Unut" }));
    expect(screen.getByTestId("deadline").textContent).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Hassas işlem" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/methods"))).toHaveLength(3);
  });

  it("recognises the 428 challenge and refuses use outside the provider", () => {
    expect(isSudoRequired(new Response(null, { status: 428 }))).toBe(true);
    expect(isSudoRequired(new Response(null, { status: 401 }))).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Consumer onResult={vi.fn()} />)).toThrow(/SudoProvider/);
    error.mockRestore();
  });
});
