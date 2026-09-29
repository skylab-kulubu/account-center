import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getAppleAppSiteAssociation } from "@/app/.well-known/apple-app-site-association/route";
import { GET as getAssetLinks } from "@/app/.well-known/assetlinks.json/route";
import {
  androidAssetLinks,
  appAssociationResponse,
  appleAppSiteAssociation,
  parseSha256CertFingerprints,
} from "@/server/well-known/app-association";

const playSigning = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");
const uploadKey = Array.from({ length: 32 }, () => "AB").join(":");

const android = {
  ANDROID_ASSET_LINKS_PACKAGE_NAME: "com.yildizskylab.skyapp",
  ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: `${playSigning},${uploadKey}`,
};
const apple = {
  APPLE_APP_SITE_ASSOCIATION_TEAM_ID: "A1B2C3D4E5",
  APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID: "com.yildizskylab.skyapp",
};

describe("Android Digital Asset Links", () => {
  it("declares only the credential relation for the configured package and fingerprints", () => {
    expect(androidAssetLinks(android)).toEqual([
      {
        relation: ["delegate_permission/common.get_login_creds"],
        target: {
          namespace: "android_app",
          package_name: "com.yildizskylab.skyapp",
          sha256_cert_fingerprints: [playSigning, uploadKey],
        },
      },
    ]);
  });

  it("publishes lower-case, spaced or repeated fingerprints once, upper-case", () => {
    expect(parseSha256CertFingerprints(` ${playSigning.toLowerCase()} , ${playSigning},, `)).toEqual([playSigning]);
  });

  it.each([
    [{}],
    [{ ANDROID_ASSET_LINKS_PACKAGE_NAME: android.ANDROID_ASSET_LINKS_PACKAGE_NAME }],
    [{ ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: android.ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS }],
    [{ ...android, ANDROID_ASSET_LINKS_PACKAGE_NAME: "  " }],
    [{ ...android, ANDROID_ASSET_LINKS_PACKAGE_NAME: "skyapp" }],
    [{ ...android, ANDROID_ASSET_LINKS_PACKAGE_NAME: "com.9lab.app" }],
    [{ ...android, ANDROID_ASSET_LINKS_PACKAGE_NAME: "com.yildizskylab.sky-app" }],
    [{ ...android, ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: "," }],
    [{ ...android, ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: playSigning.slice(3) }],
    [{ ...android, ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: playSigning.replaceAll(":", "") }],
    [{ ...android, ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS: `${playSigning},not-a-fingerprint` }],
  ])("publishes nothing for an incomplete or invalid configuration", (env) => {
    expect(androidAssetLinks(env)).toBeNull();
  });
});

describe("Apple App Site Association", () => {
  it("lists the configured app under webcredentials only", () => {
    expect(appleAppSiteAssociation(apple)).toEqual({
      webcredentials: { apps: ["A1B2C3D4E5.com.yildizskylab.skyapp"] },
    });
  });

  it.each([
    [{}],
    [{ APPLE_APP_SITE_ASSOCIATION_TEAM_ID: apple.APPLE_APP_SITE_ASSOCIATION_TEAM_ID }],
    [{ APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID: apple.APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_TEAM_ID: "a1b2c3d4e5" }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_TEAM_ID: "A1B2C3D4E" }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_TEAM_ID: "A1B2C3D4E5.com.yildizskylab.skyapp" }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID: "skyapp" }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID: "com.yildizskylab.sky_app" }],
    [{ ...apple, APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID: "com.yildizskylab.*" }],
  ])("publishes nothing for an incomplete or invalid configuration", (env) => {
    expect(appleAppSiteAssociation(env)).toBeNull();
  });
});

describe("association responses", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves a document as briefly cacheable JSON without a redirect", async () => {
    const response = appAssociationResponse({ webcredentials: { apps: [] } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ webcredentials: { apps: [] } });
  });

  it("answers a missing document with a bare, uncached 404", async () => {
    const response = appAssociationResponse(null);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("reads the environment on every request", async () => {
    for (const name of [...Object.keys(android), ...Object.keys(apple)]) vi.stubEnv(name, "");
    expect(getAssetLinks().status).toBe(404);
    expect(getAppleAppSiteAssociation().status).toBe(404);

    for (const [name, value] of Object.entries({ ...android, ...apple })) vi.stubEnv(name, value);
    const assetLinks = getAssetLinks();
    const association = getAppleAppSiteAssociation();

    expect(assetLinks.status).toBe(200);
    await expect(assetLinks.json()).resolves.toEqual(androidAssetLinks(android));
    expect(association.status).toBe(200);
    expect(association.headers.get("content-type")).toBe("application/json");
    await expect(association.json()).resolves.toEqual(appleAppSiteAssociation(apple));
  });
});
