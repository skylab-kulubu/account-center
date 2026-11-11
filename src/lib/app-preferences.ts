/**
 * App preferences ("Uygulama ayarları", core `docs/app-preferences.md`,
 * ADR 0081): small per-person view settings each app keeps in core. Account
 * Center sees only which apps hold some, how many keys and when they last
 * changed, and may reset an app. It never sees a value.
 */

/** Core's app name rule. */
export const APP_PREFERENCE_APP = /^[a-z][a-z0-9-]{1,31}$/;

export type AppPreferenceSummary = Readonly<{
  app: string;
  keys: number;
  updatedAt: string;
}>;

const APP_LABELS: Readonly<Record<string, string>> = {
  forms: "Forms",
  panel: "Yönetim paneli",
  account: "Hesap Merkezi",
  skymail: "SkyMail",
};

/** The app's Turkish name; an app this build does not know shows under its own name. */
export function appPreferenceLabel(app: string) {
  return APP_LABELS[app] ?? app;
}

export function isAppPreferenceApp(value: unknown): value is string {
  return typeof value === "string" && APP_PREFERENCE_APP.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSummary(value: unknown): value is AppPreferenceSummary {
  return (
    isRecord(value) &&
    isAppPreferenceApp(value.app) &&
    typeof value.keys === "number" && Number.isInteger(value.keys) && value.keys >= 1 && value.keys <= 1_000 &&
    typeof value.updatedAt === "string" && value.updatedAt.length <= 64 && Number.isFinite(Date.parse(value.updatedAt))
  );
}

/** Core's `{"items": [{app, keys, updatedAt}]}`, each app once; anything else is `null`. Unknown members are dropped. */
export function parseAppPreferenceSummaries(value: unknown): AppPreferenceSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 64) return null;
  const seen = new Set<string>();
  const items: AppPreferenceSummary[] = [];
  for (const item of value.items) {
    if (!isSummary(item) || seen.has(item.app)) return null;
    seen.add(item.app);
    items.push({ app: item.app, keys: item.keys, updatedAt: item.updatedAt });
  }
  return items;
}
