import "server-only";

import Redis from "ioredis";
import type { AccountAccessGateConfig } from "@/server/access-gate/config";
import {
  ACCOUNT_ACCESS_CONTRACT_KEY,
  ACCOUNT_ACCESS_CONTRACT_VALUE,
  ACCOUNT_ACCESS_ISSUER,
  ACCOUNT_ACCESS_MARKER_VALUE,
  accountAccessMarkerKey,
} from "@/server/access-gate/contract";

export type AccountAccessDecision = "active" | "blocked" | "unavailable";

export interface AccountAccessGate {
  decide(subject: string): Promise<AccountAccessDecision>;
  ready(): Promise<boolean>;
}

type RedisReads = {
  mget(...keys: string[]): Promise<Array<string | null>>;
  get(key: string): Promise<string | null>;
};

export class RedisAccountAccessGate implements AccountAccessGate {
  constructor(
    private readonly redis: RedisReads,
    private readonly issuer: string = ACCOUNT_ACCESS_ISSUER,
  ) {}

  async decide(subject: string): Promise<AccountAccessDecision> {
    try {
      const [contract, marker] = await this.redis.mget(
        ACCOUNT_ACCESS_CONTRACT_KEY,
        accountAccessMarkerKey(this.issuer, subject),
      );
      if (contract !== ACCOUNT_ACCESS_CONTRACT_VALUE) return "unavailable";
      if (marker === null) return "active";
      return marker === ACCOUNT_ACCESS_MARKER_VALUE ? "blocked" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async ready() {
    try {
      return await this.redis.get(ACCOUNT_ACCESS_CONTRACT_KEY) === ACCOUNT_ACCESS_CONTRACT_VALUE;
    } catch {
      return false;
    }
  }
}

class DisabledAccountAccessGate implements AccountAccessGate {
  async decide(): Promise<AccountAccessDecision> {
    return "active";
  }

  async ready() {
    return true;
  }
}

class BoundedRedisReads implements RedisReads {
  private connection?: Promise<void>;

  constructor(
    private readonly redis: Redis,
    private readonly timeoutMs: number,
  ) {}

  private async deadline<T>(operation: () => Promise<T>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Account access Redis deadline exceeded.")), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connected() {
    if (this.redis.status === "ready") return;
    this.connection ??= this.redis.connect().finally(() => {
      this.connection = undefined;
    });
    await this.connection;
  }

  mget(...keys: string[]) {
    return this.deadline(async () => {
      await this.connected();
      return this.redis.mget(...keys);
    });
  }

  get(key: string) {
    return this.deadline(async () => {
      await this.connected();
      return this.redis.get(key);
    });
  }
}

export function createAccountAccessGate(config: AccountAccessGateConfig): AccountAccessGate {
  if (config.mode === "off") return new DisabledAccountAccessGate();
  const redis = new Redis({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    db: config.database,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: config.operationTimeoutMs,
    commandTimeout: config.operationTimeoutMs,
    ...(config.tls
      ? {
          tls: {
            servername: config.tlsServerName,
            ...(config.tlsCa ? { ca: config.tlsCa } : {}),
            ...(config.tlsCert ? { cert: config.tlsCert } : {}),
            ...(config.tlsKey ? { key: config.tlsKey } : {}),
          },
        }
      : {}),
  });
  redis.on("error", () => {
    // Decisions are returned as unavailable; never log connection material here.
  });
  return new RedisAccountAccessGate(
    new BoundedRedisReads(redis, config.operationTimeoutMs),
  );
}
