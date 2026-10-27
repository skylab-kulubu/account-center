import "server-only";

import { Pool } from "pg";
import { getAuthConfig } from "@/server/auth/config";
import { databasePoolMax } from "@/server/db/pool-size";

const globalPool = globalThis as typeof globalThis & {
  accountCenterPool?: Pool;
  accountCenterReadinessPool?: Pool;
};

export function getDatabasePool() {
  if (!globalPool.accountCenterPool) {
    globalPool.accountCenterPool = new Pool({
      connectionString: getAuthConfig().databaseUrl,
      max: databasePoolMax(process.env.DATABASE_POOL_MAX),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      maxLifetimeSeconds: 300,
    });
  }
  return globalPool.accountCenterPool;
}

/**
 * Readiness's own single connection (/api/ready, the container health check). A request pool
 * whose connections are all busy is a slow moment, not a broken task: on the shared pool the
 * health check would wait its 3 s out behind requests and Swarm would restart the task under
 * load. One connection per task, kept open; the query gives up after 2 s.
 */
export function getReadinessPool() {
  if (!globalPool.accountCenterReadinessPool) {
    globalPool.accountCenterReadinessPool = new Pool({
      connectionString: getAuthConfig().databaseUrl,
      max: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
      maxLifetimeSeconds: 24 * 60 * 60,
    });
  }
  return globalPool.accountCenterReadinessPool;
}
