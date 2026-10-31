"use client";

import { MailX } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { emailDeliveryCopy, parseUndeliverable } from "@/lib/email-delivery";
import { isObject, responseJson } from "@/lib/security-client";

/**
 * The overview's line when SkyMail no longer mails one of the person's
 * addresses, read after the page is shown from `GET /api/account/email/delivery`
 * (which answers `200` with an empty list for any failure behind the session).
 * It links to the e-mail page, where the address carries the same warning.
 * No close button: it goes away once the panel lifts the suppression.
 */
export function HomeEmailDeliveryWarning() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/account/email/delivery", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const body = await responseJson(response);
        if (active && isObject(body)) setShown(parseUndeliverable(body.undeliverable).length > 0);
      } catch {
        // No warning; the page works without it.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!shown) return null;
  return (
    <p className="email-delivery-notice">
      <MailX aria-hidden="true" size={17} />
      <Link href="/email">{emailDeliveryCopy.overview}</Link>
    </p>
  );
}
