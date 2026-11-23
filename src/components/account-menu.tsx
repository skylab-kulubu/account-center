"use client";

// The account menu of every SKY LAB product, at the top right (top bar standard, 2026-11-23):
// copied from the admin panel (core-frontend src/components/layout/UserMenu.tsx, PR #144) with
// Account Center's rows. Here there is no "Hesap merkezi" row (this is it) and no "Tema" row
// (Account Center is dark only). Goes away once skylcn-ui ships an AccountMenu and an `account`
// slot in AppShell (S1; Kaan).

import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "@skylab-kulubu/skylcn-ui";
import { LogOut } from "lucide-react";
import type { ShellIdentity } from "@/server/account-shell/identity";

/** The shell's sign-out form (`POST /api/auth/logout` with the session's CSRF token); the menu submits it. */
export const SIGN_OUT_FORM_ID = "account-sign-out";

export function AccountMenu({ identity }: { identity: ShellIdentity | null }) {
  const name = identity?.name ?? null;
  const email = identity?.email ?? null;
  const picture = identity?.pictureUrl ?? null;
  const label = name ?? email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label ? `Hesap: ${label}` : "Hesap"}
        title={label ?? undefined}
        className="account-menu__trigger hover:bg-accent data-popup-open:bg-accent focus-visible:ring-ring grid size-8 shrink-0 place-items-center rounded-full outline-hidden focus-visible:ring-2"
      >
        <Avatar name={name} email={email} src={picture} size="sm" shape="circle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        {label ? (
          <>
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar name={name} email={email} src={picture} size="md" shape="circle" />
              <div className="min-w-0">
                {name ? <p className="text-foreground-strong truncate text-sm font-medium">{name}</p> : null}
                {email ? <p className="text-subtle-foreground truncate text-[13px]/5">{email}</p> : null}
              </div>
            </div>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem
          icon={LogOut}
          destructive
          onClick={() => (document.getElementById(SIGN_OUT_FORM_ID) as HTMLFormElement | null)?.requestSubmit()}
        >
          Çıkış yap
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
