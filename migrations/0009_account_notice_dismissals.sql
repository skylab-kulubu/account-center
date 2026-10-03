-- K4c: the e-mail nudges a person dismissed for good ("Bir daha gösterme"),
-- so a dismissal follows the person to every device. One row per person and
-- nudge; the person is never stored by name or Keycloak subject, only by an
-- HMAC of the subject (`hmacSha256(SESSION_SECRET, "notice-dismissal-subject",
-- sub)`), like account_deletion_intents. maintenance/prune-auth.sql deletes a
-- row twelve months after the dismissal. The person's rows are also deleted
-- when they confirm an account deletion: best effort, before core is called,
-- and only where the deletion flow runs (ACCOUNT_ERASURE_MODE=enforce).
-- Rotating SESSION_SECRET orphans the rows until that prune; every nudge
-- shows again.
-- Additive: an older build never reads this table.
CREATE TABLE IF NOT EXISTS account_notice_dismissals (
  subject_digest bytea NOT NULL CHECK (octet_length(subject_digest) = 32),
  notice text NOT NULL CHECK (notice IN ('make-personal-primary', 'add-personal')),
  dismissed_at timestamptz NOT NULL,
  PRIMARY KEY (subject_digest, notice)
);

DO $fingerprint$
DECLARE
  relation_oid regclass := to_regclass(format('%I.account_notice_dismissals', current_schema()));
  actual_columns text[];
  actual_constraints text[];
  actual_indexes text[];
  expected_columns constant text[] := ARRAY[
    '1|subject_digest|bytea|t|',
    '2|notice|text|t|',
    '3|dismissed_at|timestamp with time zone|t|'
  ];
  expected_constraints constant text[] := ARRAY[
    $check$c|CHECK (notice = ANY (ARRAY['make-personal-primary'::text, 'add-personal'::text]))$check$,
    $check$c|CHECK (octet_length(subject_digest) = 32)$check$,
    'p|PRIMARY KEY (subject_digest, notice)'
  ];
  expected_indexes constant text[] := ARRAY[
    't|t|btree|2|2|subject_digest,notice|'
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
    RAISE EXCEPTION 'account_notice_dismissals has an unexpected column fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_constraints) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_constraints) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_notice_dismissals has an unexpected constraint fingerprint';
  END IF;
  IF (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(actual_indexes) AS fingerprint(signature)
  ) IS DISTINCT FROM (
    SELECT array_agg(signature ORDER BY signature COLLATE "C")
      FROM unnest(expected_indexes) AS fingerprint(signature)
  ) THEN
    RAISE EXCEPTION 'account_notice_dismissals has an unexpected index fingerprint';
  END IF;
END
$fingerprint$;
