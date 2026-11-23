import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { accountSection } from "@/config/account-routes";
import type { AccountRoute } from "@/config/account-routes";

/** The page's title; a sub-page also links back to its section (Google Account's back arrow). */
export function AccountPageHeader({ route }: { route: AccountRoute }) {
  const parent = route.section !== route.href ? accountSection(route.section) : null;
  return (
    <header className="page-header">
      {parent ? (
        <Link className="page-header__back" href={parent.href}>
          <ChevronLeft aria-hidden="true" size={18} />
          {parent.label}
        </Link>
      ) : null}
      <h1>{route.title}</h1>
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
      {trailing ? <div className="settings-row__trailing">{trailing}</div> : null}
      {!trailing && href ? <ChevronRight className="settings-row__chevron" aria-hidden="true" size={19} /> : null}
    </>
  );

  if (href) {
    return (
      <Link className="settings-row" data-has-trailing={trailing ? "" : undefined} data-tone={tone} href={href}>
        {content}
      </Link>
    );
  }

  return (
    <div className="settings-row" data-has-trailing={trailing ? "" : undefined} data-tone={tone}>
      {content}
    </div>
  );
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "positive" | "warning" }) {
  return <span className="status-badge" data-tone={tone}>{children}</span>;
}
