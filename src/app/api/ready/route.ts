import { NextResponse } from "next/server";
import { getAuthConfig } from "@/server/auth/config";
import { getDatabasePool } from "@/server/db/pool";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    getAuthConfig();
    const result = await getDatabasePool().query<{
      sessions_ready: boolean;
      controls_ready: boolean;
      native_ready: boolean;
      migrations_ready: boolean;
    }>(
      `SELECT
         to_regclass('public.account_sessions') IS NOT NULL AS sessions_ready,
         to_regclass('public.account_backchannel_logout_replays') IS NOT NULL
           AND to_regclass('public.account_auth_rate_limits') IS NOT NULL AS controls_ready,
         to_regclass('public.account_native_handoffs') IS NOT NULL
           AND to_regclass('public.account_native_bridges') IS NOT NULL
           AND to_regclass('public.account_native_bridge_request_nonces') IS NOT NULL AS native_ready,
         (SELECT count(*) = 3
            FROM account_center_schema_migrations
           WHERE name = ANY($1::text[])) AS migrations_ready`,
      [["0001_bff_web_sessions.sql", "0002_auth_security_controls.sql", "0003_native_handoff.sql"]],
    );
    if (
      !result.rows[0]?.sessions_ready ||
      !result.rows[0]?.controls_ready ||
      !result.rows[0]?.native_ready ||
      !result.rows[0]?.migrations_ready
    ) {
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
