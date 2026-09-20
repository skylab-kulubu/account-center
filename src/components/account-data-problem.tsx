import Link from "next/link";
import { AlertCircle, LogIn, RotateCcw } from "lucide-react";
import type { AccountProblem } from "@/server/keycloak-account/problem";

export function AccountDataProblem({ problem, retryHref }: { problem: AccountProblem; retryHref: string }) {
  const needsLogin = problem.status === 401;
  const destination = needsLogin
    ? `/login?returnTo=${encodeURIComponent(retryHref)}`
    : retryHref;
  return (
    <section className="state-card account-data-problem" role="status" aria-live="polite">
      <span className="state-card__icon" aria-hidden="true">
        <AlertCircle size={26} strokeWidth={1.6} />
      </span>
      <h2>{problem.title}</h2>
      <p>{problem.detail}</p>
      <Link className="primary-button" href={destination}>
        {needsLogin ? <LogIn aria-hidden="true" size={16} /> : <RotateCcw aria-hidden="true" size={16} />}
        {needsLogin ? "Yeniden giriş yap" : "Yeniden dene"}
      </Link>
    </section>
  );
}
