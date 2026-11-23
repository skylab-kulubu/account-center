import { AccountMenu } from "@/components/account-menu";
import { loadShellIdentity } from "@/server/account-shell/identity";

/** The account menu with the signed-in person, once their profile is read; the layout streams it in. */
export async function ShellAccount() {
  return <AccountMenu identity={await loadShellIdentity()} />;
}
