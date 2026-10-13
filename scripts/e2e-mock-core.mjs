import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

/**
 * Loopback stand-in for core's `/v1/users/me` surface used by the browser
 * tests. It speaks the same contract the BFF client is pinned to
 * (`tests/fixtures/core-users-me.json`): bearer with the `core` audience,
 * JSON PATCH of the club fields, multipart picture upload under `file` or
 * `image`, and `DELETE /v1/users/me/profile-picture`. State is kept per
 * token subject so every seeded session starts from the fixture, and
 * `GET /__e2e/users/{sub}` exposes what core received for assertions. The
 * self-delete intake is served too; `GET /__e2e/account-deletion-intakes/{sub}`
 * lists which proof headers each intake call carried. `PUT /__e2e/users/{sub}`
 * merges profile members before the first page load (for example
 * `ytuLinked`), the way core's YTÜ login would have set them.
 *
 * SkyPass in Google Wallet (`/v1/skypass/wallet…`) starts off, as core does
 * without its settings. `PUT /__e2e/wallet/{sub}` merges `available`,
 * `issued` and `failNext` (a status the next link or revoke answers with,
 * and its core `code`); `GET /__e2e/wallet/{sub}` shows the state, the
 * calls core received and the save links it handed out. Wallet calls are
 * kept apart from the profile `requests`.
 *
 * Communication preferences (`/v1/users/me/communication-preferences`)
 * follow core's rules (`internal/commpref`) on a fixed team tree the
 * person is in through WEBLAB/FRONT: explicit choices per subject, the most
 * specific choice up the tree wins, own teams and the teams below them are
 * on by default, a hidden team is off and shown masked. The tree and the
 * first screen match `tests/fixtures/core-communication-preferences.json`.
 * `PUT /__e2e/communication-preferences/{sub}` sets `off` (core without its
 * key: every call `503 communication_preferences_unavailable`);
 * `GET /__e2e/communication-preferences/{sub}` shows the choices and the
 * PUT bodies core received.
 *
 * The same server also stands in for the realm's sky-account
 * `GET identity` (`tests/fixtures/sky-account-v1-identity.json`, the
 * bearer's own `sub`), which the Sudo mode gate reads to list the person's
 * methods. The dev server reaches it only through
 * `scripts/e2e-realm-redirect.mjs`, and only for `e2e-realm-` subjects.
 */

const MAX_PICTURE_BYTES = 5 * 1_024 * 1_024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{43}$/;
const patchableFields = ["firstName", "lastName", "linkedin", "university", "faculty", "department"];
/** Core refuses a change to these for a YTÜ-linked person (`409`, code `ytu_managed_field`). */
const ytuFields = ["university", "faculty", "department"];

function problem(response, status, title) {
  response.writeHead(status, { "content-type": "application/problem+json" });
  response.end(JSON.stringify({ type: "about:blank", title, status }));
}

const walletProblemCodes = {
  429: "skypass_wallet_link_rate_limited",
  502: "skypass_google_wallet_unavailable",
  503: "skypass_google_wallet_off",
};

function walletProblem(response, status) {
  const body = { type: "about:blank", title: "Wallet", status, detail: "Wallet", instance: "/v1/skypass/wallet/google" };
  if (walletProblemCodes[status]) body.code = walletProblemCodes[status];
  if (status === 429) body.retryAfterSeconds = 42;
  response.writeHead(status, {
    "content-type": "application/problem+json",
    ...(status === 429 ? { "retry-after": "42" } : {}),
    ...(status === 502 ? { "retry-after": "30" } : {}),
  });
  response.end(JSON.stringify(body));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function decodeBearer(header, audience = "core") {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match) return null;
  try {
    const claims = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (typeof claims.sub !== "string" || !audiences.includes(audience)) return null;
    return claims;
  } catch {
    return null;
  }
}

