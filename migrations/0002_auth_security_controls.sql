CREATE TABLE IF NOT EXISTS account_backchannel_logout_replays (
  jti_hash bytea PRIMARY KEY CHECK (octet_length(jti_hash) = 32),
  seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > seen_at)
);

CREATE INDEX IF NOT EXISTS account_backchannel_logout_replays_expiry_idx
  ON account_backchannel_logout_replays (expires_at);

CREATE TABLE IF NOT EXISTS account_auth_rate_limits (
  key_hash bytea PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS account_auth_rate_limits_expiry_idx
  ON account_auth_rate_limits (expires_at);
