import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import pg from "pg";

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

function encryptedTokenFixture(
  sessionId: string,
  tokenCanaries: { accessToken: string; refreshToken?: string; idToken: string },
) {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`session:${sessionId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({
        ...tokenCanaries,
        tokenType: "bearer",
      }),
      "utf8",
    ),
    cipher.final(),
  ]);
  return JSON.stringify({
    v: 1,
    kid: createHash("sha256").update(key).digest("base64url").slice(0, 12),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

export async function seedAuthenticatedSession(
  label: string,
  options: { includeRefreshToken?: boolean } = {},
) {
  const sessionId = randomUUID();
  const handle = randomBytes(32).toString("base64url");
  const generatedCanaries = {
    accessToken: `e2e-access-${randomBytes(16).toString("base64url")}`,
    refreshToken: `e2e-refresh-${randomBytes(16).toString("base64url")}`,
    idToken: `e2e-id-${randomBytes(16).toString("base64url")}`,
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
        `e2e-${label}-${sessionId}`,
        `e2e-sid-${sessionId}`,
        createHash("sha256").update(handle, "utf8").digest(),
        encryptedTokenFixture(sessionId, tokenCanaries),
      ],
    );
  } finally {
    await client.end();
  }
  return { sessionId, handle, tokenCanaries: Object.values(tokenCanaries) };
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
