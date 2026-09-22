import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import pg from "pg";
import Redis from "ioredis";

const accountAccessIssuer = "https://e.yildizskylab.com/realms/e-skylab";
const accountAccessContractKey = "skylab:account-access:v1:contract";
const accountAccessContractValue = "sha256(iss\\0sub);marker=1;ttl=none";

function accountAccessMarkerKey(subject: string) {
  const digest = createHash("sha256")
    .update(`${accountAccessIssuer}\0${subject}`, "utf8")
    .digest("hex");
  return `skylab:account-access:v1:blocked:${digest}`;
}

function testDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for authenticated E2E tests.");
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  ) {
    throw new Error("Authenticated E2E sessions are restricted to a loopback _test database.");
  }
  return value;
}

function encryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY is required for authenticated E2E tests.");
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes.");
  return key;
}

function accessRedis() {
  const host = process.env.ACCOUNT_ACCESS_REDIS_HOST;
  const port = Number(process.env.ACCOUNT_ACCESS_REDIS_PORT);
  const username = process.env.ACCOUNT_ACCESS_REDIS_USERNAME;
  const password = process.env.ACCOUNT_ACCESS_REDIS_PASSWORD;
  const database = Number(process.env.ACCOUNT_ACCESS_REDIS_DATABASE);
  if (
    process.env.ACCOUNT_ACCESS_GATE_MODE !== "enforce" ||
    !host || !["127.0.0.1", "localhost", "::1"].includes(host) ||
    !Number.isSafeInteger(port) || !username || !password || database !== 15
  ) {
    throw new Error("Authenticated E2E gate writes are restricted to loopback database 15.");
  }
  return new Redis({
    host,
    port,
    username,
    password,
    db: database,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
}

async function writeGate(operation: (redis: Redis) => Promise<void>) {
  const redis = accessRedis();
  try {
    await redis.connect();
    await operation(redis);
  } finally {
    redis.disconnect();
  }
}

export async function ensureAccessGateContract() {
  await writeGate(async (redis) => {
    await redis.set(accountAccessContractKey, accountAccessContractValue);
  });
}

export async function setSubjectGateMarker(subject: string, value: string) {
  await writeGate(async (redis) => {
    await redis.set(accountAccessMarkerKey(subject), value);
  });
}

/** The AES-256-GCM envelope `AesGcmSecretCipher` writes, built with the same key and associated data. */
function encryptedFixture(value: unknown, associatedData: string) {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 1,
    kid: createHash("sha256").update(key).digest("base64url").slice(0, 12),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

function encryptedTokenFixture(
  sessionId: string,
  tokenCanaries: { accessToken: string; refreshToken?: string; idToken: string },
) {
  return encryptedFixture({ ...tokenCanaries, tokenType: "bearer" }, `session:${sessionId}`);
}

/**
 * An unsigned but contract-shaped Account Center user token for `subject`:
 * the BFF validates claims only (issuer, subject, client, scope, exact
 * audience set, Account REST roles, expiry) before forwarding the bearer to
 * the loopback mock core, so the signature can be random.
 */
function contractShapedAccessToken(subject: string) {
  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const issuedAt = Math.floor(Date.now() / 1_000);
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({
    iss: process.env.OIDC_ISSUER ?? accountAccessIssuer,
    sub: subject,
    azp: process.env.OIDC_CLIENT_ID ?? "account-center",
    scope: "openid",
    aud: ["account", "core"],
    resource_access: { account: { roles: ["manage-account", "view-profile"] } },
    iat: issuedAt,
    exp: issuedAt + 60 * 60,
  });
  return `${header}.${payload}.${randomBytes(32).toString("base64url")}`;
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * An unsigned but contract-shaped ID token: the same claims core verifies on
 * the self-delete intake (`aud` exactly the client, matching subject,
 * non-empty `sid`, integer `auth_time`). `authenticatedAt` decides whether
 * the BFF sees a fresh authentication or has to ask for the Keycloak hop.
 */
function contractShapedIdToken(subject: string, sid: string, authenticatedAt: Date) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return [
    base64urlJson({ alg: "RS256", typ: "JWT" }),
    base64urlJson({
      iss: process.env.OIDC_ISSUER ?? accountAccessIssuer,
      sub: subject,
      aud: process.env.OIDC_CLIENT_ID ?? "account-center",
      sid,
      auth_time: Math.floor(authenticatedAt.getTime() / 1_000),
      iat: issuedAt,
      exp: issuedAt + 60 * 60,
    }),
    randomBytes(32).toString("base64url"),
  ].join(".");
}

/**
 * Records a Sudo mode proof for a seeded session the way the Microsoft
 * fallback does when the sky-account call could not issue a token: a
 * token-less `reauth` envelope, which is exactly what the account deletion
 * gate accepts (it never presents `X-Sky-Sudo` to the SPI).
 */
export async function seedSudoProof(sessionId: string, options: { expiresInSeconds?: number } = {}) {
  const expiresAt = new Date(Date.now() + (options.expiresInSeconds ?? 5 * 60) * 1_000);
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      "UPDATE account_sessions SET sudo_token_ciphertext = $2, sudo_expires_at = $3 WHERE id = $1",
      [
        sessionId,
        encryptedFixture({ sudoToken: null, method: "reauth" }, `session:${sessionId}:sudo`),
        expiresAt,
      ],
    );
  } finally {
    await client.end();
  }
  return { expiresAt };
}

export async function seedAuthenticatedSession(
  label: string,
  options: {
    includeRefreshToken?: boolean;
    contractToken?: boolean;
    /** When set, the stored ID token is contract-shaped and signs this authentication time. */
    idTokenAuthenticatedAt?: Date;
  } = {},
) {
  await ensureAccessGateContract();
  const sessionId = randomUUID();
  const subject = `e2e-${label}-${sessionId}`;
  const handle = randomBytes(32).toString("base64url");
  const keycloakSid = `e2e-sid-${sessionId}`;
  const generatedCanaries = {
    accessToken: options.contractToken
      ? contractShapedAccessToken(subject)
      : `e2e-access-${randomBytes(16).toString("base64url")}`,
    refreshToken: `e2e-refresh-${randomBytes(16).toString("base64url")}`,
    idToken: options.idTokenAuthenticatedAt
      ? contractShapedIdToken(subject, keycloakSid, options.idTokenAuthenticatedAt)
      : `e2e-id-${randomBytes(16).toString("base64url")}`,
  };
  const tokenCanaries = {
    accessToken: generatedCanaries.accessToken,
    idToken: generatedCanaries.idToken,
    ...(options.includeRefreshToken
      ? { refreshToken: generatedCanaries.refreshToken }
      : {}),
  };
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO account_sessions
        (id, subject, keycloak_sid, handle_hash, token_ciphertext, created_at, rotated_at,
         last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES
        ($1, $2, $3, $4, $5, now(), now() - interval '20 minutes', now(),
         now() + interval '30 minutes', now() + interval '8 hours')`,
      [
        sessionId,
        subject,
        keycloakSid,
        createHash("sha256").update(handle, "utf8").digest(),
        encryptedTokenFixture(sessionId, tokenCanaries),
      ],
    );
  } finally {
    await client.end();
  }
  return { sessionId, subject, handle, tokenCanaries: Object.values(tokenCanaries) };
}

export async function sessionExists(sessionId: string) {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM account_sessions WHERE id = $1", [sessionId]);
    return result.rowCount === 1;
  } finally {
    await client.end();
  }
}

export async function sessionState(sessionId: string) {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const result = await client.query<{
      last_seen_at: Date;
      idle_expires_at: Date;
      revoked_at: Date | null;
    }>(
      "SELECT last_seen_at, idle_expires_at, revoked_at FROM account_sessions WHERE id = $1",
      [sessionId],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}
