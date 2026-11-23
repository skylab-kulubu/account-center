import Link from "next/link";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/** A card on a section page, as on Google Account's Kişisel bilgiler and Güvenlik pages. */
export function SectionCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="section-card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="section-card__rows">{children}</ul>
    </section>
  );
}

/** One row: the label, its value, and the whole row leads to the page that changes it. */
export function SectionRow({
  href,
  label,
  value,
  tone,
  external = false,
}: {
  href: string;
  label: string;
  value?: ReactNode;
  tone?: "danger";
  external?: boolean;
}) {
  const content = (
    <>
      <span className="section-card__label">{label}</span>
      {value !== undefined ? <span className="section-card__value">{value}</span> : <span className="section-card__value" />}
      {external
        ? <ExternalLink className="section-card__chevron" aria-hidden="true" size={16} />
        : <ChevronRight className="section-card__chevron" aria-hidden="true" size={18} />}
    </>
  );
  return (
    <li>
      {external ? (
        <a className="section-card__row" href={href} target="_blank" rel="noreferrer" data-tone={tone}>
          {content}
        </a>
      ) : (
        <Link className="section-card__row" href={href} data-tone={tone}>
          {content}
        </Link>
      )}
    </li>
  );
}
