import { LogIn, ShieldCheck } from "lucide-react";
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

  return (
    <div className="full-state login-state">
      <section className="state-card" aria-labelledby="login-title">
        <span className="state-card__icon" aria-hidden="true">
          <ShieldCheck size={26} strokeWidth={1.6} />
        </span>
        <p className="eyebrow">SKY LAB</p>
        <h1 id="login-title">Hesap Merkezi’ne giriş yap</h1>
        <p>Kimliğini SKY LAB’ın güvenli giriş ekranında doğrulayarak devam et.</p>
        {hasError ? (
          <p className="login-state__message" role="alert">
            Giriş tamamlanamadı. Lütfen yeniden dene.
          </p>
        ) : null}
        {loggedOut || sessionEnded ? (
          <p className="login-state__message" role="status">
            Bu cihazdaki Hesap Merkezi oturumu kapatıldı.
          </p>
        ) : null}
        <a className="primary-button" href={loginUrl}>
          <LogIn aria-hidden="true" size={17} />
          SKY LAB ile giriş yap
        </a>
      </section>
    </div>
  );
}
