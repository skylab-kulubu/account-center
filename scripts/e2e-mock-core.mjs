import { randomUUID } from "node:crypto";
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
 * `GET /__e2e/users/{sub}` exposes what core received for assertions.
 */

const MAX_PICTURE_BYTES = 5 * 1_024 * 1_024;
const patchableFields = ["firstName", "lastName", "linkedin", "university", "faculty", "department"];

function problem(response, status, title) {
  response.writeHead(status, { "content-type": "application/problem+json" });
  response.end(JSON.stringify({ type: "about:blank", title, status }));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function decodeBearer(header) {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match) return null;
  try {
    const claims = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (typeof claims.sub !== "string" || !audiences.includes("core")) return null;
    return claims;
  } catch {
    return null;
  }
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

export function startMockCore({ port, host = "127.0.0.1", keyFile, certificateFile, pictureBase }) {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "core-users-me.json"), "utf8"));
  const users = new Map();
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

  const server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certificateFile) },
    async (request, response) => {
      const url = new URL(request.url ?? "/", `https://${request.headers.host ?? host}`);
      const inspection = /^\/__e2e\/users\/([^/]+)$/.exec(url.pathname);
      if (inspection && request.method === "GET") {
        const user = users.get(decodeURIComponent(inspection[1]));
        if (!user) return problem(response, 404, "Not Found");
        return json(response, 200, {
          profile: user.profile,
          requests: user.requests,
          pictures: user.pictures.map(({ id, contentType, bytes }) => ({ id, contentType, byteLength: bytes.length, base64: bytes.toString("base64") })),
        });
      }

      const claims = decodeBearer(request.headers.authorization);
      if (!claims) return problem(response, 401, "Unauthorized");
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
