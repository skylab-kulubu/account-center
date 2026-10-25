import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromotionalConsentSection } from "@/components/promotional-consent";

const BOX = /tanıtım içerikli e-postalar/;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status === 200 ? "application/json" : "application/problem+json" },
  });
}

let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(initial: "active" | "pending" | "none" | null = "none") {
  return render(<PromotionalConsentSection csrfToken="csrf-proof" initial={initial} returnTo="/communication-preferences" />);
}

describe("Tanıtım içerikleri box", () => {
  it("is unticked, labelled with core's text and links the Açık Rıza Metni", () => {
    renderSection();
    const box = screen.getByRole("switch", { name: "SKY LAB'dan tanıtım içerikli e-postalar (indirim kodu, şirket iş ilanı, çekiliş gibi) almak istiyorum." });
    expect(box).not.toBeChecked();
    expect(screen.getByRole("link", { name: "Açık Rıza Metni" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "KVKK aydınlatma metni" })).toHaveAttribute("href", "https://yildizskylab.com/kvkk-metni.pdf");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ticking grants with source self, unticking withdraws", async () => {
    fetch.mockResolvedValueOnce(respond({ promotional: "active" })).mockResolvedValueOnce(respond({ promotional: "none" }));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: BOX }));
    await waitFor(() => expect(screen.getByRole("switch", { name: BOX })).toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Tanıtım içerikleri açıldı.");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/promotional-consent");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-proof" });
    expect(JSON.parse(init.body as string)).toEqual({ source: "self" });

    fireEvent.click(screen.getByRole("switch", { name: BOX }));
    await waitFor(() => expect(screen.getByRole("switch", { name: BOX })).not.toBeChecked());
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].method).toBe("DELETE");
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].body).toBeUndefined();
  });

  it("keeps the box as it was and shows the problem when the write fails", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "E-posta adreslerin şu an okunamadı", detail: "Biraz sonra yeniden dene.", status: 503 }, 503));
    renderSection("active");

    fireEvent.click(screen.getByRole("switch", { name: BOX }));
    await screen.findByText("E-posta adreslerin şu an okunamadı");
    expect(screen.getByRole("switch", { name: BOX })).toBeChecked();
  });

  it("offers a fresh login on a refused session", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "Yeniden giriş yapman gerekiyor", detail: "x", status: 401 }, 401));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: BOX }));
    expect(await screen.findByRole("link", { name: "Yeniden giriş yap" }))
      .toHaveAttribute("href", "/login?returnTo=%2Fcommunication-preferences");
  });

  it("shows a pending grant unticked and a failed read without a switch", () => {
    renderSection("pending");
    expect(screen.getByRole("switch", { name: BOX })).not.toBeChecked();
    cleanup();

    renderSection(null);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Tanıtım izni okunamadı. Sayfayı yenileyip yeniden dene.")).toBeInTheDocument();
  });
});