function decodeJwtClaims(token) {
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!parts) return null;
  try {
    return JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The sky-account sudo token core demands in `X-Sky-Sudo`. Core asks the realm
 * by introspection; the mock reads the same claims straight from the token:
 * `typ=sky-sudo`, the bearer's issuer, `azp` this client, an `aud` holding
 * both `sky-account` and `core`, the bearer's `sub` and `sid`, and a future
 * `exp`. No `auth_time` rule applies on this path. A stale or mismatched
 * proof is the whole point of the check, so it answers `401` as core does.
 */
function sudoProves(bearer, header, clientId) {
  const claims = decodeJwtClaims(header);
  const now = Math.floor(Date.now() / 1_000);
  const audiences = typeof claims?.aud === "string" ? [claims.aud] : Array.isArray(claims?.aud) ? claims.aud : [];
  return Boolean(
    claims &&
    claims.typ === "sky-sudo" &&
    claims.iss === bearer.iss &&
    claims.azp === clientId &&
    audiences.includes("sky-account") &&
    audiences.includes("core") &&
    claims.sub === bearer.sub &&
    typeof bearer.sid === "string" && bearer.sid !== "" &&
    claims.sid === bearer.sid &&
    Number.isSafeInteger(claims.exp) && claims.exp > now,
  );
}

function deletionView(record, { withReceipt }) {
  return {
    ...(withReceipt ? { receipt: record.receipt } : {}),
    status: record.status,
    partial: record.partial,
    platformBlocked: true,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
    completedAt: null,
    receiptExpiresAt: record.receiptExpiresAt,
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? "");
  const marker = boundary?.[1] ?? boundary?.[2]?.trim();
  if (!marker) return [];
  const delimiter = Buffer.from(`--${marker}`);
  const parts = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const headerStart = cursor + delimiter.length;
    if (body.subarray(headerStart, headerStart + 2).toString() === "--") break;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next === -1) break;
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    const data = body.subarray(headerEnd + 4, next - 2);
    const name = /name="([^"]*)"/.exec(headers)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
    parts.push({ name, filename, contentType: type, data });
    cursor = next;
  }
  return parts;
}

