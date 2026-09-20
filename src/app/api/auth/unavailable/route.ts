import { ACCOUNT_ACCESS_RETRY_AFTER_SECONDS } from "@/server/access-gate/http";

export const dynamic = "force-dynamic";

const body = `<!doctype html>
<html lang="tr">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hesap Merkezi kullanılamıyor</title></head>
  <body><main><h1>Hesap Merkezi şu anda kullanılamıyor</h1><p>Güvenli erişim doğrulanamadı. Lütfen kısa bir süre sonra yeniden dene.</p><p><a href="/">Yeniden dene</a></p></main></body>
</html>`;

export function GET() {
  return new Response(body, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Retry-After": String(ACCOUNT_ACCESS_RETRY_AFTER_SECONDS),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
