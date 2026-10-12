"use client";

// A client component: skylcn's StateCard is one, and a server component cannot
// hand it the Lucide icon (a function) across the boundary.
import Link from "next/link";
import { AlertCircle, LogIn, RotateCcw } from "lucide-react";
import { Button, StateCard } from "@skylab-kulubu/skylcn-ui";
import { framedStateCard } from "@/components/framed-state";
import type { AccountProblem } from "@/server/keycloak-account/problem";

export function AccountDataProblem({ problem, retryHref }: { problem: AccountProblem; retryHref: string }) {
  const needsLogin = problem.status === 401;
  const destination = needsLogin
    ? `/login?returnTo=${encodeURIComponent(retryHref)}`
    : retryHref;
  return (
    <div role="status" aria-live="polite">
      <StateCard
        className={framedStateCard}
        description={problem.detail}
        icon={AlertCircle}
        title={problem.title}
        tone="danger"
      >
        <Button render={<Link href={destination} />} size="lg" variant="solid">
          {needsLogin ? <LogIn aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
          {needsLogin ? "Yeniden giriş yap" : "Yeniden dene"}
        </Button>
      </StateCard>
    </div>
  );
}
