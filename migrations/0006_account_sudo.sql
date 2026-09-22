ALTER TABLE account_sessions
  ADD COLUMN IF NOT EXISTS sudo_token_ciphertext text,
  ADD COLUMN IF NOT EXISTS sudo_expires_at timestamptz;

DO $sudo_constraints$
DECLARE
  relation_oid regclass := to_regclass(format('%I.account_sessions', current_schema()));
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = relation_oid
       AND conname = 'account_sessions_sudo_ciphertext_length_check'
  ) THEN
    ALTER TABLE account_sessions
      ADD CONSTRAINT account_sessions_sudo_ciphertext_length_check CHECK (
        sudo_token_ciphertext IS NULL
        OR (octet_length(sudo_token_ciphertext) >= 1 AND octet_length(sudo_token_ciphertext) <= 16384)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = relation_oid
       AND conname = 'account_sessions_sudo_pair_check'
  ) THEN
    ALTER TABLE account_sessions
      ADD CONSTRAINT account_sessions_sudo_pair_check CHECK (
        (sudo_token_ciphertext IS NULL) = (sudo_expires_at IS NULL)
      );
  END IF;
END
$sudo_constraints$;

CREATE INDEX IF NOT EXISTS account_sessions_sudo_expiry_idx
  ON account_sessions (sudo_expires_at)
  WHERE sudo_expires_at IS NOT NULL;

DO $fingerprint$
DECLARE
  relation_oid regclass := to_regclass(format('%I.account_sessions', current_schema()));
  actual_columns text[];
  actual_constraints text[];
  actual_indexes text[];
  expected_columns constant text[] := ARRAY[
    '1|id|uuid|t|',
    '2|subject|text|t|',
    '3|keycloak_sid|text|f|',
    '4|handle_hash|bytea|t|',
    '5|previous_handle_hash|bytea|f|',
    '6|previous_handle_expires_at|timestamp with time zone|f|',
    '7|token_ciphertext|text|t|',
    '8|created_at|timestamp with time zone|t|',
    '9|rotated_at|timestamp with time zone|t|',
    '10|last_seen_at|timestamp with time zone|t|',
    '11|idle_expires_at|timestamp with time zone|t|',
    '12|absolute_expires_at|timestamp with time zone|t|',
    '13|revoked_at|timestamp with time zone|f|',
    '14|sudo_token_ciphertext|text|f|',
    '15|sudo_expires_at|timestamp with time zone|f|'
  ];
  expected_constraints constant text[] := ARRAY[
    $check$c|CHECK ((sudo_token_ciphertext IS NULL) = (sudo_expires_at IS NULL))$check$,
    $check$c|CHECK (absolute_expires_at > created_at)$check$,
    $check$c|CHECK (idle_expires_at <= absolute_expires_at)$check$,
    $check$c|CHECK (octet_length(handle_hash) = 32)$check$,
    $check$c|CHECK (previous_handle_hash IS NULL OR octet_length(previous_handle_hash) = 32)$check$,
    $check$c|CHECK (sudo_token_ciphertext IS NULL OR octet_length(sudo_token_ciphertext) >= 1 AND octet_length(sudo_token_ciphertext) <= 16384)$check$,
    'p|PRIMARY KEY (id)',
    'u|UNIQUE (handle_hash)',
    'u|UNIQUE (previous_handle_hash)'
  ];
  expected_indexes constant text[] := ARRAY[
    $index$f|f|btree|1|1|keycloak_sid|((revoked_at IS NULL) AND (keycloak_sid IS NOT NULL))$index$,
    $index$f|f|btree|1|1|sudo_expires_at|(sudo_expires_at IS NOT NULL)$index$,
    $index$f|f|btree|2|2|subject,absolute_expires_at|(revoked_at IS NULL)$index$,
    'f|t|btree|1|1|handle_hash|',
    'f|t|btree|1|1|previous_handle_hash|',
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
   WHERE constraint_value.conrelid = relation_oid
     -- PostgreSQL 18 exposes NOT NULL constraints in pg_constraint as
     -- contype = 'n'. Their semantics are already covered by the column
     -- fingerprint above, while PostgreSQL 17 does not return these rows.
     AND constraint_value.contype <> 'n';

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
    RAISE EXCEPTION 'account_sessions has an unexpected column fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_constraints) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_constraints) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_sessions has an unexpected constraint fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_indexes) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_indexes) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_sessions has an unexpected index fingerprint';
  END IF;
END
$fingerprint$;
