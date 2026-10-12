/**
 * The "İletişim tercihleri" model shared by the BFF and the browser: core's
 * `GET /v1/users/me/communication-preferences` screen projected onto the one
 * channel Account Center shows (e-mail), the change items the browser sends,
 * and the `?kanal=…&kategori=…` focus a mail's "tercihlerini yönet" link
 * carries (core `docs/communication-preferences.md`, bilet 09). No
 * server-only imports: the edge proxy and client components read it too.
 */

/** The only channel core keeps today; the screen and every write use it. */
export const COMMUNICATION_CHANNEL = "email";

export const NEWS_KINDS = ["duyuru", "haber"] as const;
export type NewsKind = (typeof NEWS_KINDS)[number];

/** Most changes core takes in one PUT (`commpref.MaxChanges`). */
export const MAX_PREFERENCE_CHANGES = 200;

/** A Keycloak Group id as core accepts it in a category (`groupIDPattern`). */
export const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `all`, `club:<kind>` or `team:<groupId>:<kind>`. */
const CATEGORY_PATTERN = /^(?:all|club:(?:duyuru|haber)|team:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:(?:duyuru|haber))$/;

export type PreferenceOrigin = "explicit" | "inherited" | "default";

/** One switch on the e-mail channel (core's `Cell`). */
export type PreferenceCell = {
  /** The person's own choice on this switch; `null` when there is none. */
  explicit: boolean | null;
  /** The switch's value without the master switch: what the screen shows. */
  enabled: boolean;
  origin: PreferenceOrigin;
  /** The team above the value comes from ("üst ekipten"), when it is not the switch's own. */
  from: string | null;
  /** Whether the mail goes: enabled and the master switch on. */
  effective: boolean;
};

export type KindCells = Readonly<Record<NewsKind, PreferenceCell>>;

export type PreferenceTeamRow = {
  groupId: string;
  code: string;
  displayName: string;
  path: string;
  member: boolean;
  /** A hidden team the person is not in but has a choice on: named "Gizli ekip", it can only be removed. */
  hidden: boolean;
  kinds: KindCells;
  children: PreferenceTeamRow[];
};

export type FollowableTeam = { groupId: string; code: string; displayName: string; path: string };

export type CommunicationPreferencesView = {
  master: PreferenceCell;
  club: KindCells;
  teams: PreferenceTeamRow[];
  following: PreferenceTeamRow[];
  followable: FollowableTeam[];
};

/** One change the browser asks for; the BFF adds the channel. `null` forgets the choice. */
export type PreferenceChange = { category: string; enabled: boolean | null };

export const MASTER_CATEGORY = "all";

export function clubCategory(kind: NewsKind) {
  return `club:${kind}`;
}

export function teamCategory(groupId: string, kind: NewsKind) {
  return `team:${groupId}:${kind}`;
}

export function isPreferenceCategory(value: unknown): value is string {
  return typeof value === "string" && CATEGORY_PATTERN.test(value);
}

/** The team a category names, or `null` for the master switch and club-wide mail. */
export function categoryGroupId(category: string) {
  const parts = category.split(":");
  return parts.length === 3 && parts[0] === "team" ? parts[1]! : null;
}

/**
 * The category a mail's link asks the screen to show first, or `null`.
 * Only the e-mail channel and a well-formed category count; anything else
 * opens the screen without a focus.
 */
export function preferenceFocus(kanal: unknown, kategori: unknown) {
  const one = (value: unknown) => (Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value);
  const channel = one(kanal);
  const category = one(kategori);
  if (channel !== undefined && channel !== COMMUNICATION_CHANNEL) return null;
  return isPreferenceCategory(category) ? category : null;
}

const TEXT_MAX = 256;
const MAX_TREE_DEPTH = 16;
const MAX_ROWS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= TEXT_MAX && (allowEmpty || value.length > 0) &&
    // No control characters: these strings reach the DOM as text.
    !/\p{Cc}/u.test(value);
}

function parseCell(value: unknown): PreferenceCell | null {
  if (!isRecord(value)) return null;
  const { explicit, enabled, origin, from, effective } = value;
  if (
    (explicit !== null && typeof explicit !== "boolean") ||
    typeof enabled !== "boolean" ||
    (origin !== "explicit" && origin !== "inherited" && origin !== "default") ||
    (from !== null && (typeof from !== "string" || !GROUP_ID_PATTERN.test(from))) ||
    typeof effective !== "boolean"
  ) return null;
  return { explicit, enabled, origin, from, effective };
}

function parseKinds(value: unknown): KindCells | null {
  if (!isRecord(value)) return null;
  const duyuru = parseCell(value.duyuru);
  const haber = parseCell(value.haber);
  return duyuru && haber ? { duyuru, haber } : null;
}

type RowBudget = { rows: number };

function parseRow(value: unknown, depth: number, budget: RowBudget): PreferenceTeamRow | null {
  if (!isRecord(value) || depth > MAX_TREE_DEPTH || ++budget.rows > MAX_ROWS) return null;
  const { groupId, code, displayName, path, member, hidden, children } = value;
  const kinds = parseKinds(value.kinds);
  if (
    typeof groupId !== "string" || !GROUP_ID_PATTERN.test(groupId) ||
    !text(code) || !text(displayName, false) || !text(path) ||
    typeof member !== "boolean" || typeof hidden !== "boolean" ||
    !kinds || !Array.isArray(children)
  ) return null;
  const parsed: PreferenceTeamRow[] = [];
  for (const child of children) {
    const row = parseRow(child, depth + 1, budget);
    if (!row) return null;
    parsed.push(row);
  }
  return { groupId, code, displayName, path, member, hidden, kinds, children: parsed };
}

function parseRows(value: unknown, budget: RowBudget) {
  if (!Array.isArray(value)) return null;
  const rows: PreferenceTeamRow[] = [];
  for (const item of value) {
    const row = parseRow(item, 0, budget);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function parseFollowable(value: unknown): FollowableTeam[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return null;
  const teams: FollowableTeam[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.groupId !== "string" || !GROUP_ID_PATTERN.test(item.groupId) ||
      !text(item.code) || !text(item.displayName, false) || !text(item.path)
    ) return null;
    teams.push({ groupId: item.groupId, code: item.code, displayName: item.displayName, path: item.path });
  }
  return teams;
}

/**
 * Fail-closed parser for the BFF's view (the browser re-checks what the
 * BFF answers, as the club profile does): `null` on anything unexpected.
 */
export function parseCommunicationPreferencesView(value: unknown): CommunicationPreferencesView | null {
  if (!isRecord(value)) return null;
  const master = parseCell(value.master);
  const club = parseKinds(value.club);
  const budget = { rows: 0 };
  const teams = parseRows(value.teams, budget);
  const following = parseRows(value.following, budget);
  const followable = parseFollowable(value.followable);
  if (!master || !club || !teams || !following || !followable) return null;
  return { master, club, teams, following, followable };
}
