import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamPageConsentSection } from "@/components/team-page-consent";

const SWITCH = /Ekip sayfalarında görüneyim/;

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

function renderSection(initial: "active" | "none" | null = "none") {
  return render(<TeamPageConsentSection csrfToken="csrf-proof" initial={initial} returnTo="/club-profile" />);
}

describe("Ekip sayfaları switch", () => {
  it("is off, labelled with core's text and links the aydınlatma metni", () => {
    renderSection();
    const box = screen.getByRole("switch", {
      name: "Ekip sayfalarında görüneyim: adım, soyadım, profil fotoğrafım, LinkedIn adresim, üniversitem, fakültem, bölümüm ve ekip liderliğim ekibimin sitedeki ve SKY LAB uygulamasındaki sayfasında yayımlansın.",
    });
    expect(box).not.toBeChecked();
    expect(screen.getByRole("heading", { name: "Ekip sayfaları" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "KVKK aydınlatma metni" })).toHaveAttribute("href", "https://yildizskylab.com/kvkk-metni.pdf");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turning it on grants, turning it off withdraws, with no body", async () => {
    fetch.mockResolvedValueOnce(respond({ teamPage: "active" })).mockResolvedValueOnce(respond({ teamPage: "none" }));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Ekip sayfası izni açıldı.");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/team-page-consent");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-proof" });
    expect(init.body).toBeUndefined();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).not.toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Ekip sayfası izni kapatıldı.");
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].method).toBe("DELETE");
  });

  it("keeps the switch as it was and shows the problem when the write fails", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "Ekip sayfası ayarına şu anda ulaşılamıyor", detail: "Biraz sonra yeniden dene.", status: 503 }, 503));
    renderSection("active");

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await screen.findByText("Ekip sayfası ayarına şu anda ulaşılamıyor");
    expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked();
  });

  it("refuses an answer that does not match the change", async () => {
    fetch.mockResolvedValueOnce(respond({ teamPage: "none" }));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await screen.findByText("Ekip sayfası ayarı güvenle durduruldu");
    expect(screen.getByRole("switch", { name: SWITCH })).not.toBeChecked();
  });

  it("offers a fresh login on a refused session", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "Yeniden giriş yapman gerekiyor", detail: "x", status: 401 }, 401));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    expect(await screen.findByRole("link", { name: "Yeniden giriş yap" }))
      .toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");
  });

  it("shows a failed read without a switch", () => {
    renderSection(null);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Ekip sayfası ayarı okunamadı. Sayfayı yenileyip yeniden dene.")).toBeInTheDocument();
  });
});
