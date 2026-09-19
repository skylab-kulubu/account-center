CREATE TABLE IF NOT EXISTS account_oidc_transactions (
  id uuid PRIMARY KEY,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
  payload_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_oidc_transactions_expiry_idx
  ON account_oidc_transactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS account_oidc_transactions_binding_idx
  ON account_oidc_transactions (state_hash, browser_binding_hash)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS account_sessions (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  keycloak_sid text,
  handle_hash bytea NOT NULL UNIQUE CHECK (octet_length(handle_hash) = 32),
  previous_handle_hash bytea UNIQUE CHECK (
    previous_handle_hash IS NULL OR octet_length(previous_handle_hash) = 32
  ),
  previous_handle_expires_at timestamptz,
  token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL,
  rotated_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_sessions_subject_active_idx
  ON account_sessions (subject, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS account_sessions_keycloak_sid_active_idx
  ON account_sessions (keycloak_sid)
  WHERE revoked_at IS NULL AND keycloak_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_center_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
