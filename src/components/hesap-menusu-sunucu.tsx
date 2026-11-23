import { HesapMenusu } from "@/components/hesap-menusu";
import { loadShellIdentity } from "@/server/account-shell/identity";

/** The account menu with the signed-in person, once their profile is read; the layout streams it in. */
export async function HesapMenusuSunucu() {
  return <HesapMenusu identity={await loadShellIdentity()} />;
}
