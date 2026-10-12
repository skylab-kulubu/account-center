"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import { Button, TaskPage } from "@skylab-kulubu/skylcn-ui";
import { Background } from "@/components/background";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="account-root" role="alert">
      <Background />
      <TaskPage
        actions={(
          <Button onClick={reset} size="lg" type="button" variant="solid">
            <RotateCcw aria-hidden="true" />
            Yeniden dene
          </Button>
        )}
        align="center"
        className="relative z-1 bg-transparent"
        description="Bağlantını kontrol edip yeniden deneyebilirsin."
        icon={AlertCircle}
        title="Bu alan şu anda yüklenemedi"
        tone="danger"
      />
    </div>
  );
}
