import "server-only";

import { Pool } from "pg";
import { getAuthConfig } from "@/server/auth/config";

const globalPool = globalThis as typeof globalThis & { accountCenterPool?: Pool };

export function getDatabasePool() {
  if (!globalPool.accountCenterPool) {
    globalPool.accountCenterPool = new Pool({
      connectionString: getAuthConfig().databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      maxLifetimeSeconds: 300,
    });
  }
  return globalPool.accountCenterPool;
}
