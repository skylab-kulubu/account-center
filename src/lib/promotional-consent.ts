/**
 * The promotional consent ("Tanıtım içerikleri"): core's contact consent
 * of purpose `promotional` (core `docs/contact-consents.md`, aydınlatma s6
 * §5.8), shared by the BFF and the browser. One grant per person and
 * mailbox, whichever box gave it. The box is unticked; an unticked box
 * records nothing and withdraws nothing. No server-only imports.
 */

export const PROMOTIONAL_PURPOSE = "promotional";

/**
 * The text version the box shows, sent with every grant. Core's
 * `tanitim-v1` until the Açık Rıza Metni (hub ticket 03) is approved; a new
 * wording is a new version in core first.
 */
export const PROMOTIONAL_TEXT_VERSION = "tanitim-v1";

/** Core's box text of `tanitim-v1`, word for word. */
export const PROMOTIONAL_TEXT = "SKY LAB'dan tanıtım içerikli e-postalar (indirim kodu, şirket iş ilanı, çekiliş gibi) almak istiyorum.";

export const PROMOTIONAL_TITLE = "Tanıtım içerikleri";

/**
 * The Açık Rıza Metni (skylab-site, hub ticket 03). Core's
 * `CONTACT_CONSENT_TEXT_URL` must name the same published file before the
 * consent record is switched on.
 */
export const CONSENT_TEXT_URL = "https://yildizskylab.com/acik-riza-metni.pdf";

/**
 * Where the box was ticked: `self`, the communication preferences, the
 * only place Account Center shows it (the box after signup, hub ticket 05,
 * was dropped on 2026-10-24).
 */
export const PROMOTIONAL_SOURCES = ["self"] as const;
export type PromotionalConsentSource = (typeof PROMOTIONAL_SOURCES)[number];

/**
 * The person's promotional consent: `active` (mails may go), `pending`
 * (given in a form for one of their addresses, waiting for the confirmation
 * link) or `none`.
 */
export type PromotionalConsentState = "active" | "pending" | "none";

export function isPromotionalConsentSource(value: unknown): value is PromotionalConsentSource {
  return (PROMOTIONAL_SOURCES as readonly unknown[]).includes(value);
}

export function isPromotionalConsentState(value: unknown): value is PromotionalConsentState {
  return value === "active" || value === "pending" || value === "none";
}
