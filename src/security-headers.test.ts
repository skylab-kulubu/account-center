import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function configuredHeaders(path: string) {
  const response = await unstable_getResponseFromNextConfig({
    url: `https://my.yildizskylab.com${path}`,
    nextConfig,
  });
  return response.headers;
}

describe("configured response headers", () => {
  it.each(["/", "/security", "/api/health", "/internal/v1/x", "/.well-known", "/x/.well-known/assetlinks.json"])(
    "forbid caching %s",
    async (path) => {
      const headers = await configuredHeaders(path);
      expect(headers.get("cache-control")).toBe("no-store");
      expect(headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it.each(["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"])(
    "leave caching of %s to the route but keep the security headers",
    async (path) => {
      const headers = await configuredHeaders(path);
      expect(headers.get("cache-control")).toBeNull();
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("strict-transport-security")).toContain("max-age=63072000");
    },
  );
});
