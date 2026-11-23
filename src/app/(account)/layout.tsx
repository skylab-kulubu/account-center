import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AccountShell } from "@/components/account-shell";
import { HesapMenusu } from "@/components/hesap-menusu";
import { HesapMenusuSunucu } from "@/components/hesap-menusu-sunucu";
import { YeniKabuk } from "@/components/yeni-kabuk";
import { isSandbox } from "@/lib/environment";
import { getAuthConfig } from "@/server/auth/config";
import { currentTasarim } from "@/server/tasarim";
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
  const tasarim = await currentTasarim();

  // GEÇİCİ tasarım anahtarı: A ve B yeni kabukta (üst çubuk + hesap düğmesi, H1 davranışlarıyla)
  if (tasarim !== "eski") {
    const config = getAuthConfig();
    return (
      <YeniKabuk
        yon={tasarim}
        logoutCsrfToken={services.sessions.csrfToken(session.session.id)}
        embedded={embedded}
        inboxEnabled={services.skymailInbox !== null}
        sandbox={isSandbox({ appUrl: config.appUrl, issuer: config.issuer })}
        account={embedded ? null : (
          <Suspense fallback={<HesapMenusu identity={null} />}>
            <HesapMenusuSunucu />
          </Suspense>
        )}
      >
        <SudoProvider>{children}</SudoProvider>
      </YeniKabuk>
    );
  }

  return (
    <AccountShell
      logoutCsrfToken={services.sessions.csrfToken(session.session.id)}
      embedded={embedded}
      inboxEnabled={services.skymailInbox !== null}
    >
      <SudoProvider>{children}</SudoProvider>
    </AccountShell>
  );
}
