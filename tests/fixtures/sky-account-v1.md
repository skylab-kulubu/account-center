# sky-account API v1 fixture contract

These JSON documents pin the sky-account Keycloak extension responses that
Account Center consumes, as specified in `docs/sky-account-api.md` (v1):

- `sky-account-v1-identity.json`: `GET identity`, also the body of
  `PATCH identity/name` and `POST identity/username`.
- `sky-account-v1-sudo-grant.json`: `POST sudo/password` and `POST sudo/totp`.
  The token is an opaque, Keycloak-signed JWT; the fixture signature is not
  verifiable and the client never inspects it.
- `sky-account-v1-totp-setup.json`: `POST credentials/totp/setup`.
- `sky-account-v1-totp-credential.json`: `201` body of `POST credentials/totp/confirm`.
- `sky-account-v1-problems.json`: one `application/problem+json` body per
  documented `code`, with the pinned HTTP status.

`POST credentials/password` and `DELETE credentials/{id}` answer `204` without
a body. The client rejects unknown fields, unknown problem codes and any
status that disagrees with the pinned table. These fixtures do not replace the
integration harness of the Keycloak repository; the same responses must be
captured against the real extension before the cutover.
