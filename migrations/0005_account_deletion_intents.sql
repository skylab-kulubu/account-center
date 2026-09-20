CREATE TABLE IF NOT EXISTS account_deletion_intents (
  id uuid PRIMARY KEY,
  subject_digest bytea UNIQUE CHECK (subject_digest IS NULL OR octet_length(subject_digest) = 32),
  session_id uuid,
  proof_hash bytea UNIQUE CHECK (proof_hash IS NULL OR octet_length(proof_hash) = 32),
  local_receipt_hash bytea UNIQUE CHECK (local_receipt_hash IS NULL OR octet_length(local_receipt_hash) = 32),
  core_receipt_hash bytea UNIQUE CHECK (core_receipt_hash IS NULL OR octet_length(core_receipt_hash) = 32),
  recovery_kind text CHECK (recovery_kind IS NULL OR recovery_kind IN ('identity_tokens', 'core_receipt')),
  recovery_ciphertext text,
  status text NOT NULL CHECK (
    status IN ('awaiting_confirmation', 'blocking', 'pending', 'processing', 'completed', 'manual_intervention')
  ),
  partial boolean NOT NULL DEFAULT false,
  requested_at timestamptz,
  completed_at timestamptz,
  receipt_expires_at timestamptz,
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (fresh_until > created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND partial = false)
      OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CHECK (
    (
      status = 'awaiting_confirmation'
      AND subject_digest IS NOT NULL
      AND session_id IS NOT NULL
      AND proof_hash IS NOT NULL
      AND local_receipt_hash IS NOT NULL
      AND core_receipt_hash IS NULL
      AND recovery_kind IS NOT DISTINCT FROM 'identity_tokens'
      AND recovery_ciphertext IS NOT NULL
      AND partial = false
      AND requested_at IS NULL
      AND receipt_expires_at IS NULL
    )
    OR (
      status <> 'awaiting_confirmation'
      AND subject_digest IS NULL
      AND session_id IS NULL
      AND proof_hash IS NULL
      AND core_receipt_hash IS NOT NULL
      AND requested_at IS NOT NULL
      AND receipt_expires_at IS NOT NULL
      AND (
        (
          local_receipt_hash IS NOT NULL
          AND recovery_kind IS NOT DISTINCT FROM 'core_receipt'
          AND recovery_ciphertext IS NOT NULL
        )
        OR (
          local_receipt_hash IS NULL
          AND recovery_kind IS NULL
          AND recovery_ciphertext IS NULL
        )
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS account_deletion_intents_receipt_expiry_idx
  ON account_deletion_intents (receipt_expires_at)
  WHERE core_receipt_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS account_deletion_intents_fresh_expiry_idx
  ON account_deletion_intents (fresh_until)
  WHERE status = 'awaiting_confirmation';

DO $fingerprint$
DECLARE
  relation_oid regclass := to_regclass(format('%I.account_deletion_intents', current_schema()));
  actual_columns text[];
  actual_constraints text[];
  actual_indexes text[];
  expected_columns constant text[] := ARRAY[
    '1|id|uuid|t|',
    '2|subject_digest|bytea|f|',
    '3|session_id|uuid|f|',
    '4|proof_hash|bytea|f|',
    '5|local_receipt_hash|bytea|f|',
    '6|core_receipt_hash|bytea|f|',
    '7|recovery_kind|text|f|',
    '8|recovery_ciphertext|text|f|',
    '9|status|text|t|',
    '10|partial|boolean|t|false',
    '11|requested_at|timestamp with time zone|f|',
    '12|completed_at|timestamp with time zone|f|',
    '13|receipt_expires_at|timestamp with time zone|f|',
    '14|fresh_until|timestamp with time zone|t|',
    '15|created_at|timestamp with time zone|t|',
    '16|updated_at|timestamp with time zone|t|'
  ];
  expected_constraints constant text[] := ARRAY[
    $check$c|CHECK (core_receipt_hash IS NULL OR octet_length(core_receipt_hash) = 32)$check$,
    $check$c|CHECK (fresh_until > created_at)$check$,
    $check$c|CHECK (local_receipt_hash IS NULL OR octet_length(local_receipt_hash) = 32)$check$,
    $check$c|CHECK (proof_hash IS NULL OR octet_length(proof_hash) = 32)$check$,
    $check$c|CHECK (recovery_kind IS NULL OR (recovery_kind = ANY (ARRAY['identity_tokens'::text, 'core_receipt'::text])))$check$,
    $check$c|CHECK (status = 'awaiting_confirmation'::text AND subject_digest IS NOT NULL AND session_id IS NOT NULL AND proof_hash IS NOT NULL AND local_receipt_hash IS NOT NULL AND core_receipt_hash IS NULL AND NOT recovery_kind IS DISTINCT FROM 'identity_tokens'::text AND recovery_ciphertext IS NOT NULL AND partial = false AND requested_at IS NULL AND receipt_expires_at IS NULL OR status <> 'awaiting_confirmation'::text AND subject_digest IS NULL AND session_id IS NULL AND proof_hash IS NULL AND core_receipt_hash IS NOT NULL AND requested_at IS NOT NULL AND receipt_expires_at IS NOT NULL AND (local_receipt_hash IS NOT NULL AND NOT recovery_kind IS DISTINCT FROM 'core_receipt'::text AND recovery_ciphertext IS NOT NULL OR local_receipt_hash IS NULL AND recovery_kind IS NULL AND recovery_ciphertext IS NULL))$check$,
    $check$c|CHECK (status = 'completed'::text AND completed_at IS NOT NULL AND partial = false OR status <> 'completed'::text AND completed_at IS NULL)$check$,
    $check$c|CHECK (status = ANY (ARRAY['awaiting_confirmation'::text, 'blocking'::text, 'pending'::text, 'processing'::text, 'completed'::text, 'manual_intervention'::text]))$check$,
    $check$c|CHECK (subject_digest IS NULL OR octet_length(subject_digest) = 32)$check$,
    $check$c|CHECK (updated_at >= created_at)$check$,
    'p|PRIMARY KEY (id)',
    'u|UNIQUE (core_receipt_hash)',
    'u|UNIQUE (local_receipt_hash)',
    'u|UNIQUE (proof_hash)',
    'u|UNIQUE (subject_digest)'
  ];
  expected_indexes constant text[] := ARRAY[
    $index$f|f|btree|1|1|fresh_until|(status = 'awaiting_confirmation'::text)$index$,
    $index$f|f|btree|1|1|receipt_expires_at|(core_receipt_hash IS NOT NULL)$index$,
    'f|t|btree|1|1|core_receipt_hash|',
    'f|t|btree|1|1|local_receipt_hash|',
    'f|t|btree|1|1|proof_hash|',
    'f|t|btree|1|1|subject_digest|',
    't|t|btree|1|1|id|'
  ];
BEGIN
  SELECT array_agg(
      concat_ws(
        '|',
        attribute.attnum,
        attribute.attname,
        format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull,
        coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '')
      )
      ORDER BY attribute.attnum
    )
    INTO actual_columns
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
   WHERE attribute.attrelid = relation_oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;

  SELECT array_agg(
      constraint_value.contype::text || '|' || pg_get_constraintdef(constraint_value.oid, true)
      ORDER BY constraint_value.contype::text || '|' || pg_get_constraintdef(constraint_value.oid, true)
    )
    INTO actual_constraints
    FROM pg_constraint AS constraint_value
   WHERE constraint_value.conrelid = relation_oid;

  SELECT array_agg(index_fingerprint.signature ORDER BY index_fingerprint.signature)
    INTO actual_indexes
    FROM (
      SELECT concat_ws(
          '|',
          index_value.indisprimary,
          index_value.indisunique,
          access_method.amname,
          index_value.indnkeyatts,
          index_value.indnatts,
          (
            SELECT string_agg(attribute.attname, ',' ORDER BY key_value.ordinality)
              FROM unnest(index_value.indkey) WITH ORDINALITY AS key_value(attnum, ordinality)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_value.indrelid
               AND attribute.attnum = key_value.attnum
             WHERE key_value.ordinality <= index_value.indnkeyatts
          ),
          coalesce(pg_get_expr(index_value.indpred, index_value.indrelid), '')
        ) AS signature
        FROM pg_index AS index_value
        JOIN pg_class AS index_relation ON index_relation.oid = index_value.indexrelid
        JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
       WHERE index_value.indrelid = relation_oid
         AND index_value.indisvalid
         AND index_value.indisready
    ) AS index_fingerprint;

  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'account_deletion_intents has an unexpected column fingerprint';
  END IF;
  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION 'account_deletion_intents has an unexpected constraint fingerprint';
  END IF;
  IF actual_indexes IS DISTINCT FROM expected_indexes THEN
    RAISE EXCEPTION 'account_deletion_intents has an unexpected index fingerprint';
  END IF;
END
$fingerprint$;
