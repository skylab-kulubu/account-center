/**
 * Shared by the BFF client and the browser: the only link either one will
 * open for "Google Cüzdana ekle" is Google's save URL with a compact JWS
 * (`https://pay.google.com/gp/v/save/<header>.<payload>.<signature>`), so a
 * drifting or hostile answer can never become a navigation elsewhere.
 */
const SAVE_URL = /^https:\/\/pay\.google\.com\/gp\/v\/save\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SAVE_URL_LENGTH = 8_192;

export function isGoogleWalletSaveUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SAVE_URL_LENGTH && SAVE_URL.test(value);
}

/**
 * Google's Turkish "Google Cüzdana ekle" artwork, taken byte for byte from
 * the SVG set of the Google Wallet brand guidelines
 * (https://developers.google.com/wallet/generic/resources/brand-guidelines,
 * `add-to-wallet-svg.zip`): the primary button (`…_wallet-button.svg`,
 * 283×50) and, where space is limited, the condensed badge
 * (`…_add-wallet-badge.svg`, 189×55). The guidelines forbid redrawing,
 * recolouring or reshaping them and ask for at least 48 dp of height.
 */
export const GOOGLE_WALLET_BUTTON_SRC = "/google-wallet/tr_add_to_google_wallet_button.svg";
export const GOOGLE_WALLET_BADGE_SRC = "/google-wallet/tr_add_to_google_wallet_badge.svg";
/** The visible text of Google's Turkish artwork, used as its accessible name. */
export const GOOGLE_WALLET_BUTTON_LABEL = "Google Cüzdana ekle";
/**
 * Below this viewport width the primary button (272 px wide at 48 px) no
 * longer fits the card, so the condensed badge is shown instead of
 * shrinking the button under 48 px.
 */
export const GOOGLE_WALLET_CONDENSED_MEDIA = "(max-width: 359px)";
