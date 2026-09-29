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
  allowedDevOrigins: ["127.0.0.1"],
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
