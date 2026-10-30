import { NextResponse } from "next/server";
import { getAuthServices } from "@/server/auth/services";
import { getReadinessPool } from "@/server/db/pool";

export const dynamic = "force-dynamic";

/**
 * The deploy gate: configuration, schema and, in enforce mode, the access-gate contract.
 * `?gate=skip` (the image's HEALTHCHECK) leaves the access gate out: Swarm restarts an
 * unhealthy task, and a Redis outage would restart every task at once while doing nothing
 * for it (core-backend's /v1/ready?gate=skip makes the same split). The skip holds only after
 * this process has once seen the gate ready: a new task that never reached Redis (a wrong
 * address, ACL or contract) stays unhealthy, and the deploy keeps the old one, as core does
 * by not listening until it reached the gate.
 */
let gateSeenReady = false;

export async function GET(request: Request) {
  const checkGate = !gateSeenReady || new URL(request.url).searchParams.get("gate") !== "skip";
  try {
    const services = getAuthServices();
    if (!await schemaReady() || (checkGate && !await gateReady(services.accountAccess))) {
      return NextResponse.json(
        { status: "not_ready", service: "account-center" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { status: "ready", service: "account-center" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "not_ready", service: "account-center" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * The route is public and readiness has one connection per task. Callers arriving while the
 * schema query runs take its answer instead of queueing for the connection, and an answer
 * (a failure too) is reused for a second, so however often the route is asked PostgreSQL is
 * read at most once a second (core-backend's readiness does the same).
 */
const SCHEMA_ANSWER_MAX_AGE_MS = 1_000;
let schemaAnswer: { ready: boolean; at: number } | undefined;
let schemaInFlight: Promise<boolean> | undefined;

function schemaReady(): Promise<boolean> {
  if (schemaAnswer && Date.now() - schemaAnswer.at < SCHEMA_ANSWER_MAX_AGE_MS) {
    return Promise.resolve(schemaAnswer.ready);
  }
  schemaInFlight ??= readSchema()
    .catch(() => false)
    .then((ready) => {
      // The age counts from the answer, so a slow query still answers the callers after it.
      schemaAnswer = { ready, at: Date.now() };
      schemaInFlight = undefined;
      return ready;
    });
  return schemaInFlight;
}

async function readSchema() {
  const result = await getReadinessPool().query<{
    sessions_ready: boolean;
    controls_ready: boolean;
    actions_ready: boolean;
    deletion_ready: boolean;
    sudo_ready: boolean;
    rotation_ready: boolean;
    notices_ready: boolean;
    migrations_ready: boolean;
  }>(
    `SELECT
       to_regclass('public.account_sessions') IS NOT NULL AS sessions_ready,
       to_regclass('public.account_backchannel_logout_replays') IS NOT NULL
         AND to_regclass('public.account_auth_rate_limits') IS NOT NULL AS controls_ready,
       to_regclass('public.account_action_results') IS NOT NULL AS actions_ready,
       to_regclass('public.account_deletion_intents') IS NOT NULL
         AND to_regclass('public.account_deletion_confirmations') IS NOT NULL AS deletion_ready,
       (SELECT count(*) = 2
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'account_sessions'
           AND ((column_name = 'sudo_token_ciphertext' AND data_type = 'text')
             OR (column_name = 'sudo_expires_at' AND data_type = 'timestamp with time zone'))) AS sudo_ready,
       EXISTS (SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'account_sessions'
           AND column_name = 'rotation_salt'
           AND data_type = 'bytea') AS rotation_ready,
       to_regclass('public.account_notice_dismissals') IS NOT NULL AS notices_ready,
       (SELECT count(*) = 9
          FROM account_center_schema_migrations
         WHERE name = ANY($1::text[])) AS migrations_ready`,
    // 0008_drop_native_handoff.sql is intentionally not required: it runs after this code is live.
    [[
      "0001_bff_web_sessions.sql",
      "0002_auth_security_controls.sql",
      "0003_native_handoff.sql",
      "0004_account_action_results.sql",
      "0005_account_deletion_intents.sql",
      "0006_account_sudo.sql",
      "0007_account_deletion_confirmations.sql",
      "0009_account_notice_dismissals.sql",
      "0010_account_session_rotation_salt.sql",
    ]],
  );
  const row = result.rows[0];
  return Boolean(
    row?.sessions_ready &&
    row.controls_ready &&
    row.actions_ready &&
    row.deletion_ready &&
    row.sudo_ready &&
    row.rotation_ready &&
    row.notices_ready &&
    row.migrations_ready,
  );
}

async function gateReady(gate: { ready(): Promise<boolean> }) {
  const ready = await gate.ready();
  if (ready) gateSeenReady = true;
  return ready;
}
