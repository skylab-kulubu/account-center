import "server-only";

/**
 * The OAuth `error` values (RFC 6749 §4.1.2.1, OpenID Connect Core §3.1.2.6)
 * a failed login may name in the logs. Anything else becomes `other`;
 * `error_description` and `error_uri` are never read, because they are free
 * text that anyone opening the callback address can put there.
 */
const OAUTH_CALLBACK_ERRORS = [
  "access_denied",
  "login_required",
  "interaction_required",
  "consent_required",
  "temporarily_unavailable",
  "server_error",
  "invalid_request",
  "unauthorized_client",
  "invalid_scope",
] as const;

export type OAuthCallbackError = (typeof OAUTH_CALLBACK_ERRORS)[number] | "other";

function isKnown(value: string): value is (typeof OAUTH_CALLBACK_ERRORS)[number] {
  return (OAUTH_CALLBACK_ERRORS as readonly string[]).includes(value);
}

/** The callback's `error` parameter, allowlisted; `undefined` when there is none. */
export function oauthCallbackError(parameters: URLSearchParams): OAuthCallbackError | undefined {
  const value = parameters.get("error");
  if (value === null) return undefined;
  return isKnown(value) ? value : "other";
}
