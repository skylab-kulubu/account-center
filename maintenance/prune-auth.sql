WITH deleted_transactions AS (
  DELETE FROM account_oidc_transactions
   WHERE expires_at < now() - interval '1 hour'
      OR consumed_at < now() - interval '1 hour'
  RETURNING 1
),
deleted_sessions AS (
  DELETE FROM account_sessions
   WHERE revoked_at < now() - interval '24 hours'
      OR absolute_expires_at < now() - interval '24 hours'
      OR idle_expires_at < now() - interval '24 hours'
  RETURNING 1
),
deleted_logout_replays AS (
  DELETE FROM account_backchannel_logout_replays
   WHERE expires_at < now()
  RETURNING 1
),
deleted_rate_limits AS (
  DELETE FROM account_auth_rate_limits
   WHERE expires_at < now()
  RETURNING 1
)
SELECT
  (SELECT count(*)::integer FROM deleted_transactions) AS deleted_transactions,
  (SELECT count(*)::integer FROM deleted_sessions) AS deleted_sessions,
  (SELECT count(*)::integer FROM deleted_logout_replays) AS deleted_logout_replays,
  (SELECT count(*)::integer FROM deleted_rate_limits) AS deleted_rate_limits;
