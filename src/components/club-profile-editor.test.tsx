import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubProfileEditor, parseClubProfileView } from "@/components/club-profile-editor";
import { CLUB_PROFILE_PICTURE_MAX_BYTES } from "@/config/club-profile";
import type { ClubProfileView } from "@/server/club-profile/service";

const profile: ClubProfileView = {
  skyNumber: "SKY-0000042",
  studentCardLinked: true,
  schoolEmail: "ada@std.yildiz.edu.tr",
  phone: "+905551112233",
  university: "Yıldız Teknik Üniversitesi",
  faculty: "Elektrik-Elektronik Fakültesi",
  department: "Bilgisayar Mühendisliği",
  linkedin: "https://www.linkedin.com/in/ada-lovelace",
  profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/current.webp",
  updatedAt: "2026-09-21T13:10:41.130Z",
};

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function problem(value: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify({ status, ...value }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function pictureFile(name = "me.png", type = "image/png", bytes: Uint8Array<ArrayBuffer> = pngBytes) {
  return new File([bytes], name, { type });
}

function renderEditor(initial: ClubProfileView = profile) {
  return render(<ClubProfileEditor initial={initial} csrfToken="session-bound-csrf" />);
}

function fileInput() {
  return screen.getByLabelText("Profil fotoğrafı dosyası") as HTMLInputElement;
}

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:preview-url"),
    revokeObjectURL: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseClubProfileView", () => {
  it("accepts the BFF shape and rejects drift or unsafe picture URLs", () => {
    expect(parseClubProfileView(profile)).toEqual(profile);
    expect(parseClubProfileView({ ...profile, profilePictureUrl: null })).toMatchObject({ profilePictureUrl: null });
    expect(parseClubProfileView({ ...profile, profilePictureUrl: "javascript:alert(1)" })).toBeNull();
    expect(parseClubProfileView({ ...profile, profilePictureUrl: "/relative.png" })).toBeNull();
    expect(parseClubProfileView({ ...profile, studentCardLinked: "yes" })).toBeNull();
    expect(parseClubProfileView({ ...profile, faculty: 3 })).toBeNull();
    expect(parseClubProfileView(null)).toBeNull();
  });
});

