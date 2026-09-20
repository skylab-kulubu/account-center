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
),
deleted_native_handoffs AS (
  DELETE FROM account_native_handoffs
   WHERE expires_at < now() - interval '1 hour'
      OR consumed_at < now() - interval '1 hour'
  RETURNING 1
),
deleted_native_bridges AS (
  DELETE FROM account_native_bridges
   WHERE expires_at < now() - interval '1 hour'
      OR consumed_at < now() - interval '1 hour'
  RETURNING 1
),
deleted_native_bridge_nonces AS (
  DELETE FROM account_native_bridge_request_nonces
   WHERE expires_at < now()
  RETURNING 1
),
deleted_action_results AS (
  DELETE FROM account_action_results
   WHERE expires_at < now()
      OR consumed_at < now() - interval '1 hour'
  RETURNING 1
),
deleted_deletion_intents AS (
  DELETE FROM account_deletion_intents
   WHERE (status = 'awaiting_confirmation' AND fresh_until <= now())
      OR (core_receipt_hash IS NOT NULL AND receipt_expires_at <= now())
  RETURNING 1
),
scrubbed_deletion_recovery AS (
  UPDATE account_deletion_intents
     SET local_receipt_hash = NULL,
         recovery_kind = NULL,
         recovery_ciphertext = NULL
   WHERE status <> 'awaiting_confirmation'
     AND fresh_until <= now()
     AND receipt_expires_at > now()
     AND (
       local_receipt_hash IS NOT NULL
       OR recovery_kind IS NOT NULL
       OR recovery_ciphertext IS NOT NULL
     )
  RETURNING 1
)
SELECT
  (SELECT count(*)::integer FROM deleted_transactions) AS deleted_transactions,
  (SELECT count(*)::integer FROM deleted_sessions) AS deleted_sessions,
  (SELECT count(*)::integer FROM deleted_logout_replays) AS deleted_logout_replays,
  (SELECT count(*)::integer FROM deleted_rate_limits) AS deleted_rate_limits,
  (SELECT count(*)::integer FROM deleted_native_handoffs) AS deleted_native_handoffs,
  (SELECT count(*)::integer FROM deleted_native_bridges) AS deleted_native_bridges,
  (SELECT count(*)::integer FROM deleted_native_bridge_nonces) AS deleted_native_bridge_nonces,
  (SELECT count(*)::integer FROM deleted_action_results) AS deleted_action_results,
  (SELECT count(*)::integer FROM deleted_deletion_intents) AS deleted_deletion_intents,
  (SELECT count(*)::integer FROM scrubbed_deletion_recovery) AS scrubbed_deletion_recovery;
