"use client";

import {
  Avatar,
  avatarTone,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  useTheme,
  type ThemePreference,
} from "@skylab-kulubu/skylcn-ui";
import { ChevronDown, LogOut, Palette } from "lucide-react";
import type { ShellIdentity } from "@/server/account-shell/identity";

/** The hidden sign-out form the menu submits (`AccountShell` renders it). */
export const SIGN_OUT_FORM_ID = "account-sign-out";

/*
 * The account button, the same in every SKY LAB product's top bar (panel #154, İletişim #176):
 * on wide screens the name first (cut at about 16 characters), then a chevron, the 32 px avatar
 * last against the corner (as in Entra and the Azure portal), in a thin-bordered pill 36 px high;
 * on phones the avatar alone in a 36 px touch target. Hover, open and focus are drawn. The wide
 * layout starts where Account Center's side menu does (861 px), not at Tailwind's `md`.
 */
const ACCOUNT_BUTTON =
  "group text-foreground hover:bg-accent data-popup-open:bg-accent focus-visible:ring-ring focus-visible:ring-offset-background flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 min-[861px]:w-auto min-[861px]:justify-start min-[861px]:gap-2 min-[861px]:border-border min-[861px]:bg-muted/40 min-[861px]:pr-px min-[861px]:pl-2.5 min-[861px]:hover:border-border-strong min-[861px]:data-popup-open:border-border-strong";

/** Stronger than the lists' faint tint, so the button reads at a glance; same hue per person. */
const AVATAR_TONES = [
  "border-chart-1/60 bg-chart-1/45",
  "border-chart-2/60 bg-chart-2/45",
  "border-chart-3/60 bg-chart-3/45",
  "border-chart-4/60 bg-chart-4/45",
  "border-chart-5/60 bg-chart-5/45",
  "border-chart-6/60 bg-chart-6/45",
  "border-chart-7/60 bg-chart-7/45",
  "border-chart-8/60 bg-chart-8/45",
];

/**
 * The signed-in person at the top right: name and e-mail, the theme, sign-out (top bar standard
 * 5.2; Account Center has no "Hesap merkezi" row of its own). Opens and signs out before the
 * person's profile arrives.
 */
export function AccountMenu({ identity }: { identity: ShellIdentity | null }) {
  const { theme, setTheme } = useTheme();
  const name = identity?.name ?? null;
  const email = identity?.email ?? null;
  const picture = identity?.pictureUrl ?? null;
  const tone = AVATAR_TONES[avatarTone(name, email)] ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={name ? `Hesap: ${name}` : "Hesap"} title={name ?? undefined} className={ACCOUNT_BUTTON}>
        {name ? <span className="hidden max-w-[16ch] truncate text-sm font-medium min-[861px]:inline">{name}</span> : null}
        <ChevronDown
          aria-hidden
          className="text-muted-foreground hidden size-3.5 shrink-0 transition-transform group-data-popup-open:rotate-180 min-[861px]:block"
        />
        <Avatar name={name} email={email} src={picture} size="sm" className={`text-2xs size-8 ${tone}`} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={name} email={email} src={picture} size="md" />
          <div className="min-w-0">
            <p className="text-foreground-strong truncate text-sm font-medium">{name ?? "Hesap"}</p>
            {email ? <p className="text-subtle-foreground truncate text-[13px]/5">{email}</p> : null}
          </div>
        </div>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger icon={Palette}>Tema</MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)}>
              <MenuRadioItem value="dark">Koyu</MenuRadioItem>
              <MenuRadioItem value="light">Açık</MenuRadioItem>
              <MenuRadioItem value="system">Sistem</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
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
