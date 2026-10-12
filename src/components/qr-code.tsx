"use client";

import { useMemo } from "react";
import { encodeQr, qrPath } from "@/lib/qr";

const QUIET_ZONE = 4;

/**
 * Renders `value` as an inline SVG QR symbol. The symbol is drawn in the
 * browser from the module matrix (`src/lib/qr.ts`), so the encoded text never
 * leaves the page; `label` describes the image to assistive technology
 * without repeating the encoded value.
 */
export function QrCode({ value, label, size = 196 }: { value: string; label: string; size?: number }) {
  const code = useMemo(() => encodeQr(value, { errorCorrection: "M" }), [value]);
  const extent = code.size + QUIET_ZONE * 2;
  return (
    <svg
      className="qr-code"
      // skylcn's dark token set: the modules read --primary-foreground from it,
      // so they stay dark on the white paper even under a light page theme.
      data-theme="dark"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      data-qr-version={code.version}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path className="qr-code__modules" d={qrPath(code, QUIET_ZONE)} />
    </svg>
  );
}
