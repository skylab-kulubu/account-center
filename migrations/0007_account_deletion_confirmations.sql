-- A7d: the typed confirmation of an account deletion, recorded before core is
-- called. `GET /api/account/deletion/status` may only send an intent to core
-- when a confirmation exists for that intent under its current proof. The
-- confirmation lives beside the intent, not on it, so the intent table (and
-- 0005's fingerprint of it) is unchanged and an older build keeps working:
-- it never reads this table. An intent sealed before this migration has no
-- confirmation and is treated as unconfirmed (fail closed). Binding the row
-- to `proof_hash` makes any re-authentication, by any build, void it.
CREATE TABLE IF NOT EXISTS account_deletion_confirmations (
  intent_id uuid PRIMARY KEY REFERENCES account_deletion_intents (id) ON DELETE CASCADE,
  proof_hash bytea NOT NULL CHECK (octet_length(proof_hash) = 32),
  confirmed_at timestamptz NOT NULL
);

DO $fingerprint$
DECLARE
  relation_oid regclass := to_regclass(format('%I.account_deletion_confirmations', current_schema()));
  actual_columns text[];
  actual_constraints text[];
  actual_indexes text[];
  expected_columns constant text[] := ARRAY[
    '1|intent_id|uuid|t|',
    '2|proof_hash|bytea|t|',
    '3|confirmed_at|timestamp with time zone|t|'
  ];
  expected_constraints constant text[] := ARRAY[
    $check$c|CHECK (octet_length(proof_hash) = 32)$check$,
    'f|FOREIGN KEY (intent_id) REFERENCES account_deletion_intents(id) ON DELETE CASCADE',
    'p|PRIMARY KEY (intent_id)'
  ];
  expected_indexes constant text[] := ARRAY[
    't|t|btree|1|1|intent_id|'
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
    RAISE EXCEPTION 'account_deletion_confirmations has an unexpected column fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_constraints) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_constraints) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_deletion_confirmations has an unexpected constraint fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_indexes) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_indexes) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_deletion_confirmations has an unexpected index fingerprint';
  END IF;
END
$fingerprint$;
