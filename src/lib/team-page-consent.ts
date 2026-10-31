/**
 * The team page consent ("Ekip sayfalarında görüneyim"): core's consent of
 * purpose `team_page` (core `docs/team-page-consent.md`, aydınlatma s6
 * row 4 b), shared by the BFF and the browser. The switch is off unless the
 * person turned it on; only the person gives it, for their own account.
 * No server-only imports.
 */

export const TEAM_PAGE_PURPOSE = "team_page";

/** The text version the switch shows, sent with every grant. A new wording is a new version in core first. */
export const TEAM_PAGE_TEXT_VERSION = "ekip-sayfasi-v1";

/** Core's text of `ekip-sayfasi-v1`, word for word: the switch's label. */
export const TEAM_PAGE_TEXT =
  "Ekip sayfalarında görüneyim: adım, soyadım, profil fotoğrafım, LinkedIn adresim, üniversitem, fakültem, bölümüm ve ekip liderliğim ekibimin SKY LAB uygulamasındaki sayfasında yayımlansın.";

export const TEAM_PAGE_TITLE = "Ekip sayfaları";

/** The person's team page consent: `active` (shown) or `none`. */
export type TeamPageConsentState = "active" | "none";

export function isTeamPageConsentState(value: unknown): value is TeamPageConsentState {
  return value === "active" || value === "none";
}
