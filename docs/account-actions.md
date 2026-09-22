# Password, passkey and TOTP changes

Account Center changes a person's password, verification app (TOTP) and passkeys **inside `my.`**: the security page (`/security`) runs every step in the browser and the BFF forwards it to the sky-account Keycloak extension (`${OIDC_ISSUER}/sky-account/v1`, contract in [sky-account-api.md](sky-account-api.md)). Nothing on this page redirects to Keycloak, embeds the Account Console or requests a Keycloak application-initiated action; `kc_action` no longer exists in the code base. Every change requires a fresh Sudo mode proof ([architecture, "Sudo modu"](architecture.md#sudo-modu)) and is verified by re-reading the credential inventory, never by trusting the answer of a single call.

## Browser contract

All routes live under `/api/account/security`. The page reads the inventory with the session cookie only; every mutation is a same-origin JSON call that carries the session-bound CSRF proof in `x-csrf-token`, passes the account-access gate, and is refused with `428 sudo_required` until a proof with sky-account material is fresh.

| Route | Body | Success | sky-account call |
| --- | --- | --- | --- |
| `GET /api/account/security` | — | `{ password, totp[], passkeys[], sudo: { methods, fallback, active }, csrfToken }` | `GET identity` |
| `POST /api/account/security/password` | `{ newPassword, logoutOtherSessions }` (≤ 4 KB, password ≤ 1024 chars) | `204` | `POST credentials/password` |
| `POST /api/account/security/totp/setup` | — | `{ setupHandle, secret, otpauthUri, expiresAt, policy }` | `POST credentials/totp/setup` |
| `POST /api/account/security/totp/confirm` | `{ setupHandle, code, label }` (code 4–10 digits, spaces dropped; label normalised like the SPI — format characters dropped, spaces collapsed — then 1–64 characters) | `201 { credential }` | `POST credentials/totp/confirm` |
| `POST /api/account/security/passkeys/options` | — | `PublicKeyCredentialCreationOptions` JSON | `POST credentials/webauthn/options` |
| `POST /api/account/security/passkeys/register` | `{ attestation, label }` (≤ 64 KB; label normalised as above) | `201 { credential }` | `POST credentials/webauthn/register` |
| `DELETE /api/account/security/credentials/{reference}` | — | `204` | `DELETE credentials/{id}` |

Rows (`totp[]`, `passkeys[]`, `credential`) carry `reference`, `label`, `createdAt` and, for passkeys, `transports` and `legacy` (a two-factor `webauthn` credential that is not a passkey and can only be removed). `reference` is a session-bound HMAC of the Keycloak credential id (`SessionManager.credentialReference`): the browser never sees a credential id, and a reference can only be resolved by the same local session, which re-reads `GET identity` before deleting anything. A reference that names nothing of the person's answers `404 credential_not_found` without touching the SPI.

