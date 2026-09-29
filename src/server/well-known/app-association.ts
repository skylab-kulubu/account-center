import "server-only";

/**
 * The two app-association files a phone fetches from this origin before it
 * lets SkyApp use the site's passkeys: Android's Digital Asset Links
 * (`/.well-known/assetlinks.json`) and Apple's App Site Association
 * (`/.well-known/apple-app-site-association`). Their values come from the
 * Mobile Lab through the environment, never from the repository; a file
 * whose variables are unset answers 404 instead of publishing a guess.
 *
 * Only the credential relation is declared (`get_login_creds` and
 * `webcredentials`). App Links / Universal Links (`handle_all_urls`,
 * `applinks`) are left out on purpose: they would let the app take over
 * links to this site, which is a separate decision.
 *
 * `scripts/validate-env.mjs` mirrors these rules so a bad value stops the
 * process at startup; here an invalid value only means "not published".
 */

type Environment = Readonly<Record<string, string | undefined>>;

/** How long a phone, a verifier or a CDN may keep either file before asking again. */
export const APP_ASSOCIATION_MAX_AGE_SECONDS = 300;

/** An Android application ID: at least two dot-separated segments, each starting with a letter. */
const androidPackageNamePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** A signing certificate's SHA-256 as `keytool`/Play Console print it: 32 colon-separated hex bytes. */
const sha256FingerprintPattern = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;
/** The ten-character Apple Developer Team ID (the App ID prefix). */
const appleTeamIdPattern = /^[A-Z0-9]{10}$/;
/** A reverse-DNS bundle ID: letters, digits and hyphens in at least two dot-separated segments. */
const appleBundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function trimmed(value: string | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * `ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS`: one or more comma-separated
 * fingerprints (the Play App Signing key and, if it differs, the upload key).
 * Lower-case hex is accepted and published upper-case; duplicates collapse.
 */
export function parseSha256CertFingerprints(value: string) {
  const entries = value.split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean);
  if (entries.length === 0 || !entries.every((entry) => sha256FingerprintPattern.test(entry))) {
    return null;
  }
  return [...new Set(entries)];
}

/** The `assetlinks.json` statement list, or `null` when it is not (validly) configured. */
export function androidAssetLinks(env: Environment) {
  const packageName = trimmed(env.ANDROID_ASSET_LINKS_PACKAGE_NAME);
  const fingerprints = trimmed(env.ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS);
  if (!packageName || !fingerprints || packageName.length > 255) return null;
  if (!androidPackageNamePattern.test(packageName)) return null;
  const sha256CertFingerprints = parseSha256CertFingerprints(fingerprints);
  if (!sha256CertFingerprints) return null;
  return [
    {
      relation: ["delegate_permission/common.get_login_creds"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: sha256CertFingerprints,
      },
    },
  ];
}

/** The `apple-app-site-association` document, or `null` when it is not (validly) configured. */
export function appleAppSiteAssociation(env: Environment) {
  const teamId = trimmed(env.APPLE_APP_SITE_ASSOCIATION_TEAM_ID);
  const bundleId = trimmed(env.APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID);
  if (!teamId || !bundleId || bundleId.length > 155) return null;
  if (!appleTeamIdPattern.test(teamId) || !appleBundleIdPattern.test(bundleId)) return null;
  return { webcredentials: { apps: [`${teamId}.${bundleId}`] } };
}

/**
 * The file as JSON, briefly cacheable, or a bare 404 that nothing caches so a
 * value configured later shows up on the next fetch. Neither answer redirects:
 * Android and Apple both refuse an association file behind a redirect.
 */
export function appAssociationResponse(document: object | null) {
  if (!document) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(JSON.stringify(document), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${APP_ASSOCIATION_MAX_AGE_SECONDS}`,
    },
  });
}