function sniff(bytes) {
  const startsWith = (signature, offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Core's team tree for the preference screen; the person is in FRONT (and so in WEBLAB). */
const preferenceTeams = [
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01", code: "WEBLAB", displayName: "Web Laboratuvarı", path: "/UYELER/YAZILIM/WEBLAB", parent: null, listed: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d02", code: "FRONT", displayName: "Frontend", path: "/UYELER/YAZILIM/WEBLAB/FRONT", parent: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01", listed: true, own: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d03", code: "BACK", displayName: "Backend", path: "/UYELER/YAZILIM/WEBLAB/BACK", parent: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d01", listed: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04", code: "AIRLAB", displayName: "Hava Araçları Laboratuvarı", path: "/UYELER/DONANIM/AIRLAB", parent: null, listed: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d05", code: "DRONE", displayName: "Drone", path: "/UYELER/DONANIM/AIRLAB/DRONE", parent: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04", listed: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d06", code: "GIZLI", displayName: "Gizli Proje", path: "/UYELER/DONANIM/GIZLI", parent: null, listed: false },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d07", code: "ROBOLAB", displayName: "Robotik Laboratuvarı", path: "/UYELER/DONANIM/ROBOLAB", parent: null, listed: true },
  { id: "0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d08", code: "SKYSEC", displayName: "Siber Güvenlik", path: "/UYELER/YAZILIM/SKYSEC", parent: null, listed: true },
];
const preferenceTeamById = new Map(preferenceTeams.map((team) => [team.id, team]));
/** The choices every seeded subject starts with: the fixture's screen. */
const initialPreferenceChoices = [
  ["club:haber", false],
  ["team:0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d03:haber", false],
  ["team:0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04:duyuru", true],
  ["team:0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d04:haber", true],
  ["team:0b5c8a51-6f0e-4c1a-9d8e-1f2a3b4c5d06:duyuru", true],
];
const PREFERENCE_CATEGORY = /^(?:all|club:(?:duyuru|haber)|team:([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(?:duyuru|haber))$/;

function preferenceChain(id) {
  const chain = [];
  for (let team = preferenceTeamById.get(id); team; team = team.parent ? preferenceTeamById.get(team.parent) : undefined) {
    chain.push(team.id);
  }
  return chain;
}

/** In the team or in a team below it (`TeamOf`'s subtree rule). */
function preferenceMember(id) {
  return preferenceTeams.some((team) => team.own && preferenceChain(team.id).includes(id));
}

/** Listed by itself or by the nearest team above that says; or one of the person's own. */
function preferenceSeen(id) {
  if (preferenceMember(id)) return true;
  return preferenceChain(id).some((teamId) => preferenceTeamById.get(teamId).listed === true) &&
    preferenceTeamById.get(id).listed !== false;
}

function preferenceScreen(choices) {
  const master = choices.has("all") ? choices.get("all") : true;
  const cell = (category, enabled, origin, from) => {
    const value = { explicit: choices.has(category) ? choices.get(category) : null, enabled, origin };
    if (from) value.from = from;
    value.effective = master && enabled;
    return { email: value };
  };
  const teamCell = (id, kind) => {
    const category = `team:${id}:${kind}`;
    if (!preferenceSeen(id)) return cell(category, false, "default");
    const chain = preferenceChain(id);
    for (const [index, teamId] of chain.entries()) {
      const key = `team:${teamId}:${kind}`;
      if (choices.has(key)) return cell(category, choices.get(key), index === 0 ? "explicit" : "inherited", index === 0 ? undefined : teamId);
    }
    const nearest = chain.findIndex((teamId) => preferenceMember(teamId));
    return nearest === -1 ? cell(category, false, "default") : cell(category, true, "default", nearest === 0 ? undefined : chain[nearest]);
  };
  const shown = new Set();
  const row = (id) => {
    const team = preferenceTeamById.get(id);
    shown.add(id);
    return {
      groupId: id, code: team.code, displayName: team.displayName, path: team.path, member: preferenceMember(id),
      kinds: { duyuru: teamCell(id, "duyuru"), haber: teamCell(id, "haber") },
      children: preferenceTeams.filter((child) => child.parent === id && preferenceSeen(child.id)).map((child) => row(child.id)),
    };
  };
  const teams = preferenceTeams.filter((team) => !team.parent && preferenceMember(team.id)).map((team) => row(team.id));
  const chosen = [...new Set([...choices.keys()].map((key) => PREFERENCE_CATEGORY.exec(key)?.[1]).filter(Boolean))]
    .filter((id) => preferenceTeamById.has(id))
    .sort((a, b) => preferenceTeamById.get(a).path.localeCompare(preferenceTeamById.get(b).path));
  const following = [];
  for (const id of chosen) {
    if (shown.has(id)) continue;
    if (!preferenceSeen(id)) {
      shown.add(id);
      following.push({
        groupId: id, hidden: true, code: "", displayName: "Gizli ekip", path: "", member: false,
        kinds: { duyuru: teamCell(id, "duyuru"), haber: teamCell(id, "haber") }, children: [],
      });
      continue;
    }
    following.push(row(id));
  }
  const followable = preferenceTeams
    .filter((team) => team.listed === true && !shown.has(team.id))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ id, code, displayName, path }) => ({ groupId: id, code, displayName, path }));
  return {
    channels: ["email"],
    master: cell("all", master, choices.has("all") ? "explicit" : "default"),
    club: {
      duyuru: cell("club:duyuru", choices.has("club:duyuru") ? choices.get("club:duyuru") : true, choices.has("club:duyuru") ? "explicit" : "default"),
      haber: cell("club:haber", choices.has("club:haber") ? choices.get("club:haber") : true, choices.has("club:haber") ? "explicit" : "default"),
    },
    teams,
    following,
    followable,
  };
}

/** The screen a freshly seeded subject sees; `tests/fixtures/core-communication-preferences.json` pins it. */
export function initialPreferenceScreen() {
  return preferenceScreen(new Map(initialPreferenceChoices));
}

