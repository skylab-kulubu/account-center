# Auth edge trust ve rate-limit sözleşmesi

## Topoloji

Platform bugün Dokploy host'u üzerinde çalışan bir Traefik'in arkasındadır. Traefik klasik bir Docker container'ıdır (swarm routing mesh yoktur), `0.0.0.0:80` ve `0.0.0.0:443` portlarını düz docker NAT ile yayımlar ve `dokploy-network` üzerinde kendi adresiyle uygulamaya bağlanır. Bu adres her yeniden dağıtımda değişir, bu yüzden tek bir IP'ye değil bir CIDR kümesine güvenilir.

Cloudflare proxy'si şu anda **kapalıdır**: `CF-Connecting-IP` origin'e hiç ulaşmaz. Cloudflare ileride tekrar açılırsa mod değiştirilir, kod değişmez.

## `AUTH_TRUSTED_PROXY` modları

Değişken zorunludur ve tam olarak üç değer alır. Her mod yalnız aşağıda yazan kaynağa güvenir; başka hiçbir başlık rate-limit kimliğine katılmaz.

### `traefik` (bu dağıtımın production değeri)

1. `X-Forwarded-For` okunur, virgülden bölünür, her parça trim edilir.
2. Canonical IPv4/IPv6 adresi olmayan parçalar (port taşıyan, host adı, `unknown`, zone id'li) atılır.
3. Kalanların **en sağdan başlayarak** `AUTH_TRUSTED_PROXY_RANGES` içinde **olmayan** ilki istemci adresi kabul edilir.
4. Bütün parçalar bilinen hop ise en sağdaki parça kullanılır; peer'in kendisi o noktada mevcut en dar kimliktir.
5. Başlık hiç yoksa tek değerli `X-Real-IP` fallback'i denenir.
6. Başlık var ama hiçbir parça canonical değilse ya da hiç adres bulunamazsa `unavailable` döner (fail-closed).

Soldan gelen parçalar hiçbir zaman kazanamaz: ziyaretçinin gönderdiği sahte bir önek zincirin soluna düşer, güvenilen kenarın gerçekten gördüğü adres ise sağda kalır.

**Dağıtım ön koşulu:** Traefik entryPoint'lerinde `forwardedHeaders.trustedIPs` tanımlı olmamalıdır. Bu yapılandırmada Traefik dışarıdan gelen bütün `X-Forwarded-*` başlıklarını atar ve `X-Forwarded-For` başlığını gördüğü peer ile tek parça olarak kendisi yazar; `X-Real-IP` da aynı şekilde üretilir. Portlar düz docker NAT ile yayımlandığı için o peer gerçek istemcidir. `trustedIPs` eklenirse veya Traefik'in önüne başka bir proxy girerse bu sözleşme yeniden doğrulanmadan geçerli sayılmaz.

### `cloudflare`

Yalnız `CF-Connecting-IP` istemci adresi kabul edilir; `X-Forwarded-For` ve `X-Real-IP` yok sayılır. Eksik, birden fazla ya da geçersiz değer `unavailable` bucket'ına gider.

**Dağıtım ön koşulu:** origin doğrudan internete açık olmamalı, network policy/firewall yalnız Cloudflare egress trafiğini kabul etmelidir. Cloudflare dışarıdan gelen `CF-Connecting-IP` değerini silip kendi doğruladığı değeri yazmalı, Cloudflare ile origin arasındaki bağlantı TLS ve authenticated origin mekanizmasıyla korunmalıdır. Origin firewall'ı olmadan bu mod IP tabanlı güvenlik sınırı sayılmaz: herkes başlığı kendisi uydurabilir.

### `none`

Hiçbir proxy başlığına güvenilmez. Yalnız runtime'ın kendisi bir socket adresi veriyorsa o kullanılır; Next.js'in Node sunucusu vermez, dolayısıyla bu modda bütün anonim istekler ortak `unavailable` bucket'ına düşer. Doğrudan internete açık ya da tek kiracılı ortamlar için güvenli varsayılan; production kenar yapılandırması kanıtlanana kadar kullanılabilir.

**Dağıtım ön koşulu:** yoktur, çünkü hiçbir şeye güvenilmez. Bedeli availability'dir: anonim login/callback bütçesi platform genelinde ortaktır.

## `AUTH_TRUSTED_PROXY_RANGES`

İsteğe bağlıdır ve **yalnız** `X-Forwarded-For` zincirinde proxy hop atlamak için kullanılır. Virgülle ayrılmış canonical CIDR bloklarıdır; tanımsızsa varsayılan:

```
10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,::1/128,fc00::/7
```

Blokların host bitleri sıfır olmak zorundadır (`10.0.0.1/8` reddedilir, sessizce `10.0.0.0/8` sayılmaz) ve prefix uzunluğu aileye uymalıdır. Liste başlangıçta doğrulanır: geçersiz bir değer süreci ayağa kaldırmaz, `/api/ready` de ortam sözleşmesini doğruladığı için trafik yönlendirilmez. Doğrulama moddan bağımsız çalışır, böylece `cloudflare` modunda yazılan bir yazım hatası da mod değiştirmeden önce görülür.

`::ffff:10.0.1.109` gibi IPv4-mapped bir peer, taşıdığı IPv4 adresiyle aynı sayılır ve IPv4 bloklarıyla eşleşir.

**Bu kümeyi genişletmek bir güvenlik kararıdır.** İçindeki her peer istemci adresini kendisi bildirebilir; yani kümeye eklenen bir host herhangi bir ziyaretçiyi herhangi bir rate-limit bucket'ına sokabilir veya kendi bucket'ından kaçabilir. Yalnız gerçekten kendi kontrolümüzdeki hop'lar eklenir.

## Kimlik ve saklama

Dönen değer yalnız bir bucket adıdır. Adres IPv4/IPv6 olarak normalize edilir, endpoint scope'uyla birlikte server secret kullanılarak HMAC-SHA256'dan geçirilir ve yalnız 32-byte digest PostgreSQL'e yazılır. Ham IP hiçbir auth logunda ya da tabloda tutulmaz. `unavailable` ortak ve fail-closed bir bucket'tır; header fallback'iyle saldırgana yeni bucket açılmaz.

## Bütçeler

Login için 60 saniyede 10, callback için 60 saniyede 30 istek sınırı atomik fixed-window sorgusuyla uygulanır. Aşım `429` ve tam pencere sonunu gösteren `Retry-After` döndürür. Süresi biten bucket'lar scheduled auth prune job'ında silinir.

Bu bütçeler istemci başınadır. Mod kenar topolojisiyle uyuşmazsa istemci adresi okunamaz, bütün anonim ziyaretçiler tek `unavailable` bucket'ını paylaşır ve platform geneli bir availability sınırı ortaya çıkar; bu yüzden mod dağıtımla birlikte doğrulanır.

## İstek gövdesi sınırı

Edge ve ingress katmanı genel istek gövdesi üst sınırını uygulamalıdır; uygulama içi kontrol bu dış DoS sınırının yerine geçmez. BFF ayrıca `Content-Length` varlığına güvenmeden stream'i byte bazında keser: `/api/auth/backchannel-logout` URL-encoded gövdesi en fazla 16 KiB, `/api/auth/logout` gövdesi en fazla 1 KiB olabilir. Local logout yalnız tam `application/x-www-form-urlencoded` media type'ını kabul eder; multipart, media-type parametresi ve sıkıştırılmış gövde reddedilir. Chunked veya eksik `Content-Length` aynı byte sınırına tabidir. Traefik, varsa Cloudflare ve origin ingress limitleri bu değerlerden düşük olmamalı, fakat genel ürün endpoint'leri için ayrıca makul global üst sınır taşımalıdır.
