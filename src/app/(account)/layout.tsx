import { redirect } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { SudoProvider } from "@/components/sudo-provider";
import { getAuthServices } from "@/server/auth/services";
import { currentAccountSession } from "@/server/access-gate/current-session";

export default async function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const services = getAuthServices();
  const authorization = await currentAccountSession();
  if (authorization.status === "blocked") redirect("/api/auth/session/end");
  if (authorization.status === "unavailable") redirect("/api/auth/unavailable");
  if (authorization.status !== "active") redirect("/login");
  const session = authorization.value;

  return (
    <AccountShell logoutCsrfToken={services.sessions.csrfToken(session.session.id)}>
      <SudoProvider>{children}</SudoProvider>
    </AccountShell>
  );
}