function preferenceProblem(response, status, code, headers = {}) {
  response.writeHead(status, { "content-type": "application/problem+json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify({ type: "about:blank", title: "x", status, code }));
}

export function startMockCore({
  port,
  host = "127.0.0.1",
  keyFile,
  certificateFile,
  pictureBase,
  clientId = process.env.OIDC_CLIENT_ID ?? "account-center",
}) {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "core-users-me.json"), "utf8"));
  const identityFixture = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "sky-account-v1-identity.json"), "utf8"));
  const users = new Map();
  /** receipt → lifecycle record, plus the idempotency index the intake reuses. */
  const deletions = new Map();
  const deletionKeys = new Map();
  /** subject → which proof headers each intake call carried and how it ended; never the values. */
  const deletionIntakes = new Map();
  /** subject → SkyPass Google Wallet state; off until a test turns it on. */
  const wallets = new Map();
  /** subject → communication preference choices, the PUT bodies received and whether core runs without its key. */
  const preferences = new Map();
  const preferencesFor = (sub) => {
    let state = preferences.get(sub);
    if (!state) {
      state = { choices: new Map(initialPreferenceChoices), off: false, puts: [] };
      preferences.set(sub, state);
    }
    return state;
  };
  const pictureUrl = (id) => `${pictureBase}/skylab.svg?picture=${encodeURIComponent(id)}`;

  function userFor(sub) {
    let user = users.get(sub);
    if (!user) {
      user = {
        profile: { ...fixture, id: sub, profilePictureUrl: pictureUrl(fixture.profilePictureId) },
        pictures: [],
        requests: [],
      };
      users.set(sub, user);
    }
    return user;
  }

  function walletFor(sub) {
    let wallet = wallets.get(sub);
    if (!wallet) {
      wallet = { available: false, issued: false, failNext: null, requests: [], saveUrls: [] };
      wallets.set(sub, wallet);
    }
    return wallet;
  }

  function skyPassWallet(request, response, url, sub) {
    const wallet = walletFor(sub);
    wallet.requests.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/v1/skypass/wallet" && request.method === "GET") {
      return json(response, 200, { google: { available: wallet.available, issued: wallet.issued } });
    }
    if (url.pathname !== "/v1/skypass/wallet/google" || !["POST", "DELETE"].includes(request.method)) {
      return problem(response, 404, "Not Found");
    }
    if (!wallet.available) return walletProblem(response, 503);
    if (wallet.failNext) {
      const status = wallet.failNext;
      wallet.failNext = null;
      return walletProblem(response, status);
    }
    if (request.method === "DELETE") {
      wallet.issued = false;
      response.writeHead(204);
      return response.end();
    }
    wallet.issued = true;
    const segment = () => randomBytes(24).toString("base64url");
    const saveUrl = `https://pay.google.com/gp/v/save/${segment()}.${segment()}.${segment()}`;
    wallet.saveUrls.push(saveUrl);
    return json(response, 200, { saveUrl });
  }

  function communicationPreferences(request, response, sub, body) {
    const state = preferencesFor(sub);
    if (state.off) return preferenceProblem(response, 503, "communication_preferences_unavailable");
    const answer = () => {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(preferenceScreen(state.choices)));
    };
    if (request.method === "GET") return answer();
    if (request.method !== "PUT") return problem(response, 405, "Method Not Allowed");
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return preferenceProblem(response, 400, "communication_preference_invalid");
    }
    state.puts.push(parsed);
    const items = parsed?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 200 || Object.keys(parsed).length !== 1) {
      return preferenceProblem(response, 400, "communication_preference_invalid");
    }
    const seen = new Set();
    for (const item of items) {
      const match = PREFERENCE_CATEGORY.exec(item?.category ?? "");
      if (
        !match || item.channel !== "email" || seen.has(item.category) ||
        !Object.hasOwn(item, "enabled") || (item.enabled !== null && typeof item.enabled !== "boolean")
      ) {
        return preferenceProblem(response, 400, "communication_preference_invalid");
      }
      seen.add(item.category);
      if (match[1] && item.enabled !== null && (!preferenceTeamById.has(match[1]) || !preferenceSeen(match[1]))) {
        return preferenceProblem(response, 400, "communication_preference_team_unknown");
      }
    }
    for (const item of items) {
      if (item.enabled === null) state.choices.delete(item.category);
      else state.choices.set(item.category, item.enabled);
    }
    return answer();
  }

  function accountDeletion(request, response, url, body) {
    if (url.pathname === "/v1/account-deletion-requests/self" && request.method === "POST") {
      const bearer = decodeBearer(request.headers.authorization, "account");
      if (!bearer) return problem(response, 401, "Unauthorized");
      const intakes = deletionIntakes.get(bearer.sub) ?? [];
      deletionIntakes.set(bearer.sub, intakes);
      const intake = {
        sudoProof: typeof request.headers["x-sky-sudo"] === "string",
        legacyReauthToken: request.headers["x-account-reauth-token"] !== undefined,
        outcome: "refused",
      };
      intakes.push(intake);
      // Real core still takes the legacy ID-token header during the rollout;
      // the mock pins the proof Account Center sends now, so it wants the sudo token.
      if (!sudoProves(bearer, request.headers["x-sky-sudo"], clientId)) {
        return problem(response, 401, "Unauthorized");
      }
      intake.outcome = "accepted";
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key) || body.length > 0) {
        return problem(response, 400, "Bad Request");
      }
      const indexed = `${bearer.sub}\u0000${key}`;
      const existing = deletions.get(deletionKeys.get(indexed) ?? "");
      if (existing) return json(response, 202, deletionView(existing, { withReceipt: true }));
      const requestedAt = new Date();
      const record = {
        receipt: `adr_${randomBytes(32).toString("base64url")}`,
        subject: bearer.sub,
        status: "pending",
        partial: false,
        requestedAt: requestedAt.toISOString(),
        updatedAt: requestedAt.toISOString(),
        receiptExpiresAt: new Date(requestedAt.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      };
      deletions.set(record.receipt, record);
      deletionKeys.set(indexed, record.receipt);
      return json(response, 202, deletionView(record, { withReceipt: true }));
    }

    const receipt = /^DeletionReceipt (adr_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
    const record = receipt ? deletions.get(receipt) : undefined;
    if (!record) return problem(response, 404, "Not Found");
    if (url.pathname === "/v1/account-deletion-requests/status" && request.method === "GET") {
      return json(response, 200, deletionView(record, { withReceipt: false }));
    }
    if (url.pathname === "/v1/account-deletion-requests/status/retry" && request.method === "POST") {
      record.status = "pending";
      record.updatedAt = new Date().toISOString();
      return json(response, 202, deletionView(record, { withReceipt: false }));
    }
    return problem(response, 404, "Not Found");
  }

  const server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certificateFile) },
    async (request, response) => {
      const url = new URL(request.url ?? "/", `https://${request.headers.host ?? host}`);
      const intakeInspection = /^\/__e2e\/account-deletion-intakes\/([^/]+)$/.exec(url.pathname);
      if (intakeInspection && request.method === "GET") {
        return json(response, 200, deletionIntakes.get(decodeURIComponent(intakeInspection[1])) ?? []);
      }
      const walletInspection = /^\/__e2e\/wallet\/([^/]+)$/.exec(url.pathname);
      if (walletInspection && request.method === "PUT") {
        let overrides;
        try {
          overrides = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          return problem(response, 400, "Bad Request");
        }
        if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return problem(response, 400, "Bad Request");
        const wallet = walletFor(decodeURIComponent(walletInspection[1]));
        for (const key of ["available", "issued", "failNext"]) {
          if (Object.hasOwn(overrides, key)) wallet[key] = overrides[key];
        }
        return json(response, 200, wallet);
      }
      if (walletInspection && request.method === "GET") {
        return json(response, 200, walletFor(decodeURIComponent(walletInspection[1])));
      }
      const preferenceInspection = /^\/__e2e\/communication-preferences\/([^/]+)$/.exec(url.pathname);
      if (preferenceInspection && request.method === "PUT") {
        let overrides;
        try {
          overrides = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          return problem(response, 400, "Bad Request");
        }
        const state = preferencesFor(decodeURIComponent(preferenceInspection[1]));
        if (typeof overrides?.off === "boolean") state.off = overrides.off;
        return json(response, 200, { off: state.off });
      }
      if (preferenceInspection && request.method === "GET") {
        const state = preferencesFor(decodeURIComponent(preferenceInspection[1]));
        return json(response, 200, { off: state.off, choices: Object.fromEntries(state.choices), puts: state.puts });
      }
      const inspection = /^\/__e2e\/users\/([^/]+)$/.exec(url.pathname);
      if (inspection && request.method === "PUT") {
        let overrides;
        try {
          overrides = JSON.parse((await readBody(request)).toString("utf8"));
        } catch {
          return problem(response, 400, "Bad Request");
        }
        if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return problem(response, 400, "Bad Request");
        const user = userFor(decodeURIComponent(inspection[1]));
        Object.assign(user.profile, overrides);
        return json(response, 200, user.profile);
      }
      if (inspection && request.method === "GET") {
        const user = users.get(decodeURIComponent(inspection[1]));
        if (!user) return problem(response, 404, "Not Found");
        return json(response, 200, {
          profile: user.profile,
          requests: user.requests,
          pictures: user.pictures.map(({ id, contentType, bytes }) => ({ id, contentType, byteLength: bytes.length, base64: bytes.toString("base64") })),
        });
      }

      if (/^\/realms\/[^/]+\/sky-account\/v1\/identity$/.test(url.pathname) && request.method === "GET") {
        const bearer = decodeBearer(request.headers.authorization, "account");
        if (!bearer) return problem(response, 401, "Unauthorized");
        return json(response, 200, { ...identityFixture, sub: bearer.sub });
      }

      if (url.pathname.startsWith("/v1/account-deletion-requests")) {
        return accountDeletion(request, response, url, await readBody(request));
      }

      const claims = decodeBearer(request.headers.authorization);
      if (!claims) return problem(response, 401, "Unauthorized");
      if (url.pathname.startsWith("/v1/skypass/wallet")) return skyPassWallet(request, response, url, claims.sub);
      if (url.pathname === "/v1/users/me/communication-preferences") {
        return communicationPreferences(request, response, claims.sub, await readBody(request));
      }
      const user = userFor(claims.sub);
      const body = await readBody(request);
      const record = (extra = {}) => user.requests.push({ method: request.method, path: url.pathname, ...extra });

      if (url.pathname === "/v1/users/me" && request.method === "GET") {
        record();
        return json(response, 200, user.profile);
      }
      if (url.pathname === "/v1/users/me" && request.method === "PATCH") {
        let patch;
        try {
          patch = JSON.parse(body.toString("utf8"));
        } catch {
          return problem(response, 400, "Bad Request");
        }
        record({ body: patch });
        if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return problem(response, 400, "Bad Request");
        for (const [key, value] of Object.entries(patch)) {
          if (!patchableFields.includes(key) || typeof value !== "string") return problem(response, 400, "Bad Request");
        }
        for (const [key, value] of Object.entries(patch)) {
          if (user.profile.ytuLinked === true && ytuFields.includes(key) && value.trim() !== (user.profile[key] ?? "")) {
            response.writeHead(409, { "content-type": "application/problem+json" });
            return response.end(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, code: "ytu_managed_field" }));
          }
        }
        for (const [key, value] of Object.entries(patch)) {
          if (user.profile.ytuLinked === true && ytuFields.includes(key)) continue;
          user.profile[key] = value.trim() === "" ? null : value.trim();
        }
        user.profile.updatedAt = new Date().toISOString();
        return json(response, 200, user.profile);
      }
      if (url.pathname === "/v1/users/me/profile-picture" && request.method === "POST") {
        const parts = parseMultipart(body, request.headers["content-type"]);
        const part = parts.find(({ name }) => name === "image") ?? parts.find(({ name }) => name === "file");
        record({ fields: parts.map(({ name }) => name), fileName: part?.filename ?? null, declaredType: part?.contentType ?? null, byteLength: part?.data.length ?? 0 });
        if (!part || part.data.length === 0) return problem(response, 400, "Bad Request");
        if (part.data.length > MAX_PICTURE_BYTES) return problem(response, 413, "Request Entity Too Large");
        const contentType = sniff(part.data);
        if (!contentType) return problem(response, 400, "Bad Request");
        const id = randomUUID();
        user.pictures.push({ id, contentType, bytes: Buffer.from(part.data) });
        user.profile.profilePictureId = id;
        user.profile.profilePictureUrl = pictureUrl(id);
        user.profile.updatedAt = new Date().toISOString();
        return json(response, 200, user.profile);
      }
      if (url.pathname === "/v1/users/me/profile-picture" && request.method === "DELETE") {
        record();
        user.profile.profilePictureId = null;
        user.profile.profilePictureUrl = null;
        user.profile.updatedAt = new Date().toISOString();
        response.writeHead(204);
        return response.end();
      }
      return problem(response, 404, "Not Found");
    },
  );

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        origin: `https://${host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
