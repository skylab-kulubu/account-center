import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { SudoProvider } from "@/components/sudo-provider";
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

  return (
    <AccountShell logoutCsrfToken={services.sessions.csrfToken(session.session.id)} embedded={embedded}>
      <SudoProvider>{children}</SudoProvider>
    </AccountShell>
  );
}
