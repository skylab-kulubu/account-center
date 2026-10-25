/**
 * The person's in-app inbox ("Bildirimlerim"), as SkyMail serves it
 * (skymail-backend `docs/inbox.md`, iletişim-servisi 05 and 07). Shared by
 * the BFF, which parses SkyMail's answers fail-closed, and the page, which
 * shows them. An item is plain text: nothing here is ever read as HTML.
 */

/** Said on window when the inbox was marked seen, so the shell's badge clears. */
export const INBOX_SEEN_EVENT = "account-center:inbox-seen";

/** SkyMail keeps an item 90 days (S5). */
export const INBOX_RETENTION_DAYS = 90;
/** One page of the list; SkyMail takes 1–100. */
export const INBOX_PAGE_SIZE = 30;
/** SkyMail's cursors are opaque; this bounds what the BFF passes on. */
const CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const TYPE_KEY = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/;

export type InboxItem = {
  id: string;
  type: string;
  title: string;
  summary: string;
  /** An in-app path (`/events/…`) or an https address on yildizskylab.com; "" for none. */
  link: string;
  createdAt: string;
  seenAt: string | null;
  readAt: string | null;
};

export type InboxPage = { items: InboxItem[]; nextCursor: string | null };

export type InboxCounts = { unseen: number; unread: number };

/** What one item can be marked. */
export const INBOX_ITEM_ACTIONS = ["read", "unread", "archive"] as const;
export type InboxItemAction = (typeof INBOX_ITEM_ACTIONS)[number];

export function isInboxItemAction(value: unknown): value is InboxItemAction {
  return typeof value === "string" && (INBOX_ITEM_ACTIONS as readonly string[]).includes(value);
}

export function isInboxItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID.test(value);
}

export function isInboxCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || value === undefined || timestamp(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

/** One item, or null when it is not SkyMail's documented shape. Members it does not know are ignored. */
export function parseInboxItem(value: unknown): InboxItem | null {
  if (
    !isRecord(value) ||
    !isInboxItemId(value.id) ||
    typeof value.type !== "string" || !TYPE_KEY.test(value.type) ||
    !boundedText(value.title, 200) || value.title.trim() === "" ||
    !boundedText(value.summary, 1000) ||
    !boundedText(value.link, 2048) ||
    !timestamp(value.created_at) ||
    !nullableTimestamp(value.seen_at) ||
    !nullableTimestamp(value.read_at)
  ) {
    return null;
  }
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    summary: value.summary,
    link: value.link,
    createdAt: value.created_at,
    seenAt: (value.seen_at as string | null | undefined) ?? null,
    readAt: (value.read_at as string | null | undefined) ?? null,
  };
}

/** `{"items": [...], "next_cursor": "…" | null}`, or null. */
export function parseInboxPage(value: unknown): InboxPage | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) return null;
  const nextCursor = value.next_cursor ?? null;
  if (nextCursor !== null && !isInboxCursor(nextCursor)) return null;
  const items: InboxItem[] = [];
  for (const raw of value.items) {
    const item = parseInboxItem(raw);
    if (!item) return null;
    items.push(item);
  }
  return { items, nextCursor };
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `{"unseen": n, "unread": n}`, or null. */
export function parseInboxCounts(value: unknown): InboxCounts | null {
  if (!isRecord(value) || !count(value.unseen) || !count(value.unread)) return null;
  return { unseen: value.unseen, unread: value.unread };
}

const SKYLAB_HOST = /^(?:[a-z0-9-]+\.)*yildizskylab\.com$/;

/**
 * Where an item opens on the web: an https address on yildizskylab.com or
 * one of its subdomains, as SkyMail allowed it. An in-app path (`/events/…`,
 * `/news/…`) belongs to sky-app, which opens it itself (iletişim-servisi 08);
 * the web has no page for it, so the item shows without a link here. Nothing
 * else is ever followed: the check is SkyMail's again, so a later SkyMail rule
 * change cannot turn an item into an open redirect.
 */
export function inboxLinkHref(link: string): string | null {
  if (!link.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !SKYLAB_HOST.test(url.hostname)) {
    return null;
  }
  return url.href;
}