Order inside every mutation route: exact `Origin` → CSRF → access gate and session → Sudo mode gate → local per-session budget (`security_mutation` 30 / 15 min, `totp_confirm` 10 / 15 min, mirroring the SPI's own budgets) → body → SPI with `X-Sky-Sudo`. A rotated opaque session handle is written to every answer, including `428` and error answers; only an answer that ended the session (bearer rejected upstream) clears the cookie instead.

### Sudo mode and the `428` challenge

`requireAccountSpiSudo` (`src/server/auth/sudo-gate.ts`) returns the fresh proof or a ready `428 { error: "sudo_required", reason, methods, fallback }`:

- `reason: "missing" | "expired"`: the page calls `ensureSudo({ challenged: true })`, the dialog opens, and the same request is sent once more. A second `428` is shown as an error, never retried again.
- `reason: "spi_token_required"`: the person holds a fresh Microsoft re-authentication proof (`method: "reauth"`), which satisfies `my.`-local gates but carries no sky-account token, and the SPI insists on `X-Sky-Sudo`. Such a person has no password, passkey or verification app to prove with, so the page explains that the change is not possible yet instead of reopening the dialog. K3d closes the gap with a Keycloak endpoint that issues a sudo token from the re-authenticated bearer; until it ships, this is the documented dead end for an account without any in-product method.

When the SPI itself rejects the stored proof (`401 sudo_required` / `sudo_expired`), the route discards the local copy (`SudoVault.clearSudo`) and answers the same `428` challenge with `reason: "expired"`.

### Error mapping

Every other failure answers `{ error, detail, retryAfter?, policy?, params? }` with the SPI's Turkish `detail` where one exists: `password_policy` → `400 password_policy` (+ `policy`, `params`), `password_rejected` → `400`, `invalid_totp_code` → `400 invalid_code`, `totp_setup_expired` → `400 setup_expired`, `duplicate_label` → `409`, `passkey_already_registered` → `409`, `webauthn_invalid` / `webauthn_origin_not_allowed` → `400`, `webauthn_challenge_expired` → `400 challenge_expired`, `credential_not_found` → `404`, `rate_limited` → `429` + `Retry-After`, `user_temporarily_locked` → `423 locked`, `user_disabled` → `403 disabled`, `webauthn_not_configured` / `unmanaged_attributes_enabled` → `503 unavailable`, an unreachable SPI → `503` + `Retry-After: 3`, a response outside the pinned contract → `502 upstream_error`, a rejected bearer → `401` with the local session revoked. Malformed bodies answer `400 invalid_request` (`413` when too large) before anything is sent upstream.

## The page

- **Parola**: "Parolayı değiştir" (or "Parola belirle" when `password` is `false`) asks for Sudo mode first, then shows the form: new password, confirmation (checked locally), and "Diğer cihazlardaki oturumları kapat" (checked by default). A realm policy rejection is rendered from the server's `detail`; the static hints (at least 8 characters, not the username or e-mail) stay visible. The password is posted once and never kept.
- **Doğrulama uygulaması**: Sudo mode → `totp/setup` → the QR is drawn **in the browser** from `otpauthUri` (`src/lib/qr.ts`, a dependency-free ISO/IEC 18004 byte-mode encoder verified by a test-side decoder and published Reed–Solomon and format vectors) next to the manual key in groups of four → label and code → `totp/confirm`. A wrong code keeps the setup handle for another attempt; an expired setup offers "Baştan başla"; a duplicate label is refused inline. Removal opens a confirmation dialog.
- **Passkey'ler**: rows show the label, the registration date and the transports the browser reported. "Passkey ekle" asks for a label, then Sudo mode, relays the creation options from the SPI, runs `navigator.credentials.create()` on `my.` (`src/lib/webauthn.ts`, no third-party library; the RP ID comes from the realm passwordless policy, `yildizskylab.com`), and registers the serialized attestation with the label. Client extension results are never sent. A browser without `PublicKeyCredential` sees an explanation instead of the button. Removing the last passkey of a person without a password shows a warning (the only remaining login is the YTÜ Microsoft account) but is not blocked.
- Every success re-reads `GET /api/account/security`: the list is the server's inventory, not the answer of the mutation.

No password, code, secret, attestation, sudo token, bearer token or credential id appears in a log line, an error message or a URL. Logs record only `security_action` events with the action kind (`password`, `totp_setup`, `totp_confirm`, `passkey_options`, `passkey_register`, `credential_delete`), the outcome and a fixed reason code.

## Rollback

The previous image (`main` before this change) still contains the application-initiated-action path (`POST /api/auth/action`, the `account-action` transaction kind, `kc_action` in PAR and the one-time `account_action_results` feedback). Rolling back is a deployment of that image; no configuration flag switches between the two models. The `account_action_results` table and migration `0004` stay in place so that image keeps working and the readiness probe keeps passing; the hourly prune job still empties the table. A later release drops the table once the previous image is no longer a rollback target.

## Release gates

Fixture and unit tests cannot prove the platform ceremonies. Production stays blocked until the integration harness of the Keycloak repository proves, with the reconciled realm and the source-controlled theme:

1. A password changed on `my.` signs in on `e.` and the realm password policy (`length(8) and notUsername and notEmail`) is reported through `password_policy`.
2. A verification app enrolled from the `my.` QR proves Sudo mode and passes the login OTP step.
3. A passkey registered on `my.` (RP ID `yildizskylab.com`, extra origin `https://my.yildizskylab.com`) signs in on `e.` and proves Sudo mode; `excludeCredentials` refuses a second registration of the same authenticator.
4. `DELETE credentials/{id}` refuses ids that are not the person's own and the page reflects the fresh inventory.
5. Desktop and mobile WebView runs cover the ceremonies, Turkish copy, keyboard and focus behaviour, reduced motion and contrast; no request leaves for `e.yildizskylab.com` during any flow.

## Upstream contract references

- [sky-account API v1](sky-account-api.md): `credentials/password`, `credentials/totp/setup|confirm`, `credentials/webauthn/options|register`, `DELETE credentials/{id}`, `X-Sky-Sudo`, RFC 7807 codes.
- [Keycloak 26.7.4 contract](keycloak-26.7.4-contract.md): the forced re-authentication (`prompt=login&max_age=0`) that remains for account deletion and the Sudo mode fallback.
