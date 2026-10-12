import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // A development server keeps its lock inside its own build directory, so a
  // second `next dev` can only run beside the first one from another one. The
  // browser tests use it for the account-erasure server (a nested path, so it
  // stays inside the ignored `.next`); nothing else sets it and the build
  // directory stays `.next`.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // `next dev` disposes a route nobody has asked for in a minute (and that is
  // not among the last five) and compiles it again on the next request. The
  // browser tests compile every route once before they start
  // (`tests/e2e/global-setup.ts`); a rebuild in the middle of a run holds the
  // server and the CI runner's two cores long enough to push a page that a
  // test is waiting for past its timeout, so their servers keep every route
  // for the length of a run. Only `scripts/start-e2e-server.mjs` sets it.
  ...(process.env.E2E_KEEP_ROUTES_COMPILED === "1"
    ? { onDemandEntries: { maxInactiveAge: 60 * 60 * 1000 } }
    : {}),
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // skylcn-ui exports every component from one entry point; without this the
    // client bundle carries all of them (Base UI, motion, the toast and date
    // pickers), not only the few a page renders.
    optimizePackageImports: ["@skylab-kulubu/skylcn-ui"],
  },
  output: "standalone",
  poweredByHeader: false,
  async redirects() {
    // The v1 "Kişisel bilgiler" page became "Kimlik"; old links keep working.
    return [{ source: "/personal-information", destination: "/identity", permanent: true }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // A configured header here replaces the one a route sets, so the
      // app-association files under /.well-known keep their own short
      // public caching (and their 404s their own no-store).
      { source: "/((?!\\.well-known/).*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
