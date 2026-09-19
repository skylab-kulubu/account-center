import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description }: { eyebrow?: string; title: string; description: string }) {
  return (
    <header className="page-header">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section__heading">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settings-group">{children}</div>
    </section>
  );
}

type SettingsRowProps = {
  title: string;
  description: string;
  icon?: ReactNode;
  href?: string;
  trailing?: ReactNode;
  tone?: "default" | "danger";
};

export function SettingsRow({ title, description, icon, href, trailing, tone = "default" }: SettingsRowProps) {
  const content = (
    <>
      {icon ? <span className="settings-row__icon">{icon}</span> : null}
      <span className="settings-row__copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {trailing ?? (href ? <ChevronRight className="settings-row__chevron" aria-hidden="true" size={19} /> : null)}
    </>
  );

  if (href) {
    return (
      <Link className="settings-row" data-tone={tone} href={href}>
        {content}
      </Link>
    );
  }

  return (
    <div className="settings-row" data-tone={tone}>
      {content}
    </div>
  );
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "positive" | "warning" }) {
  return <span className="status-badge" data-tone={tone}>{children}</span>;
}
