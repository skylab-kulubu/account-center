/**
 * The team page switch ("Ekip sayfalarında görün", core
 * `docs/team-page-consent.md`, aydınlatma s6 row 4 b): every member is shown
 * on their teams' public pages unless they object, so the switch is on
 * unless the person turned it off. Turning it off records core's objection
 * of purpose `team_page_objection`; turning it on again ends it. Only the
 * person records it, for their own account. Shared by the BFF and the
 * browser. No server-only imports.
 */

export const TEAM_PAGE_OBJECTION_PURPOSE = "team_page_objection";

/** The text version an objection is recorded on. A new wording is a new version in core first. */
export const TEAM_PAGE_TEXT_VERSION = "ekip-sayfasi-itiraz-v1";

/** The switch's label. */
export const TEAM_PAGE_LABEL = "Ekip sayfalarında görün";

/** The switch's description: what is shown. */
export const TEAM_PAGE_DESCRIPTION =
  "Adın, soyadın, profil fotoğrafın, LinkedIn adresin, üniversiten, fakülten, bölümün ve ekip liderliğin ekibinin SKY LAB uygulamasındaki sayfasında yer alır.";

/** Core's text of `ekip-sayfasi-itiraz-v1`, word for word: label and description. */
export const TEAM_PAGE_TEXT = `${TEAM_PAGE_LABEL}. ${TEAM_PAGE_DESCRIPTION}`;

export const TEAM_PAGE_TITLE = "Ekip sayfaları";

/** The person on the team pages: `shown` (no objection) or `hidden` (an open objection). */
export type TeamPageConsentState = "shown" | "hidden";

export function isTeamPageConsentState(value: unknown): value is TeamPageConsentState {
  return value === "shown" || value === "hidden";
}
