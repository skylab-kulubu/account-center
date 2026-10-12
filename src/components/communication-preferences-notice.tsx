"use client";

// A client component: a server component cannot hand skylcn's Notice the Lucide
// icon (a function) across the boundary.

import { BellOff } from "lucide-react";
import { Button, Notice } from "@skylab-kulubu/skylcn-ui";
import Link from "next/link";

type Problem = { title: string; detail: string; status: number; code?: string };

const LOGIN_HREF = "/login?returnTo=%2Fcommunication-preferences";

/**
 * Why the preferences are not shown: off in this environment (no core),
 * not switched on in core yet (`503 communication_preferences_unavailable`),
 * or a failure worth a retry or a fresh login.
 */
export function CommunicationPreferencesNotice({ problem }: { problem: Problem }) {
  const switchedOff = problem.code === "communication_preferences_unavailable" ||
    problem.code === "communication_preferences_disabled";
  return (
    <Notice
      action={switchedOff ? undefined : problem.status === 401 ? (
        <Button render={<Link href={LOGIN_HREF} />} size="sm" variant="link">Yeniden giriş yap</Button>
      ) : (
        <Button render={<Link href="/communication-preferences" />} size="sm" variant="link">Yeniden dene</Button>
      )}
      icon={switchedOff ? BellOff : undefined}
      title={problem.title}
      tone={switchedOff ? "info" : "warning"}
    >
      {problem.detail}
    </Notice>
  );
}
