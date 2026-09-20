"use client";

import { AlertCircle, RotateCcw } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="full-state">
      <section className="state-card" role="alert">
        <span className="state-card__icon" aria-hidden="true">
          <AlertCircle size={26} />
        </span>
        <h1>Bu alan şu anda yüklenemedi</h1>
        <p>Bağlantını kontrol edip yeniden deneyebilirsin.</p>
        <button className="primary-button" type="button" onClick={reset}>
          <RotateCcw aria-hidden="true" size={16} />
          Yeniden dene
        </button>
      </section>
    </div>
  );
}
