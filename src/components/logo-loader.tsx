import { SkyLabMark } from "@/components/skylab-mark";

type LogoLoaderProps = {
  announce?: boolean;
  label?: string;
  size?: number;
};

export function LogoLoader({ announce = true, label = "Yükleniyor", size = 72 }: LogoLoaderProps) {
  return (
    <span
      className="logo-loader"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-hidden={announce ? undefined : "true"}
    >
      <span className="logo-loader__glow" aria-hidden="true" />
      <SkyLabMark className="logo-loader__mark" size={size} />
      {announce ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
