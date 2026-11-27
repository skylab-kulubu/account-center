import { LogIn, ShieldCheck } from "lucide-react";
import { Button, ErrorScenePage, Notice, TaskPage } from "@skylab-kulubu/skylcn-ui";
import { Background } from "@/components/background";
import { normalizeReturnTo } from "@/server/auth/oidc-flow";

export const metadata = { title: "Oturum aç" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const returnTo = normalizeReturnTo(
    typeof parameters.returnTo === "string" ? parameters.returnTo : undefined,
  );
  const loginUrl = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  const hasError = parameters.error === "invalid_request" || parameters.error === "unavailable";
  const loggedOut = parameters.loggedOut === "1";
  const sessionEnded = parameters.sessionEnded === "1";

  // The account gate ended the session: the session scene, its button signs in again.
  if (sessionEnded && !hasError) {
    return (
      <div className="account-root">
        <Background />
        <ErrorScenePage className="relative z-1 bg-transparent" href={loginUrl} kind="sessionExpired" />
      </div>
    );
  }

  return (
    <div className="account-root">
      <Background />
      <TaskPage
        actions={(
          <Button render={<a href={loginUrl} />} size="lg" variant="solid">
            <LogIn aria-hidden="true" />
            SKY LAB ile giriş yap
          </Button>
        )}
        align="center"
        className="relative z-1 bg-transparent"
        description="Kimliğini SKY LAB’ın güvenli giriş ekranında doğrulayarak devam et."
        icon={ShieldCheck}
        title="Hesap Merkezi’ne giriş yap"
        tone="brand"
      >
        {hasError ? (
          <Notice tone="danger">Giriş tamamlanamadı. Lütfen yeniden dene.</Notice>
        ) : null}
        {loggedOut ? (
          <Notice tone="success">Bu cihazdaki Hesap Merkezi oturumu kapatıldı.</Notice>
        ) : null}
      </TaskPage>
    </div>
  );
}
