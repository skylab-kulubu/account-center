import { SkyLabMark } from "@/components/skylab-mark";

type LogoLoaderProps = {
  label?: string;
  size?: number;
};

export function LogoLoader({ label = "Yükleniyor", size = 72 }: LogoLoaderProps) {
  return (
    <div className="logo-loader" role="status" aria-live="polite">
      <span className="logo-loader__glow" aria-hidden="true" />
      <SkyLabMark className="logo-loader__mark" size={size} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
