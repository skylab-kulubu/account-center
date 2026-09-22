/**
 * Credential label normalisation shared by the security routes and the page,
 * mirroring the sky-account SPI's rule for names and labels
 * (`docs/sky-account-api.md`): zero-width and other format characters
 * (`\p{Cf}`) are dropped, every kind of whitespace and separator (including
 * NBSP and the Unicode space separators) collapses to one ASCII space, and
 * the result is trimmed. Applied before any length or duplicate check so a
 * label that only looks different cannot slip past either.
 */
export const MAX_CREDENTIAL_LABEL_LENGTH = 64;

export function normalizeLabel(value: string): string {
  return value.replace(/\p{Cf}/gu, "").replace(/[\s\p{Z}]+/gu, " ").trim();
}

/** The normalised label, or `null` when it is empty or longer than the SPI accepts. */
export function validCredentialLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = normalizeLabel(value);
  return label.length === 0 || label.length > MAX_CREDENTIAL_LABEL_LENGTH ? null : label;
}
