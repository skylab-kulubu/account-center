"use client";

import {
  Avatar,
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

/** The hidden sign-out form the menu submits: a same-origin POST with the session's CSRF token. */
export const CIKIS_FORMU_ID = "hesap-cikis-formu";

/**
 * Sağ üstteki hesap menüsü (H1 #138 davranışı: kimlik core, yoksa Keycloak) (üst çubuk standardı 5.2, Panel'in UserMenu'suyla aynı sıra):
 * ad ve e-posta, Tema, Çıkış yap. Hesap merkezinin kendisinde "Hesap merkezi" satırı yok.
 */
export function HesapMenusu({ identity }: { identity: ShellIdentity | null }) {
  const { theme, setTheme } = useTheme();
  const name = identity?.name ?? "Hesap";
  const email = identity?.email ?? null;
  const avatarSrc = identity?.pictureUrl ?? null;
  return (
    <DropdownMenu>
      {/* Belirgin düğme: avatar + ad (masaüstü) + ok, çerçeveli (Microsoft/Google hesap yöneticisi gibi) */}
      <DropdownMenuTrigger aria-label={`Hesap: ${name}`} className="hesap-dugmesi">
        <Avatar className="hesap-dugmesi__avatar" name={name} email={email ?? undefined} src={avatarSrc ?? undefined} size="sm" />
        <span className="hesap-dugmesi__ad">{identity?.name ?? ""}</span>
        <ChevronDown className="hesap-dugmesi__ok" aria-hidden="true" size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <div className="hesap-menusu__baslik">
          <Avatar name={name} email={email ?? undefined} src={avatarSrc ?? undefined} size="md" />
          <div>
            <p className="hesap-menusu__ad">{name}</p>
            {email ? <p className="hesap-menusu__eposta">{email}</p> : null}
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
          onClick={() => (document.getElementById(CIKIS_FORMU_ID) as HTMLFormElement | null)?.requestSubmit()}
        >
          Çıkış yap
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
