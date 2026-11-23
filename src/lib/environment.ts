/**
 * Whether this Account Center serves the sandbox. The consoles read it from
 * the API address they were built against (core-frontend
 * src/lib/environment.ts); Account Center reads it from its own runtime
 * configuration: its public address (`APP_URL`, sandbox-my.… beside
 * sandbox-admin.…) or the realm it signs in with (`e-skylab-sandbox`).
 * Production draws nothing; an address it cannot read counts as production.
 */
export function isSandbox({ appUrl, issuer }: { appUrl?: string | URL | null; issuer?: string | URL | null }): boolean {
  return sandboxHost(appUrl) || sandboxRealm(issuer);
}

function parse(value: string | URL | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function sandboxHost(value: string | URL | null | undefined) {
  const url = parse(value);
  return url !== null && /^sandbox[-.]/.test(url.hostname);
}

function sandboxRealm(value: string | URL | null | undefined) {
  const url = parse(value);
  return url !== null && /\/realms\/[^/]+-sandbox\/?$/.test(url.pathname);
}
