CREATE TABLE IF NOT EXISTS account_action_results (
  result_hash bytea PRIMARY KEY CHECK (octet_length(result_hash) = 32),
  session_id uuid NOT NULL REFERENCES account_sessions(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (
    action IN ('password', 'otp', 'passkey', 'delete-credential')
  ),
  outcome text NOT NULL CHECK (
    outcome IN ('success', 'cancelled', 'error', 'unverified')
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS account_action_results_active_idx
  ON account_action_results (session_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS account_action_results_expiry_idx
  ON account_action_results (expires_at);
