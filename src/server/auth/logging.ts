import "server-only";

import { randomUUID } from "node:crypto";
import type { OidcProviderStage } from "@/server/auth/oidc-protocol";

const sensitiveKey = /(?:authorization|cookie|token|secret|code|state|nonce|verifier|email|name|subject|sid|credential)/i;

export function requestCorrelationId(request: Request) {
  const value = request.headers.get("x-request-id");
  return value && /^[A-Za-z0-9._-]{8,128}$/.test(value) ? value : randomUUID();
}

export function redactAuthMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuthMaterial);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactAuthMaterial(child),
    ]),
  );
}

type AuthLog = {
  event:
    | "oidc_login_started"
    | "oidc_login_completed"
    | "oidc_login_failed"
    | "local_logout"
    | "backchannel_logout"
    | "native_handoff_created"
    | "native_handoff_consumed"
    | "native_bridge_redeemed"
    | "account_session_cleanup"
    | "security_action"
    | "identity_action"
    | "identity_name_core_sync_failed"
    | "sudo_material_discarded"
    | "sudo_attempt"
    | "sudo_reauthentication_started"
    | "sudo_reauthentication_completed"
    | "ytu_link_started"
    | "ytu_link_completed"
    | "token_audience_legacy";
  requestId: string;
  outcome: "success" | "failure";
  providerStage?: OidcProviderStage;
  /** Proof kind of a sudo attempt; never the material itself. */
  sudoMethod?: "password" | "totp" | "passkey" | "reauth";
  /** Which security-page action ran; never a label, secret, code, attestation or credential id. */
  securityAction?:
    | "password"
    | "totp_setup"
    | "totp_confirm"
    | "passkey_options"
    | "passkey_register"
    | "credential_delete";
  /** Which identity-page action ran; never a name or username. */
  identityAction?: "name" | "username";
  reason?:
    | "invalid_transaction"
    | "provider_unavailable"
    | "contract_blocked"
    | "invalid_csrf"
    | "invalid_logout_token"
    | "replayed_logout_token"
    | "deleted_token_decrypt_failed"
    | "upstream_revocation_failed"
    | "invalid_origin"
    | "invalid_token"
    | "invalid_handoff"
    | "invalid_bridge_request"
    | "rate_limited"
    | "local_session_revocation_failed"
    | "sudo_decrypt_failed"
    | "invalid_credentials"
    | "user_locked"
    | "method_unavailable"
    | "method_available"
    | "sudo_storage_failed"
    | "sudo_required"
    | "spi_token_required"
    | "sudo_rejected_upstream"
    | "policy_rejected"
    | "invalid_code"
    | "setup_expired"
    | "duplicate_label"
    | "already_registered"
    | "credential_not_found"
    | "webauthn_rejected"
    | "name_locked"
    | "invalid_name"
    | "invalid_username"
    | "username_taken"
    | "username_cooldown"
    | "core_disabled"
    | "core_rejected"
    | "already_linked"
    | "link_cancelled"
    | "link_failed"
    | "link_unverified";
};

export function logAuthEvent(entry: AuthLog) {
  const serialized = JSON.stringify(redactAuthMaterial(entry));
  if (entry.outcome === "failure") console.warn(serialized);
  else console.info(serialized);
}
