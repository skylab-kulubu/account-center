import { LogoLoader } from "@/components/logo-loader";

export default function Loading() {
  return (
    <div className="full-state">
      <LogoLoader label="Hesap Merkezi yükleniyor" size={80} />
    </div>
  );
}
