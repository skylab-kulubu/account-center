# Auth edge trust ve rate-limit sözleşmesi

`AUTH_TRUSTED_PROXY=cloudflare` tek desteklenen production değeridir. BFF yalnız `CF-Connecting-IP` başlığını istemci adresi kabul eder; `X-Forwarded-For` ve `X-Real-IP` rate-limit kimliğine katılmaz.

Bu varsayımın güvenli olması için:

- Origin doğrudan internete açık olmamalı; network policy/firewall yalnız Cloudflare egress trafiğini kabul etmelidir.
- Cloudflare dışarıdan gelen `CF-Connecting-IP` değerini silip kendi doğruladığı değeri yazmalıdır.
- Cloudflare ile origin arasındaki bağlantı TLS ve authenticated origin mekanizmasıyla korunmalıdır.
- Bu maddeler deployment testinde kanıtlanmadan rate limit IP tabanlı güvenlik sınırı kabul edilmez.

Eksik, birden fazla veya geçersiz Cloudflare adresi `unavailable` isimli ortak ve fail-closed bir bucket’a gider; header fallback ile saldırgana yeni bucket açılmaz. Adres IPv4/IPv6 olarak normalize edilir, endpoint scope’uyla birlikte server secret kullanılarak HMAC-SHA256 yapılır ve yalnız 32-byte digest PostgreSQL’e yazılır. Ham IP hiçbir auth logunda ya da tabloda tutulmaz.

Login için 60 saniyede 10, callback için 60 saniyede 30 istek sınırı atomik fixed-window sorgusuyla uygulanır. Aşım `429` ve tam pencere sonunu gösteren `Retry-After` döndürür. Süresi biten bucket’lar scheduled auth prune job’ında silinir.

## İstek gövdesi sınırı

Edge ve ingress katmanı genel istek gövdesi üst sınırını uygulamalıdır; uygulama içi kontrol bu dış DoS sınırının yerine geçmez. BFF ayrıca `Content-Length` varlığına güvenmeden stream’i byte bazında keser: `/api/auth/backchannel-logout` URL-encoded gövdesi en fazla 16 KiB, `/api/auth/logout` gövdesi en fazla 1 KiB olabilir. Local logout yalnız tam `application/x-www-form-urlencoded` media type’ını kabul eder; multipart, media-type parametresi ve sıkıştırılmış gövde reddedilir. Chunked veya eksik `Content-Length` aynı byte sınırına tabidir. Cloudflare ve origin ingress limitleri bu değerlerden düşük olmamalı, fakat genel ürün endpoint’leri için ayrıca makul global üst sınır taşımalıdır.
