import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommunicationPreferencesEditor } from "@/components/communication-preferences-editor";
import type { CommunicationPreferencesView } from "@/lib/communication-preferences";
import { parseCoreScreen } from "@/server/core/communication-preferences-client";

const ids = {
  weblab: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01",
  back: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d03",
  airlab: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04",
  drone: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d05",
  hidden: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d06",
  robolab: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d07",
};

const view: CommunicationPreferencesView = parseCoreScreen(JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/core-communication-preferences.json"), "utf8"),
));

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status === 200 ? "application/json" : "application/problem+json" },
  });
}

function sentItems(fetch: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetch.mock.calls[call] as [string, RequestInit];
  expect(url).toBe("/api/account/communication-preferences");
  expect(init.method).toBe("PUT");
  expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-proof", "content-type": "application/json" });
  return (JSON.parse(init.body as string) as { items: unknown[] }).items;
}

function renderEditor(focusCategory: string | null = null, initial = view) {
  return render(<CommunicationPreferencesEditor csrfToken="csrf-proof" focusCategory={focusCategory} initial={initial} />);
}

let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetch = vi.fn().mockImplementation(async () => respond({ preferences: view }));
  vi.stubGlobal("fetch", fetch);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunicationPreferencesEditor", () => {
  it("shows the club row, the person's team tree and the followed teams in one labelled table", () => {
    renderEditor();

    const table = screen.getByRole("table", { name: "Duyuru ve haber postası tercihlerin, kaynak kaynak" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Kaynak", "Duyurular", "Haberler", "İşlem"]);
    for (const group of ["Kulüp geneli", "Ekiplerim", "Takip ettiğim ekipler"]) {
      expect(within(table).getByRole("rowheader", { name: group })).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: "Kulüp geneli · Duyurular" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Kulüp geneli · Haberler" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "WEBLAB · Haberler" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Duyuru ve haber postaları" })).toBeChecked();
  });

  it("says “üst ekipten” where the value comes from a team above, and names it for screen readers", () => {
    renderEditor();

    const back = screen.getByRole("switch", { name: "BACK · Duyurular" });
    expect(back).toBeChecked();
    expect(back).toHaveAccessibleDescription("üst ekipten: WEBLAB");
    expect(screen.getByRole("switch", { name: "DRONE · Haberler" })).toHaveAccessibleDescription("üst ekipten: AIRLAB");
    expect(screen.getByRole("switch", { name: "BACK · Haberler" })).not.toHaveAccessibleDescription();
  });

  it("keeps the row actions out of the row header, so it reads as the team alone", () => {
    renderEditor();

    const reset = screen.getByRole("button", { name: "Varsayılana dön: BACK" });
    expect(reset.closest("th")).toBeNull();
    expect(reset.closest("td")).toHaveClass("preferences-row__action");
    expect(screen.getByRole("button", { name: "Takibi bırak: AIRLAB" }).closest("th")).toBeNull();
    const header = screen.getByRole("rowheader", { name: /^BACK/ });
    expect(header).not.toHaveTextContent(/Varsayılana dön/);
    expect(header).not.toHaveAccessibleName(/Varsayılana dön/);
  });

  it("describes the master switch with its state line", () => {
    renderEditor();

    expect(screen.getByRole("switch", { name: "Duyuru ve haber postaları" }))
      .toHaveAccessibleDescription("Açık: aşağıda açık olan kaynaklardan duyuru ve haber postası alırsın.");
  });

  it("writes one switch on its own category and shows core's answer", async () => {
    renderEditor();
    const live = document.querySelector(".preferences-feedback__live");
    // The polite live region is there before anything is said in it.
    expect(live).toHaveAttribute("role", "status");
    expect(live).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("switch", { name: "BACK · Duyurular" }));

    await screen.findByText("BACK · Duyurular kapatıldı.");
    expect(live).toHaveTextContent("BACK · Duyurular kapatıldı.");
    expect(live?.querySelector("[data-slot='notice']")).not.toHaveAttribute("role");
    expect(sentItems(fetch)).toEqual([{ category: `team:${ids.back}:duyuru`, enabled: false }]);
  });

  it("keeps every choice under a closed master switch and says nothing goes", async () => {
    const off = structuredClone(view);
    off.master = { ...off.master, explicit: false, enabled: false, origin: "explicit", effective: false };
    fetch.mockResolvedValueOnce(respond({ preferences: off }));
    renderEditor();

    fireEvent.click(screen.getByRole("switch", { name: "Duyuru ve haber postaları" }));

    await screen.findByText(/Ana anahtar kapalı/);
    expect(sentItems(fetch)).toEqual([{ category: "all", enabled: false }]);
    expect(screen.getByRole("switch", { name: "Duyuru ve haber postaları" })).not.toBeChecked();
    // The rows keep their own values; they are only dimmed.
    expect(screen.getByRole("switch", { name: "WEBLAB · Haberler" })).toBeChecked();
    expect(screen.getByRole("table").closest("[data-dimmed]")).not.toBeNull();
  });

  it("returns a row to its default by forgetting only its own choices", async () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Varsayılana dön: Kulüp geneli" }));

    await screen.findByText("Kulüp geneli varsayılana döndü.");
    expect(sentItems(fetch)).toEqual([{ category: "club:haber", enabled: null }]);
    // WEBLAB has no choice of its own, so it offers no reset.
    expect(screen.queryByRole("button", { name: "Varsayılana dön: WEBLAB" })).toBeNull();
  });

  it("unfollows a team by forgetting its choices, and a hidden team can only be removed", async () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Takibi bırak: AIRLAB" }));
    await screen.findByText("AIRLAB artık takip edilmiyor.");
    expect(sentItems(fetch)).toEqual([
      { category: `team:${ids.airlab}:duyuru`, enabled: null },
      { category: `team:${ids.airlab}:haber`, enabled: null },
    ]);

    expect(screen.getByRole("switch", { name: "Gizli ekip · Duyurular" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Kaldır: Gizli ekip" }));
    await screen.findByText("Gizli ekip için kalan ayar silindi.");
    expect(sentItems(fetch, 1)).toEqual([
      { category: `team:${ids.hidden}:duyuru`, enabled: null },
      { category: `team:${ids.hidden}:haber`, enabled: null },
    ]);
  });

  it("follows a listed team with both kinds on", async () => {
    renderEditor();

    const input = screen.getByRole("combobox", { name: "Takip edilecek ekip" });
    expect(screen.getByRole("button", { name: "Takip et" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Listeyi aç" }));
    fireEvent.click(await screen.findByRole("option", { name: /ROBOLAB/ }));
    expect(input).toHaveValue("ROBOLAB · Robotik Laboratuvarı");
    fireEvent.click(screen.getByRole("button", { name: "Takip et" }));

    await screen.findByText(/ROBOLAB takip ediliyor/);
    expect(sentItems(fetch)).toEqual([
      { category: `team:${ids.robolab}:duyuru`, enabled: true },
      { category: `team:${ids.robolab}:haber`, enabled: true },
    ]);
  });

  it("highlights the row a mail's link names", () => {
    renderEditor(`team:${ids.airlab}:duyuru`);

    expect(screen.getByText(/“AIRLAB · Duyurular” satırı aşağıda vurgulandı/)).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /AIRLAB/ }).closest("tr")).toHaveAttribute("data-focused");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("shows core's refusal and keeps the switch as it was", async () => {
    fetch.mockResolvedValueOnce(respond({
      title: "Ekip bilgisi şu anda alınamıyor",
      detail: "Ekiplerin okunamadı; tercihlerin değişmedi. Biraz sonra yeniden dene.",
      status: 503,
    }, 503));
    renderEditor();

    fireEvent.click(screen.getByRole("switch", { name: "WEBLAB · Duyurular" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ekip bilgisi şu anda alınamıyor");
    expect(screen.getByRole("switch", { name: "WEBLAB · Duyurular" })).toBeChecked();
    await waitFor(() => expect(document.activeElement).toHaveClass("preferences-feedback"));
  });

  it("offers a fresh login when core no longer accepts the session, back to the mail's row", async () => {
    fetch.mockResolvedValueOnce(respond({ title: "Yeniden giriş", detail: "x", status: 401 }, 401));
    renderEditor("club:haber");

    fireEvent.click(screen.getByRole("switch", { name: "WEBLAB · Duyurular" }));

    expect(await screen.findByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute(
      "href",
      `/login?returnTo=${encodeURIComponent("/communication-preferences?kanal=email&kategori=club%3Ahaber")}`,
    );
  });

  it("fails closed on an answer that is not a screen", async () => {
    fetch.mockResolvedValueOnce(respond({ preferences: { master: true } }));
    renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "WEBLAB · Duyurular" }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("İletişim tercihleri güvenle durduruldu");
  });

  it("renders no inline style on the server, where the CSP would refuse it", () => {
    const html = renderToString(
      <CommunicationPreferencesEditor csrfToken="csrf-proof" focusCategory={null} initial={view} />,
    );
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain("Tercihlerin hazırlanıyor");
  });
});
