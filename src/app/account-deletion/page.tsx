import { AccountDeletionStatus } from "@/components/account-deletion-status";
import { Background } from "@/components/background";

export const metadata = { title: "Hesap silme durumu" };

export default function AccountDeletionStatusPage() {
  return (
    <div className="account-root">
      <Background />
      <main className="full-state deletion-status-page">
        <AccountDeletionStatus />
      </main>
    </div>
  );
}
