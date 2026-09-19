import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { SESSION_COOKIE } from "@/server/auth/http";
import { getAuthServices } from "@/server/auth/services";

export default async function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const services = getAuthServices();
  const handle = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await services.sessions.authenticate(handle);
  if (!session) redirect("/login");

  return (
    <AccountShell logoutCsrfToken={services.sessions.csrfToken(session.session.id)}>
      {children}
    </AccountShell>
  );
}
