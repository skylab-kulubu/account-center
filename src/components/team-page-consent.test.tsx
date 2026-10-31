import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamPageConsentSection } from "@/components/team-page-consent";
import { TEAM_PAGE_TEXT } from "@/lib/team-page-consent";

const SWITCH = "Ekip sayfalarında görün";

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

function renderSection(initial: "shown" | "hidden" | null = "shown") {
  return render(<TeamPageConsentSection csrfToken="csrf-proof" initial={initial} returnTo="/club-profile" />);
}

describe("Ekip sayfaları switch", () => {
  it("is on, labelled and described with core's text and links only the aydınlatma metni", () => {
    renderSection();
    const box = screen.getByRole("switch", { name: "Ekip sayfalarında görün" });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(
      "Adın, soyadın, profil fotoğrafın, LinkedIn adresin, üniversiten, fakülten, bölümün ve ekip liderliğin ekibinin SKY LAB uygulamasındaki sayfasında yer alır.",
    );
    expect(screen.getByRole("heading", { name: "Ekip sayfaları" })).toBeInTheDocument();
    const notice = screen.getByRole("link", { name: "KVKK aydınlatma metni" });
    expect(notice).toHaveAttribute("href", "https://yildizskylab.com/kvkk-metni.pdf");
    expect(notice).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "Açık Rıza Metni" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is core's ekip-sayfasi-itiraz-v1 text word for word", () => {
    expect(TEAM_PAGE_TEXT).toBe(
      "Ekip sayfalarında görün. Adın, soyadın, profil fotoğrafın, LinkedIn adresin, üniversiten, fakülten, bölümün ve ekip liderliğin ekibinin SKY LAB uygulamasındaki sayfasında yer alır.",
    );
  });

  it("turning it off objects, turning it on again ends the objection, with no body", async () => {
    fetch.mockResolvedValueOnce(respond({ teamPage: "hidden" })).mockResolvedValueOnce(respond({ teamPage: "shown" }));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).not.toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Ekip sayfalarında görünmüyorsun.");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/team-page-consent");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-proof" });
    expect(init.body).toBeUndefined();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked());
    expect(screen.getByRole("status")).toHaveTextContent("Ekip sayfalarında görünüyorsun.");
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].method).toBe("POST");
  });

  it("keeps the switch as it was and shows the problem when the write fails", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "Ekip sayfası ayarına şu anda ulaşılamıyor", detail: "Biraz sonra yeniden dene.", status: 503 }, 503));
    renderSection("shown");

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await screen.findByText("Ekip sayfası ayarına şu anda ulaşılamıyor");
    expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked();
  });

  it("refuses an answer that does not match the change", async () => {
    fetch.mockResolvedValueOnce(respond({ teamPage: "shown" }));
    renderSection();

    fireEvent.click(screen.getByRole("switch", { name: SWITCH }));
    await screen.findByText("Ekip sayfası ayarı güvenle durduruldu");
    expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked();
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
