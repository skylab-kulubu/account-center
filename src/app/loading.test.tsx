import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Loading from "@/app/loading";

describe("route loading page", () => {
  it("announces the wait and shows skylcn's loader", () => {
    const { container } = render(<Loading />);

    expect(screen.getByRole("status")).toHaveTextContent("Hesap Merkezi yükleniyor");
    expect(container.querySelector('[data-slot="skylab-loader"]')).toHaveAttribute("aria-hidden", "true");
  });

  it("server-renders without inline styles, which the page's CSP refuses", () => {
    expect(renderToString(<Loading />)).not.toMatch(/\sstyle="/);
  });
});
