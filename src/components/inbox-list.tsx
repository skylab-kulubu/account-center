"use client";

import { Archive, BellOff, Check, Inbox, MailOpen } from "lucide-react";
import { Button, ListItem, ListPanel, Notice, StatusDot } from "@skylab-kulubu/skylcn-ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { INBOX_RETENTION_DAYS, INBOX_SEEN_EVENT, inboxLinkHref } from "@/lib/inbox";
import type { InboxItem, InboxItemAction, InboxPage } from "@/lib/inbox";
import { refreshBrowserSession } from "@/lib/session-refresh";

const ROUTE = "/api/account/inbox";

const WHEN = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
});

function when(value: string) {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? "" : WHEN.format(at);
}

type Problem = { title: string; detail: string; status: number; code?: string };

/** Why the inbox is not shown: off in this environment (no SkyMail), or a failure worth a retry or a fresh login. */
export function InboxNotice({ problem }: { problem: Problem }) {
  const off = problem.code === "inbox_disabled";
  if (problem.code === "inbox_not_enabled") {
    return (
      <Notice
        action={<Button render={<Link href="/login?returnTo=%2Fnotifications" />} size="sm" variant="link">Yeniden giriş yap</Button>}
        icon={BellOff}
        title={problem.title}
        tone="info"
      >
        {problem.detail}
      </Notice>
    );
  }
  return (
    <Notice
      action={off ? undefined : problem.status === 401 ? (
        <Button render={<Link href="/login?returnTo=%2Fnotifications" />} size="sm" variant="link">Yeniden giriş yap</Button>
      ) : (
        <Button render={<Link href="/notifications" />} size="sm" variant="link">Yeniden dene</Button>
      )}
      icon={off ? BellOff : undefined}
      title={problem.title}
      tone={off ? "info" : "warning"}
    >
      {problem.detail}
    </Notice>
  );
}

async function post(path: string, csrfToken: string) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<unknown>;
}

function itemOf(body: unknown): InboxItem | null {
  return typeof body === "object" && body !== null && "item" in body ? (body as { item: InboxItem }).item : null;
}

/**
 * The person's in-app inbox, newest first: unread items stand out, each opens
 * its link (an address on yildizskylab.com; sky-app's own paths open in
 * sky-app), and can be marked read, unread or archived. Opening the page marks
 * everything seen, which clears the badge.
 */
export function InboxList({ initial, csrfToken }: { initial: InboxPage; csrfToken: string }) {
  const [items, setItems] = useState(initial.items);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // After the shell's session refresh (shared, one at a time): never beside it with the same handle.
    void refreshBrowserSession(csrfToken)
      .catch(() => undefined)
      .then(() => post(`${ROUTE}/seen-all`, csrfToken))
      .then(() => window.dispatchEvent(new Event(INBOX_SEEN_EVENT)))
      .catch(() => undefined);
  }, [csrfToken]);

  async function run(key: string, operation: () => Promise<void>) {
    setPending(key);
    setFailed(false);
    try {
      await operation();
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  const mark = (item: InboxItem, action: InboxItemAction) =>
    run(`${item.id}:${action}`, async () => {
      const body = await post(`${ROUTE}/items/${encodeURIComponent(item.id)}/${action}`, csrfToken);
      if (action === "archive") {
        setItems((current) => current.filter(({ id }) => id !== item.id));
        return;
      }
      const updated = itemOf(body);
      if (updated) setItems((current) => current.map((row) => (row.id === item.id ? updated : row)));
    });

  const readAll = () =>
    run("read-all", async () => {
      await post(`${ROUTE}/read-all`, csrfToken);
      const now = new Date().toISOString();
      setItems((current) => current.map((row) => ({ ...row, readAt: row.readAt ?? now, seenAt: row.seenAt ?? now })));
    });

  const more = () =>
    run("more", async () => {
      if (!nextCursor) return;
      const response = await fetch(`${ROUTE}?cursor=${encodeURIComponent(nextCursor)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      const { page } = (await response.json()) as { page: InboxPage };
      setItems((current) => [...current, ...page.items.filter(({ id }) => !current.some((row) => row.id === id))]);
      setNextCursor(page.nextCursor);
    });

  const unread = items.some(({ readAt }) => readAt === null);

  return (
    <section className="settings-section inbox" aria-labelledby="inbox-heading">
      <div className="settings-section__heading inbox__heading">
        <h2 id="inbox-heading">Bildirimler</h2>
        {items.length > 0 ? (
          <Button aria-busy={pending === "read-all"} disabled={!unread || pending !== null} onClick={readAll} size="sm" type="button" variant="outline">
            <Check aria-hidden="true" />
            Hepsini okundu yap
          </Button>
        ) : null}
      </div>

      <div aria-live="polite">
        {failed ? (
          <Notice role={undefined} tone="warning">İşlem tamamlanamadı. Biraz sonra yeniden dene.</Notice>
        ) : null}
      </div>

      <ListPanel
        emptyIcon={Inbox}
        framed
        status={items.length === 0 ? { kind: "empty", message: "Henüz bildirimin yok." } : { kind: "ready" }}
      >
        {items.map((item) => {
          const isUnread = item.readAt === null;
          const href = inboxLinkHref(item.link) ?? undefined;
          return (
            <ListItem
              className="inbox__item"
              href={href}
              key={item.id}
              leading={isUnread ? <StatusDot label="Okunmadı" tone="brand" /> : undefined}
              subtitle={
                <>
                  {item.summary ? <span className="inbox__summary">{item.summary}</span> : null}
                  <time className="inbox__time" dateTime={item.createdAt}>{when(item.createdAt)}</time>
                </>
              }
              title={isUnread ? <strong>{item.title}</strong> : item.title}
              trailing={
                <span className="inbox__actions">
                  <Button
                    aria-label={isUnread ? `${item.title}: okundu yap` : `${item.title}: okunmadı yap`}
                    disabled={pending !== null}
                    onClick={() => void mark(item, isUnread ? "read" : "unread")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {isUnread ? <Check aria-hidden="true" /> : <MailOpen aria-hidden="true" />}
                    {isUnread ? "Okundu" : "Okunmadı"}
                  </Button>
                  <Button
                    aria-label={`${item.title}: arşivle`}
                    disabled={pending !== null}
                    onClick={() => void mark(item, "archive")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Archive aria-hidden="true" />
                    Arşivle
                  </Button>
                </span>
              }
            />
          );
        })}
      </ListPanel>

      {nextCursor ? (
        <Button aria-busy={pending === "more"} disabled={pending !== null} onClick={() => void more()} size="sm" type="button" variant="outline">
          Daha eski bildirimler
        </Button>
      ) : null}

      <p className="inbox__retention">Bildirimler {INBOX_RETENTION_DAYS} gün tutulur.</p>
    </section>
  );
}