describe("ClubProfileEditor form", () => {
  it("renders the four editable fields with the current values and no name or phone inputs", () => {
    renderEditor();

    expect(screen.getByLabelText("Üniversite")).toHaveValue("Yıldız Teknik Üniversitesi");
    expect(screen.getByLabelText("Fakülte")).toHaveValue("Elektrik-Elektronik Fakültesi");
    expect(screen.getByLabelText("Bölüm")).toHaveValue("Bilgisayar Mühendisliği");
    expect(screen.getByLabelText("LinkedIn bağlantısı")).toHaveValue("https://www.linkedin.com/in/ada-lovelace");
    expect(document.querySelectorAll("input:not([type=file])")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Kaydet" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Fakülte")).toHaveAttribute("maxlength", "120");
    expect(screen.getByLabelText("LinkedIn bağlantısı")).toHaveAttribute("maxlength", "200");
  });

  it("sends only the changed fields with the session proof and shows the saved state", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      changed: true,
      profile: { ...profile, faculty: "Makine Fakültesi", linkedin: null },
    }));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Fakülte"), { target: { value: " Makine Fakültesi " } });
    fireEvent.change(screen.getByLabelText("LinkedIn bağlantısı"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Kaydet" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Değişiklikleri geri al" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/account/club-profile", expect.objectContaining({
      method: "PATCH",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": "session-bound-csrf" },
      body: JSON.stringify({ faculty: "Makine Fakültesi", linkedin: "" }),
    })));
    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveTextContent("Kulüp bilgilerin kaydedildi.");
    await waitFor(() => expect(feedback).toHaveFocus());
    expect(screen.getByLabelText("Fakülte")).toHaveValue("Makine Fakültesi");
    expect(screen.getByLabelText("LinkedIn bağlantısı")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Kaydet" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Değişiklikleri geri al" })).not.toBeInTheDocument();
  });

  it("syncs to the server profile when core reports nothing changed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      changed: false,
      profile: { ...profile, department: "Matematik Mühendisliği" },
    }));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Bölüm"), { target: { value: "Matematik Mühendisliği" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText(/Bilgilerin zaten güncel/)).toHaveAttribute("role", "status");
    expect(screen.getByLabelText("Bölüm")).toHaveValue("Matematik Mühendisliği");
    expect(screen.getByRole("button", { name: "Kaydet" })).toHaveAttribute("aria-disabled", "true");
  });

  it("validates the LinkedIn URL locally and never posts an invalid form", () => {
    const request = vi.spyOn(globalThis, "fetch");
    renderEditor();

    const linkedin = screen.getByLabelText("LinkedIn bağlantısı");
    fireEvent.change(linkedin, { target: { value: "http://www.linkedin.com/in/ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(screen.getByRole("alert")).toHaveTextContent("https:// ile başlamalı");
    expect(linkedin).toHaveAttribute("aria-invalid", "true");
    expect(linkedin).toHaveFocus();
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(linkedin, { target: { value: "https://www.linkedin.com/in/ada" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(linkedin).not.toHaveAttribute("aria-invalid");
  });

  it("restores the current values when the person reverts", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Bölüm"), { target: { value: "Matematik" } });
    fireEvent.click(screen.getByRole("button", { name: "Değişiklikleri geri al" }));
    expect(screen.getByLabelText("Bölüm")).toHaveValue("Bilgisayar Mühendisliği");
    expect(screen.getByRole("button", { name: "Kaydet" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a server field problem on the rejected field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem({
      type: "https://my.yildizskylab.com/problems/club-profile-invalid",
      title: "Bilgiler doğrulanamadı",
      detail: "Fakülte en fazla 120 karakter olabilir.",
      field: "faculty",
    }, 400));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Fakülte"), { target: { value: "Yeni Fakülte" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fakülte en fazla 120 karakter olabilir.");
    expect(screen.getByLabelText("Fakülte")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Fakülte")).toHaveFocus());
    expect(screen.getByLabelText("Fakülte")).toHaveValue("Yeni Fakülte");
  });

  it("reports a core outage without losing the typed values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem({
      title: "Kulüp profiline şu anda ulaşılamıyor",
      detail: "Core hizmeti yanıt vermedi. Kulüp profilin değişmedi; kısa bir süre sonra yeniden deneyebilirsin.",
    }, 503));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Bölüm"), { target: { value: "Matematik" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Kulüp profiline şu anda ulaşılamıyor");
    expect(alert).toHaveTextContent("Kulüp profilin değişmedi");
    expect(screen.getByLabelText("Bölüm")).toHaveValue("Matematik");
    expect(screen.queryByRole("link", { name: "Yeniden giriş yap" })).not.toBeInTheDocument();
  });

  it("offers a re-login link on 401 instead of redirecting", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem({
      title: "Kulüp profili için yeniden giriş yapman gerekiyor",
      detail: "Oturumunun core erişimi doğrulanamadı.",
    }, 401));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Bölüm"), { target: { value: "Matematik" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Yeniden giriş yap" })).toHaveAttribute("href", "/login?returnTo=%2Fclub-profile");
  });

  it("refuses a payload that drifts from the contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ changed: true, profile: { faculty: 42 } }));
    renderEditor();

    fireEvent.change(screen.getByLabelText("Bölüm"), { target: { value: "Matematik" } });
    fireEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Kulüp profili güvenle durduruldu");
    expect(screen.getByLabelText("Bölüm")).toHaveValue("Matematik");
  });
});

