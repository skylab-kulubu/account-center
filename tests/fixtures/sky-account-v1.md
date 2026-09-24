# sky-account API v1 fixture contract

These JSON documents pin the sky-account Keycloak extension responses that
Account Center consumes, as specified in `docs/sky-account-api.md` (v1):

- `sky-account-v1-identity.json`: `GET identity`, also the body of
  `PATCH identity/name`, `POST identity/username`, `POST email/confirm`,
  `POST email/primary` and `DELETE email/personal`. `personalEmailVerified`
  arrived with the e-mail endpoints; the client reads its absence (an older
  release) as "not proven".
- `sky-account-v1-email-change-request.json`: `202` body of
  `POST email/change-request`, the deadline of the mailed six-digit code
  (ten minutes). The request body (`{ address }`) and the code are never
  pinned as fixtures.
- `sky-account-v1-email-pending.json`: `GET email/pending`, the caller's
  change still waiting for its code (address, deadline, tries left), read
  without consuming it; never the code. `404 no_pending_email_change` when
  nothing waits.
- `sky-account-v1-sudo-grant.json`: `POST sudo/password`, `POST sudo/totp` and
  `POST sudo/webauthn/verify`. The token is an opaque, Keycloak-signed JWT; the
  fixture signature is not verifiable and the client never inspects it. Its
  claims carry the K3e audience set `["sky-account","core"]`, the one core
  introspects when account deletion presents the token as `X-Sky-Sudo`.
- `sky-account-v1-sudo-authentication.json`: `POST sudo/authentication`, the
  grant a fresh Keycloak login (Microsoft) earns for a person with no
  password, verification app or passkey. Same shape as the other grants, but
  the window starts at the login (`expiresAt = auth_time + 300`) and the token
  carries `amr: ["idp"]`. The request body (`{ idToken }`) is never pinned as
  a fixture: the ID token is session material the BFF holds only for the call.
- `sky-account-v1-webauthn-assertion-options.json`: `POST sudo/webauthn/options`,
  relayed unchanged to the browser for `navigator.credentials.get()`.
- `sky-account-v1-webauthn-assertion.json`: the body the BFF forwards to
  `POST sudo/webauthn/verify` (base64url members, `id == rawId`; the
  `clientDataJSON` decodes to a `webauthn.get` document for the options
  fixture's challenge). It carries exactly the sudo contract's members:
  `authenticatorAttachment` belongs to the registration body only and client
  extension results are never forwarded. The signature bytes are synthetic;
  only the shape is pinned.
- `sky-account-v1-webauthn-registration-options.json`: `POST credentials/webauthn/options`,
  relayed unchanged to the browser for `navigator.credentials.create()`
  (`user.id` is `base64url(userId)`, `excludeCredentials` lists the person's
  existing passkeys).
- `sky-account-v1-webauthn-attestation.json`: the `PublicKeyCredential` JSON the
  browser produces for the creation ceremony (base64url members, `id == rawId`;
  the `clientDataJSON` decodes to a `webauthn.create` document for the options
  fixture's challenge). The BFF forwards `id`, `rawId`, `type`, `response`
  (`clientDataJSON`, `attestationObject`, `transports`) and
  `authenticatorAttachment` plus the label; `clientExtensionResults` is never
  forwarded. The attestation bytes are synthetic; only the shape is pinned.
- `sky-account-v1-passkey-credential.json`: `201` body of
  `POST credentials/webauthn/register` (with `transports`).
- `sky-account-v1-totp-setup.json`: `POST credentials/totp/setup`.
- `sky-account-v1-totp-credential.json`: `201` body of `POST credentials/totp/confirm`.
- `sky-account-v1-problems.json`: one `application/problem+json` body per
  documented `code`, with the pinned HTTP status (`webauthn_invalid` and
  `webauthn_origin_not_allowed` are pinned in their sudo form, `401`; the
  registration form answers `400` and the client accepts both).
  `invalid_email_code` carries `attemptsLeft` (`0`: the code is dead and a
  new one must be requested).

`POST credentials/password` and `DELETE credentials/{id}` answer `204` without
a body. The client rejects unknown fields, unknown problem codes and any
status that disagrees with the pinned table. These fixtures do not replace the
integration harness of the Keycloak repository; the same responses must be
captured against the real extension before the cutover.
