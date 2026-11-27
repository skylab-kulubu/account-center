"use client";

import { ServerErrorScenePage } from "@skylab-kulubu/skylcn-ui";
import { Background } from "@/components/background";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="account-root" role="alert">
      <Background />
      <ServerErrorScenePage className="relative z-1 bg-transparent" onAction={reset} />
    </div>
  );
}
