import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CircleOff } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionProgress,
  EmptyState,
  PageSkeleton,
  RetryableError,
} from "@/components/ui-states";

afterEach(cleanup);

describe("shared UI states", () => {
  it("exposes a non-interactive page skeleton to assistive technology", () => {
    const { container } = render(<PageSkeleton label="Hesap bilgileri yükleniyor" rows={2} />);

    expect(screen.getByRole("status")).toHaveTextContent("Hesap bilgileri yükleniyor");
    expect(container.querySelectorAll("[data-skeleton-row]")).toHaveLength(2);
  });

  it("renders an empty state with a named heading", () => {
    render(
      <EmptyState
        icon={CircleOff}
        title="Kayıt bulunamadı"
        detail="Bu alanda henüz bir kayıt yok."
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Kayıt bulunamadı" })).toBeInTheDocument();
  });

  it("offers a retry action and announces asynchronous progress", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <RetryableError
        title="Bilgiler alınamadı"
        detail="Bağlantını kontrol edip yeniden dene."
        onRetry={retry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(<ActionProgress label="Oturum kapatılıyor" />);
    expect(screen.getByRole("status")).toHaveTextContent("Oturum kapatılıyor");
  });
});
