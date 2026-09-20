import type { AccountActionKind } from "@/server/auth/types";

export function SecurityActionForm({
  action,
  csrfToken,
  credential,
  children,
  label,
  tone = "default",
}: {
  action: AccountActionKind;
  csrfToken: string;
  credential?: string;
  children: React.ReactNode;
  label: string;
  tone?: "default" | "danger";
}) {
  return (
    <form action="/api/auth/action" method="post">
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="action" value={action} />
      {credential ? <input type="hidden" name="credential" value={credential} /> : null}
      <button aria-label={label} className="security-action" data-tone={tone} type="submit">
        {children}
      </button>
    </form>
  );
}
