import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="full-state">
      <section className="state-card">
        <p className="eyebrow">404</p>
        <h1>Bu sayfa bulunamadı</h1>
        <p>Aradığın hesap ayarı taşınmış veya artık kullanılamıyor olabilir.</p>
        <Link className="primary-button" href="/">
          <ArrowLeft aria-hidden="true" size={16} />
          Hesap Merkezi’ne dön
        </Link>
      </section>
    </div>
  );
}