describe("ClubProfileEditor picture", () => {
  it("shows the current picture with replace and remove actions", () => {
    renderEditor();

    expect(screen.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toHaveAttribute("src", profile.profilePictureUrl!);
    expect(screen.getByText("Fotoğraf yüklü")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fotoğrafı değiştir" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fotoğrafı kaldır" })).toBeInTheDocument();
    expect(fileInput()).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
  });

  it("shows the empty state without a remove action", () => {
    renderEditor({ ...profile, profilePictureUrl: null });

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Henüz fotoğraf yok")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fotoğraf seç" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fotoğrafı kaldır" })).not.toBeInTheDocument();
  });

  it("rejects an unsupported type or an oversize file before any preview or request", () => {
    const request = vi.spyOn(globalThis, "fetch");
    renderEditor();

    fireEvent.change(fileInput(), { target: { files: [pictureFile("vector.svg", "image/svg+xml")] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Bu dosya türü desteklenmiyor");
    expect(screen.queryByRole("button", { name: "Fotoğrafı yükle" })).not.toBeInTheDocument();

    const oversize = new File([new Uint8Array(CLUB_PROFILE_PICTURE_MAX_BYTES + 1)], "big.png", { type: "image/png" });
    fireEvent.change(fileInput(), { target: { files: [oversize] } });
    expect(screen.getByRole("alert")).toHaveTextContent("5 MB sınırını aşıyor");
    expect(screen.queryByRole("button", { name: "Fotoğrafı yükle" })).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("previews a valid selection and uploads it as multipart under the pinned field", async () => {
    const uploaded = { ...profile, profilePictureUrl: "https://cdn.yildizskylab.com/media/profile/new.png" };
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ profile: uploaded }));
    renderEditor();

    fireEvent.change(fileInput(), { target: { files: [pictureFile()] } });

    expect(screen.getByRole("img", { name: "Seçtiğin fotoğrafın önizlemesi" })).toHaveAttribute("src", "blob:preview-url");
    expect(screen.getByText("Önizleme, henüz yüklenmedi")).toBeInTheDocument();
    expect(screen.getByText(/me\.png/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fotoğrafı kaldır" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fotoğrafı yükle" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/api/account/club-profile/picture");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "x-csrf-token": "session-bound-csrf" } });
    const form = init!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(["file"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("me.png");
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pngBytes);

    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveTextContent("Profil fotoğrafın güncellendi.");
    expect(screen.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toHaveAttribute("src", uploaded.profilePictureUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-url");
    expect(screen.getByRole("button", { name: "Fotoğrafı değiştir" })).toBeInTheDocument();
  });

  it("lets the person discard a selection before uploading", () => {
    renderEditor();
    fireEvent.change(fileInput(), { target: { files: [pictureFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Vazgeç" }));

    expect(screen.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toHaveAttribute("src", profile.profilePictureUrl!);
    expect(screen.queryByRole("button", { name: "Fotoğrafı yükle" })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-url");
  });

  it("surfaces a server-side rejection of the upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem({
      title: "Dosya türü desteklenmiyor",
      detail: "Yalnızca PNG, JPEG ve WebP kabul edilir; seçtiğin dosyanın içeriği bunlardan biri değil.",
    }, 415));
    renderEditor();

    fireEvent.change(fileInput(), { target: { files: [pictureFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Fotoğrafı yükle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Dosya türü desteklenmiyor");
    expect(screen.getByRole("button", { name: "Fotoğrafı yükle" })).toBeInTheDocument();
  });

  it("asks for confirmation before removing and restores focus on cancel", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    renderEditor();

    const trigger = screen.getByRole("button", { name: "Fotoğrafı kaldır" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Profil fotoğrafını kaldır" });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByRole("button", { name: "Pencereyi kapat" })).toHaveFocus();
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(request).not.toHaveBeenCalled();
  });

  it("removes the picture after confirmation and shows the empty state", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ profile: { ...profile, profilePictureUrl: null } }));
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Fotoğrafı kaldır" }));
    const dialog = screen.getByRole("dialog", { name: "Profil fotoğrafını kaldır" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fotoğrafı kaldır" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/account/club-profile/picture", expect.objectContaining({
      method: "DELETE",
      headers: { "x-csrf-token": "session-bound-csrf" },
    })));
    const feedback = await screen.findByRole("status");
    expect(feedback).toHaveTextContent("Profil fotoğrafın kaldırıldı.");
    await waitFor(() => expect(feedback).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Henüz fotoğraf yok")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fotoğrafı kaldır" })).not.toBeInTheDocument();
  });

  it("keeps the picture and reports the problem when the removal fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problem({
      title: "Kulüp profiline şu anda ulaşılamıyor",
      detail: "Core hizmeti yanıt vermedi.",
    }, 503));
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Fotoğrafı kaldır" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Fotoğrafı kaldır" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Kulüp profiline şu anda ulaşılamıyor");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("img", { name: "Mevcut profil fotoğrafın" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Fotoğrafı kaldır" })).toHaveFocus());
  });
});
