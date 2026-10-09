/**
 * Shared by the BFF client and the browser: the only link either one will
 * open for "Google Cüzdan'a ekle" is Google's save URL with a compact JWS
 * (`https://pay.google.com/gp/v/save/<header>.<payload>.<signature>`), so a
 * drifting or hostile answer can never become a navigation elsewhere.
 */
const SAVE_URL = /^https:\/\/pay\.google\.com\/gp\/v\/save\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SAVE_URL_LENGTH = 8_192;

export function isGoogleWalletSaveUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SAVE_URL_LENGTH && SAVE_URL.test(value);
}

/**
 * Google's Turkish "Google Cüzdan'a ekle" button (primary style), taken
 * unchanged from the SVG set of the Google Wallet brand guidelines
 * (https://developers.google.com/wallet/generic/resources/brand-guidelines).
 * The guidelines forbid redrawing, recolouring or reshaping it.
 */
export const GOOGLE_WALLET_BUTTON_SRC = "/google-wallet/tr_add_to_google_wallet_button.svg";
