CREATE TABLE IF NOT EXISTS account_native_handoffs (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  keycloak_sid text NOT NULL CHECK (char_length(keycloak_sid) BETWEEN 1 AND 255),
  authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (authenticated_at <= created_at + interval '5 seconds')
);

CREATE INDEX IF NOT EXISTS account_native_handoffs_expiry_idx
  ON account_native_handoffs (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS account_native_handoffs_consumed_idx
  ON account_native_handoffs (consumed_at)
  WHERE consumed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_native_bridges (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  keycloak_sid text NOT NULL CHECK (char_length(keycloak_sid) BETWEEN 1 AND 255),
  authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (authenticated_at <= created_at + interval '5 seconds')
);

CREATE INDEX IF NOT EXISTS account_native_bridges_expiry_idx
  ON account_native_bridges (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS account_native_bridges_consumed_idx
  ON account_native_bridges (consumed_at)
  WHERE consumed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_native_bridge_request_nonces (
  nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash) = 32),
  seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > seen_at)
);

CREATE INDEX IF NOT EXISTS account_native_bridge_request_nonces_expiry_idx
  ON account_native_bridge_request_nonces (expires_at);
