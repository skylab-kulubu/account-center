# Password, passkey and OTP action contract

Account Center does not embed or redirect to the Keycloak Account Console. Password, TOTP and passwordless WebAuthn changes use Keycloak 26.7.4 application-initiated actions (AIA) through the existing confidential `account-center` OIDC client. The built-in Keycloak `DELETE_ACCOUNT` action is not a destination in this product.

## Allowed actions

The application accepts only these product actions and maps them server-side:

| Product action | Keycloak `kc_action` |
| --- | --- |
| Change password | `UPDATE_PASSWORD` |
| Add authenticator app | `CONFIGURE_TOTP` |
| Add passkey | `webauthn-register-passwordless` |
| Remove one owned OTP/passkey | `delete_credential:{credentialId}` |

The browser submits `password`, `otp`, `passkey`, or `delete-credential`; it never submits a Keycloak action name or raw credential ID. The security page receives a session-bound HMAC reference for each removable credential. The BFF re-reads `/account/credentials`, resolves that reference against the current user's removable inventory with a constant-time comparison, and only then places the exact owned ID inside the server-to-server PAR body. The authorization URL exposed to the browser contains only `client_id` and `request_uri`.

## Transaction and callback

Every action uses a one-time encrypted PostgreSQL transaction and the host-only `__Host-sky-account-txn` cookie. The transaction binds:

- state, nonce and S256 PKCE verifier;
- the exact action and pre-action credential inventory;
- expected Keycloak subject and current opaque BFF session ID;
- initiation time and the fixed `/security` return path.

The POST initiation endpoint requires exact same-origin and the current session CSRF proof, then runs the shared account-access gate before reading credentials or creating state. PAR sends `prompt=login` and `max_age=0`. Keycloak's credential required actions enforce the credential-specific LoA; the BFF also rejects a returned identity whose signed `auth_time` predates the transaction.

The shared `/api/auth/callback` consumes the transaction once. A success must have the expected Keycloak action/status, signed subject, fresh `auth_time`, active platform account and original BFF session. `kc_action_status=success` is not proof of a change. The BFF re-reads the Keycloak credential inventory with the newly issued, contract-validated user token and requires an observable result:

- password credential added or its persisted timestamp/row changed;
- a new OTP credential ID appeared;
- a new passwordless WebAuthn credential ID appeared;
- the exact deleted credential ID disappeared.

If Keycloak reports success without that evidence, the UI shows `unverified` and does not claim completion. After a valid fresh-auth exchange, the encrypted token set and returned Keycloak `sid` are compare-and-swapped together so sid-only backchannel logout continues to target the current upstream session. This update does not extend the BFF session's absolute lifetime.

Success, cancel, provider error and verification-failure feedback is written as a five-minute, session-bound, one-time PostgreSQL result. The browser receives only a 256-bit opaque result reference; the public URL cannot choose an action or status. Server rendering reads the result without consuming it so an aborted navigation cannot lose the message. After the committed page becomes visible, the browser acknowledges it through an exact-origin, session-CSRF-protected endpoint; only then is it atomically consumed. A failed acknowledgement leaves the message retryable until expiry, while another session cannot acknowledge it and reload/replay after acknowledgement cannot reproduce the banner. Callback responses use `no-store` and `Referrer-Policy: no-referrer`; state, code, credential IDs and tokens are never logged or copied to the UI.

## Environment

No separate Account Console URL, action URL or redirect environment variable exists. Runtime and startup validation require the dedicated `OIDC_CLIENT_ID=account-center`, canonical `APP_URL`, canonical realm `OIDC_ISSUER`, confidential client secret and the existing BFF/access-gate secrets. The only redirect URI remains:

```text
https://my.yildizskylab.com/api/auth/callback
```

## Production-clone release gates

Fixture and unit tests cannot prove browser-required actions. Production remains blocked until a non-production clone of the 26.7.4 realm proves all of the following with the source-controlled SKY LAB theme:

1. `UPDATE_PASSWORD`, `CONFIGURE_TOTP`, `webauthn-register-passwordless`, and non-default `delete_credential` are enabled for AIA.
2. Password success produces the inventory delta expected by this BFF on the actual user store. If the store does not update credential ID or `createdDate`, a separate server-verifiable evidence contract is required; do not weaken verification to trust `kc_action_status`.
3. Add/delete success and cancel paths work for TOTP and passwordless WebAuthn, including Keycloak's credential-specific LoA challenge.
4. Subject, nonce, state, PKCE, `auth_time`, callback action/status and Account REST token contracts pass with the real confidential client.
5. Desktop and mobile WebView browser runs cover passkey registration, WebAuthn error retry, Turkish copy, keyboard/focus behavior, reduced motion and contrast.
6. A success reported without inventory change is demonstrated to remain `unverified`; an unowned deletion reference is rejected before PAR.

The real production realm is not a smoke-test target. No mobile repository change is part of this implementation.

## Upstream contract references

- [Keycloak 26.7.4 Server Administration Guide — Application initiated actions](https://www.keycloak.org/docs/26.7.4/server_admin/#application-initiated-actions)
- [Keycloak 26.7.4 `DeleteCredentialAction`](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/authentication/requiredactions/DeleteCredentialAction.java)
- [Keycloak 26.7.4 authorization endpoint action parameter handling](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/protocol/oidc/endpoints/AuthorizationEndpoint.java)
