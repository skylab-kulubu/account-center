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

export function sudoMethodAvailability(identity: Pick<SkyAccountIdentity, "credentials" | "sudoEmailCodeAvailable" | "verifiedYtu">): SudoMethodAvailability {
  const methods: SudoMethod[] = [];
  const { credentials } = identity;
  if (credentials.password) methods.push("password");
  if (credentials.passkeys.length > 0) methods.push("passkey");
  if (credentials.totp.length > 0) methods.push("totp");
  const noFactor = methods.length === 0;
  if (noFactor && identity.sudoEmailCodeAvailable) methods.push("email-code");
  return { methods, fallback: noFactor && identity.verifiedYtu ? "microsoft" : null };
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
  return sudoMethodAvailability(identity);
}
