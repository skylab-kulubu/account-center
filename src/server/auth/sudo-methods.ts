import "server-only";

import type { SudoMethod } from "@/server/auth/sudo";
import type { AccountReadService } from "@/server/keycloak-account/service";
import type { SkyAccountClient, SkyAccountIdentity } from "@/server/sky-account/types";

/**
 * Which Sudo mode proofs the person can complete inside `my.`, in the order
 * the dialog shows them (Parola · Passkey · Doğrulama kodu), and the Microsoft
 * re-authentication fallback offered only when none exists. Carries no
 * credential ids, labels or other PII.
 */
export type SudoMethodAvailability = {
  methods: SudoMethod[];
  fallback: "microsoft" | null;
};

export function sudoMethodAvailability(credentials: SkyAccountIdentity["credentials"]): SudoMethodAvailability {
  const methods: SudoMethod[] = [];
  if (credentials.password) methods.push("password");
  // Legacy two-factor `webauthn` credentials are not passkeys: the SPI does not
  // accept them for sudo, so they must not light up the tab.
  if (credentials.passkeys.some(({ type }) => type === "webauthn-passwordless")) methods.push("passkey");
  if (credentials.totp.length > 0) methods.push("totp");
  return { methods, fallback: methods.length === 0 ? "microsoft" : null };
}

export type SudoMethodsSource = {
  account: Pick<AccountReadService, "accessToken">;
  skyAccount: Pick<SkyAccountClient, "identity">;
};

/** Reads `GET identity` with the session's own bearer and reduces it to the availability view. */
export async function resolveSudoMethods(
  source: SudoMethodsSource,
  session: { id: string; subject: string },
): Promise<SudoMethodAvailability> {
  const accessToken = await source.account.accessToken(session);
  const identity = await source.skyAccount.identity({ accessToken });
  return sudoMethodAvailability(identity.credentials);
}
