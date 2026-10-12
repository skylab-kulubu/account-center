import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, TaskPage } from "@skylab-kulubu/skylcn-ui";
import { Background } from "@/components/background";

export default function NotFound() {
  return (
    <div className="account-root">
      <Background />
      <TaskPage
        actions={(
          <Button render={<Link href="/" />} size="lg" variant="solid">
            <ArrowLeft aria-hidden="true" />
            Hesap Merkezi’ne dön
          </Button>
        )}
        align="center"
        className="relative z-1 bg-transparent"
        description="Aradığın hesap ayarı taşınmış veya artık kullanılamıyor olabilir."
        eyebrow="404"
        title="Bu sayfa bulunamadı"
      />
    </div>
  );
}
