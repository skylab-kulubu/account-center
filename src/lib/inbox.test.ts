import { describe, expect, it } from "vitest";
import { inboxLinkHref, parseInboxCounts, parseInboxItem, parseInboxPage } from "@/lib/inbox";

const raw = {
  id: "5d0c2f9e-0000-4000-8000-000000000001",
  type: "event.ticket-created",
  title: "Kodlama Gecesi biletin hazır",
  summary: "10.11.2026 18:30 · D-Blok",
  link: "/events/6f1c",
  created_at: "2026-10-25T09:00:00Z",
  seen_at: null,
  read_at: null,
  archived_at: null,
  later_member: "ignored",
};

describe("inbox contract", () => {
  it("reads SkyMail's item and page, ignoring members it does not know", () => {
    expect(parseInboxItem(raw)).toEqual({
      id: raw.id,
      type: raw.type,
      title: raw.title,
      summary: raw.summary,
      link: raw.link,
      createdAt: raw.created_at,
      seenAt: null,
      readAt: null,
    });
    expect(parseInboxPage({ items: [raw], next_cursor: "abc_DEF-123" })?.nextCursor).toBe("abc_DEF-123");
    expect(parseInboxPage({ items: [], next_cursor: null })).toEqual({ items: [], nextCursor: null });
  });

  it("fails closed on a body that is not the documented one", () => {
    for (const bad of [
      { ...raw, id: "../x" },
      { ...raw, title: "" },
      { ...raw, title: "x".repeat(201) },
      { ...raw, created_at: "yesterday" },
      { ...raw, read_at: 5 },
      { ...raw, type: "Event Ticket" },
    ]) {
      expect(parseInboxItem(bad)).toBeNull();
    }
    expect(parseInboxPage({ items: [raw, { ...raw, link: 7 }], next_cursor: null })).toBeNull();
    expect(parseInboxPage({ items: [raw], next_cursor: "has space" })).toBeNull();
    expect(parseInboxPage({ next_cursor: null })).toBeNull();
  });

  it("reads the counts", () => {
    expect(parseInboxCounts({ unseen: 2, unread: 5 })).toEqual({ unseen: 2, unread: 5 });
    expect(parseInboxCounts({ unseen: -1, unread: 5 })).toBeNull();
    expect(parseInboxCounts({ unseen: 1.5, unread: 5 })).toBeNull();
  });

  it("opens only https addresses on yildizskylab.com; sky-app's paths have no web link", () => {
    expect(inboxLinkHref("https://yildizskylab.com/sertifika/AB12")).toBe("https://yildizskylab.com/sertifika/AB12");
    expect(inboxLinkHref("https://my.yildizskylab.com/communication-preferences")).toBe("https://my.yildizskylab.com/communication-preferences");
    for (const none of [
      "",
      "/events/6f1c",
      "http://yildizskylab.com/x",
      "https://yildizskylab.com.evil.example/x",
      "https://evilyildizskylab.com/x",
      "https://user@yildizskylab.com/x",
      "https://yildizskylab.com:8443/x",
      "javascript:alert(1)",
    ]) {
      expect(inboxLinkHref(none), none).toBeNull();
    }
  });
});
