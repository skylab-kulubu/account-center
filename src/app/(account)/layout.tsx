import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AccountMenu } from "@/components/account-menu";
import { AccountShell } from "@/components/account-shell";
import { ShellAccount } from "@/components/shell-account";
import { SudoProvider } from "@/components/sudo-provider";
import { isSandbox } from "@/lib/environment";
import { getAuthConfig } from "@/server/auth/config";
import { EMBEDDED_APP_COOKIE } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";
import { currentAccountSession } from "@/server/access-gate/current-session";

export default async function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value;
  const embedded = (await cookies()).get(EMBEDDED_APP_COOKIE)?.value === "skyapp";
  const config = getAuthConfig();

  return (
    <AccountShell
      logoutCsrfToken={services.sessions.csrfToken(session.session.id)}
      embedded={embedded}
      inboxEnabled={services.skynotifyInbox !== null}
      sandbox={isSandbox({ appUrl: config.appUrl, issuer: config.issuer })}
      // The person's profile is read beside the page, not before it: the menu opens and signs
      // out at once, and shows the name and photo when they arrive
      account={embedded ? null : (
        <Suspense fallback={<AccountMenu identity={null} />}>
          <ShellAccount />
        </Suspense>
      )}
    >
      <SudoProvider>{children}</SudoProvider>
    </AccountShell>
  );
}
