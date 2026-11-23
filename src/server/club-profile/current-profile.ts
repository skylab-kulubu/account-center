import "server-only";

import { cache } from "react";
import { clubProfileServiceFor } from "@/server/club-profile/service";
import type { CoreProfile } from "@/server/core/profile-client";

type Services = Parameters<typeof clubProfileServiceFor>[0];
type SessionIdentity = { id: string; subject: string };

const readOnce = cache((services: Services, sessionId: string, subject: string): Promise<CoreProfile> | null =>
  clubProfileServiceFor(services)?.read({ id: sessionId, subject }) ?? null);

/**
 * The person's core profile, read at most once while a page renders: the
 * shell's account menu and the club-profile page both show it, and core sees
 * one `GET /v1/users/me`. Null when club-profile features are off
 * (`CORE_API_URL` unset); a failed read fails both alike.
 */
export function readCurrentCoreProfile(services: Services, session: SessionIdentity): Promise<CoreProfile> | null {
  return readOnce(services, session.id, session.subject);
}
