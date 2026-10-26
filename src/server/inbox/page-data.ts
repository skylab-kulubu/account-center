import "server-only";

import { redirect } from "next/navigation";
import type { InboxPage } from "@/lib/inbox";
import { currentAccountSession } from "@/server/access-gate/current-session";
import { getAuthServices } from "@/server/auth/services";
import { inboxDisabledProblem, toInboxProblem } from "@/server/inbox/problem";
import type { InboxProblem } from "@/server/inbox/problem";
import { inboxServiceFor } from "@/server/inbox/service";

export type InboxPageData = {
  inbox: { status: "ready"; value: InboxPage } | { status: "problem"; problem: InboxProblem };
  csrfToken: string;
};

/**
 * The first page of the inbox for the active session. SkyMail down, or off in
 * this environment, answers a problem the page shows in its place; the rest
 * of Hesap Merkezi is untouched.
 */
export async function loadInboxPage(): Promise<InboxPageData> {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value.session;
  const csrfToken = services.sessions.csrfToken(session.id);
  const inbox = inboxServiceFor(services);
  if (!inbox) return { inbox: { status: "problem", problem: inboxDisabledProblem }, csrfToken };
  try {
    return { inbox: { status: "ready", value: await inbox.list(session) }, csrfToken };
  } catch (error) {
    return { inbox: { status: "problem", problem: toInboxProblem(error) }, csrfToken };
  }
}
