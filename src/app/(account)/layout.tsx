import { AccountShell } from "@/components/account-shell";

export default function AccountLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AccountShell>{children}</AccountShell>;
}
