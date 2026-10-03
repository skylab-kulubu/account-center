import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HomePrimaryEmailNudge,
  parsePrimaryEmailNudge,
  PrimaryEmailNudgeCard,
  primaryEmailNudgeCopy,
} from "@/components/primary-email-nudge";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/",
}));

const csrfToken = "session-bound-csrf";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function nudgePayload(overrides: Record<string, unknown> = {}) {
  return {
    primaryEmailNudge: "make-personal-primary",
    personalEmail: "ada@example.com",
    csrfToken,
    ...overrides,
  };
}

beforeEach(() => {
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("parsePrimaryEmailNudge", () => {
  it("reads a known nudge and treats a missing or unknown one as none", () => {
    expect(parsePrimaryEmailNudge("add-personal")).toBe("add-personal");
    expect(parsePrimaryEmailNudge("make-personal-primary")).toBe("make-personal-primary");
    for (const value of [undefined, null, "", "remove-personal", 3]) expect(parsePrimaryEmailNudge(value)).toBeNull();
  });
});

describe("PrimaryEmailNudgeCard", () => {
  it("explains the graduation risk and names the proven personal address as a region with its own heading", () => {
    render(
      <PrimaryEmailNudgeCard
        nudge="make-personal-primary"
        personalEmail="ada@example.com"
        csrfToken={csrfToken}
        onAuthenticationRequired={vi.fn()}
      />,
    );
    const region = screen.getByRole("region", { name: primaryEmailNudgeCopy.title });
    expect(within(region).getByRole("heading", { level: 2, name: "Mezun olunca okul postan kapanabilir" })).toBeInTheDocument();
    expect(region).toHaveTextContent("ada@example.com");
    expect(region).toHaveTextContent(/sıfırlama bağlantısı birincil adresine/);
    expect(within(region).getByRole("link", { name: "Kişisel adresi birincil yap" }))
      .toHaveAttribute("href", "/email?intent=make-personal-primary");
    expect(within(region).getByRole("button", { name: "Bir daha gösterme" })).toBeEnabled();
  });

  it("asks a person without a personal address to add one, in the page when the page handles it", () => {
    const onAct = vi.fn();
    render(
      <PrimaryEmailNudgeCard
        nudge="add-personal"
        personalEmail={null}
        csrfToken={csrfToken}
        onAct={onAct}
        onAuthenticationRequired={vi.fn()}
      />,
    );
    const region = screen.getByRole("region", { name: primaryEmailNudgeCopy.title });
    expect(within(region).queryByRole("link")).not.toBeInTheDocument();
    const action = within(region).getByRole("button", { name: "Kişisel adres ekle" });
    fireEvent.click(action);
    expect(onAct).toHaveBeenCalledWith("add-personal", action);
  });

  it("disables both actions while another flow runs on the page", () => {
    render(
      <PrimaryEmailNudgeCard
        nudge="add-personal"
        personalEmail={null}
        csrfToken={csrfToken}
        onAct={vi.fn()}
        disabled
        onAuthenticationRequired={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Kişisel adres ekle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bir daha gösterme" })).toBeDisabled();
  });

  it("stores the dismissal with the session CSRF proof, then says so and takes the focus", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    render(
      <PrimaryEmailNudgeCard
        nudge="make-personal-primary"
        personalEmail="ada@example.com"
        csrfToken={csrfToken}
        onAuthenticationRequired={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bir daha gösterme" }));

    const status = await screen.findByText(primaryEmailNudgeCopy.dismissed);
    expect(status).toHaveAttribute("role", "status");
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.queryByRole("region", { name: primaryEmailNudgeCopy.title })).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("/api/account/email/nudge/dismiss");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe(csrfToken);
    expect(JSON.parse(String(init?.body))).toEqual({ nudge: "make-personal-primary" });
  });

  it("keeps the nudge and explains a failed dismissal; an ended session goes to the login", async () => {
    const onAuthenticationRequired = vi.fn();
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "unexpected", detail: "Beklenmeyen bir sorun oluştu. Değişiklik yapılmadı." }, 500))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(json({ error: "authentication_required" }, 401));
    render(
      <PrimaryEmailNudgeCard
        nudge="add-personal"
        personalEmail={null}
        csrfToken={csrfToken}
        onAuthenticationRequired={onAuthenticationRequired}
      />,
    );
    const dismiss = screen.getByRole("button", { name: "Bir daha gösterme" });

    fireEvent.click(dismiss);
    expect(await screen.findByRole("alert")).toHaveTextContent(primaryEmailNudgeCopy.dismissFailed);
    expect(screen.getByRole("region", { name: primaryEmailNudgeCopy.title })).toBeInTheDocument();

    fireEvent.click(dismiss);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(primaryEmailNudgeCopy.dismissFailed);

    fireEvent.click(dismiss);
    await waitFor(() => expect(onAuthenticationRequired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("HomePrimaryEmailNudge", () => {
  it("reads the nudge answer and shows it with a link into the e-mail page", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(nudgePayload()));
    render(<HomePrimaryEmailNudge />);

    const region = await screen.findByRole("region", { name: primaryEmailNudgeCopy.title });
    expect(within(region).getByRole("link", { name: "Kişisel adresi birincil yap" }))
      .toHaveAttribute("href", "/email?intent=make-personal-primary");
    expect(region).toHaveTextContent("ada@example.com");
    expect(spy).toHaveBeenCalledWith("/api/account/email/nudge", { cache: "no-store", credentials: "same-origin" });
  });

  it.each([
    ["no nudge", () => json({ primaryEmailNudge: null })],
    ["an unknown nudge", () => json(nudgePayload({ primaryEmailNudge: "something-new" }))],
    ["an outage", () => json({ error: "unavailable" }, 503)],
    ["an ended session", () => json({ error: "authentication_required" }, 401)],
    ["an answer without the CSRF proof", () => json({ primaryEmailNudge: "add-personal", personalEmail: null })],
    ["a primary nudge without its address", () => json(nudgePayload({ personalEmail: null }))],
    ["an add nudge naming an address", () => json(nudgePayload({ primaryEmailNudge: "add-personal" }))],
  ])("shows nothing for %s", async (_label, answer) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
    const { container } = render(<HomePrimaryEmailNudge />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("shows nothing when the read fails outright", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const { container } = render(<HomePrimaryEmailNudge />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
