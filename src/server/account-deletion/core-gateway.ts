import "server-only";

import type {
  CoreAccountDeletionGateway,
  CoreAccountDeletionStatus,
} from "@/server/account-deletion/types";

const RECEIPT = /^adr_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{43}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const statuses = new Set(["blocking", "pending", "processing", "completed", "manual_intervention"]);
const terminalStatuses = new Set<CoreAccountDeletionStatus["status"]>([
  "completed",
  "manual_intervention",
]);
const statusResponseKeys = [
  "completedAt",
  "partial",
  "platformBlocked",
  "receiptExpiresAt",
  "requestedAt",
  "status",
  "updatedAt",
].sort();
const initiationResponseKeys = [...statusResponseKeys, "receipt"].sort();

export class CoreAccountDeletionUnavailableError extends Error {
  constructor() {
    super("Core account deletion is unavailable.");
    this.name = "CoreAccountDeletionUnavailableError";
  }
}

export class CoreAccountDeletionUnauthorizedError extends Error {
  constructor() {
    super("Core rejected the account deletion credential.");
    this.name = "CoreAccountDeletionUnauthorizedError";
  }
}

export class CoreAccountDeletionNotFoundError extends Error {
  constructor() {
    super("The account deletion receipt was not found.");
    this.name = "CoreAccountDeletionNotFoundError";
  }
}

export class CoreAccountDeletionConflictError extends Error {
  constructor() {
    super("Core rejected the account deletion idempotency key.");
    this.name = "CoreAccountDeletionConflictError";
  }
}

function date(value: unknown) {
  return typeof value === "string" && RFC3339_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function parseStatus(value: unknown, expectedReceipt?: string): CoreAccountDeletionStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreAccountDeletionUnavailableError();
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = expectedReceipt === undefined ? initiationResponseKeys : statusResponseKeys;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)) {
    throw new CoreAccountDeletionUnavailableError();
  }
  const receipt = expectedReceipt ?? record.receipt;
  if (
    typeof receipt !== "string" ||
    !RECEIPT.test(receipt) ||
    record.platformBlocked !== true ||
    typeof record.status !== "string" ||
    !statuses.has(record.status) ||
    typeof record.partial !== "boolean" ||
    !date(record.requestedAt) ||
    !date(record.updatedAt) ||
    !date(record.receiptExpiresAt) ||
    (record.completedAt !== null && !date(record.completedAt))
  ) {
    throw new CoreAccountDeletionUnavailableError();
  }
  const requestedAt = Date.parse(record.requestedAt as string);
  const updatedAt = Date.parse(record.updatedAt as string);
  const receiptExpiresAt = Date.parse(record.receiptExpiresAt as string);
  const completedAt = record.completedAt === null ? null : Date.parse(record.completedAt as string);
  if (
    updatedAt < requestedAt ||
    receiptExpiresAt <= updatedAt ||
    (record.status === "completed") !== (completedAt !== null) ||
    (completedAt !== null && (completedAt < requestedAt || completedAt > updatedAt)) ||
    (record.status === "completed" && record.partial)
  ) {
    throw new CoreAccountDeletionUnavailableError();
  }
  const base = {
    receipt,
    requestedAt: record.requestedAt as string,
    updatedAt: record.updatedAt as string,
    receiptExpiresAt: record.receiptExpiresAt as string,
  };
  if (record.status === "completed") {
    return {
      ...base,
      status: "completed",
      partial: false,
      completedAt: record.completedAt as string,
    };
  }
  return {
    ...base,
    status: record.status as Exclude<CoreAccountDeletionStatus["status"], "completed">,
    partial: record.partial as boolean,
    completedAt: null,
  };
}

function mappedError(status: number) {
  if (status === 401) return new CoreAccountDeletionUnauthorizedError();
  if (status === 404) return new CoreAccountDeletionNotFoundError();
  if (status === 409) return new CoreAccountDeletionConflictError();
  return new CoreAccountDeletionUnavailableError();
}

export class CoreAccountDeletionHttpGateway implements CoreAccountDeletionGateway {
  constructor(private readonly baseUrl: URL) {
    if (
      baseUrl.protocol !== "https:" ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error("Core API URL must be a canonical credential-free HTTPS origin.");
    }
  }

  async #request(
    path: string,
    method: "GET" | "POST",
    authorization: string,
    options: {
      idempotencyKey?: string;
      reauthenticationToken?: string;
      expectedReceipt?: string;
      acceptedStatuses: number[];
      enforceCommandStatus?: boolean;
    },
  ) {
    const headers: Record<string, string> = {
      authorization,
      accept: "application/json",
    };
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    if (options.reauthenticationToken) {
      headers["x-account-reauth-token"] = options.reauthenticationToken;
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        body: null,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new CoreAccountDeletionUnavailableError();
    }
    if (!options.acceptedStatuses.includes(response.status)) throw mappedError(response.status);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (contentType !== "application/json" || (declaredLength > 0 && declaredLength > 4_096)) {
      throw new CoreAccountDeletionUnavailableError();
    }
    let body: unknown;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 4_096) throw new Error();
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new CoreAccountDeletionUnavailableError();
    }
    const parsed = parseStatus(body, options.expectedReceipt);
    if (options.enforceCommandStatus) {
      const terminal = terminalStatuses.has(parsed.status);
      if ((response.status === 200) !== terminal || (response.status === 202) !== !terminal) {
        throw new CoreAccountDeletionUnavailableError();
      }
    }
    return parsed;
  }

  initiate(input: {
    accessToken: string;
    reauthenticationToken: string;
    idempotencyKey: string;
  }) {
    if (!input.accessToken || !input.reauthenticationToken || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new CoreAccountDeletionUnauthorizedError();
    }
    return this.#request(
      "/v1/account-deletion-requests/self",
      "POST",
      `Bearer ${input.accessToken}`,
      {
        idempotencyKey: input.idempotencyKey,
        reauthenticationToken: input.reauthenticationToken,
        acceptedStatuses: [200, 202],
        enforceCommandStatus: true,
      },
    );
  }

  status(receipt: string) {
    if (!RECEIPT.test(receipt)) throw new CoreAccountDeletionNotFoundError();
    return this.#request(
      "/v1/account-deletion-requests/status",
      "GET",
      `DeletionReceipt ${receipt}`,
      { expectedReceipt: receipt, acceptedStatuses: [200] },
    );
  }

  retry(receipt: string) {
    if (!RECEIPT.test(receipt)) throw new CoreAccountDeletionNotFoundError();
    return this.#request(
      "/v1/account-deletion-requests/status/retry",
      "POST",
      `DeletionReceipt ${receipt}`,
      { expectedReceipt: receipt, acceptedStatuses: [200, 202], enforceCommandStatus: true },
    );
  }
}
