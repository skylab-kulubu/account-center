import { Suspense } from "react";
import { IdentityManager } from "@/components/identity-manager";
import { AccountPageHeader } from "@/components/settings";
import { accountRoute } from "@/config/account-routes";
import { getAuthConfig } from "@/server/auth/config";

const route = accountRoute("/identity");

export const metadata = { title: route.documentTitle };

/**
 * Server-rendered shell; the identity (name, username, YTÜ status, e-mail
 * rows) and every change run in the browser against `/api/account/identity*`
 * so the sky-account SPI stays the single place the Verified YTÜ lock, the
 * username uniqueness and the 14-day cooldown are enforced. The YTÜ link
 * returns here with `?ytu=`, which the manager reads once (hence Suspense).
 * The Keycloak origin is rendered from the server's own `OIDC_ISSUER` so the
 * link can only ever navigate there, whatever a route answer contains.
 */
export default function IdentityPage() {
  return (
    <div className="page-stack">
      <AccountPageHeader route={route} />
      <Suspense fallback={null}>
        <IdentityManager keycloakOrigin={getAuthConfig().issuer.origin} />
      </Suspense>
    </div>
  );
}
