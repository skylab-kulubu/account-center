# Auth edge trust ve rate-limit sözleşmesi

## Topoloji

Platform bugün Dokploy host'u üzerinde çalışan bir Traefik'in arkasındadır. Traefik klasik bir Docker container'ıdır (swarm routing mesh yoktur), `0.0.0.0:80` ve `0.0.0.0:443` portlarını düz docker NAT ile yayımlar ve `dokploy-network` üzerinde kendi adresiyle uygulamaya bağlanır. Bu adres her yeniden dağıtımda değişir, bu yüzden tek bir IP'ye değil bir CIDR kümesine güvenilir.

Cloudflare proxy'si şu anda **kapalıdır**: `CF-Connecting-IP` origin'e hiç ulaşmaz. Cloudflare ileride tekrar açılırsa mod değiştirilir, kod değişmez.

## Public yol sınırı: `/internal` ve `/.well-known`

### `/internal/*` her zaman 404

Account Center'ın hiçbir internal ucu kalmadı; sonuncusu olan `POST /internal/v1/native-handoff/redeem` ADR-0048 ile emekliye ayrıldı. Bu yüzden `/internal` ve altındaki **her** istek, oturum kontrolünden önce proxy'de gövdesiz, `Cache-Control: no-store` taşıyan bir `404` alır; login sayfasına yönlendirilmez. Proxy matcher'ı bu yol için ayrı bir girdi taşır, böylece `Purpose: prefetch` / `Next-Router-Prefetch` başlıklı istekler de korumadan kaçamaz.

Core'daki gibi `X-Forwarded-*`, `Forwarded` veya `X-Real-Ip` başlığına bakıp "public edge'den geldi" ayrımı **yapılmaz**: ayırt edilecek bir iç çağıran yoktur ve başlığa dayalı bir ayrım, başlıksız doğrudan erişime (container ağı) kapı bırakmaktan başka bir şey kazandırmaz. İleride `app/internal` altına bir uç eklenirse bu koruma bilinçli olarak değiştirilmeden erişilemez; o gün ağ sınırıyla (ayrı entrypoint, mTLS) birlikte tasarlanır.

Traefik'te `my.yildizskylab.com` router'ına `/internal` önekini reddeden bir middleware eklemek isteğe bağlı bir ikinci savunma hattı olurdu; OPS1'de kenarda değişiklik gerekmedi ve koruma uygulama katmanındadır. Uygulama gelen hiçbir `X-Sky-*` başlığını okumaz: `X-Sky-Sudo` yalnız giden çağrılarda (sky-account SPI'ye ve hesap silmede core'a) kullanılır, `X-Sky-Handoff-Proof` hiç görülmez. Kenarda `X-Sky-*` başlıklarını silmek bu yüzden yanlıştır: onlar istemcinin taşıdığı, kriptografik olarak doğrulanan değerlerdir.

### `/.well-known/*` uygulamanındır

`/.well-known` makineler içindir: login yönlendirmesinden muaftır ve uygulama kendisi yanıtlar. İki dosya, Mobile Lab'in vereceği değerlerle ortam değişkenlerinden üretilir; değerler repoya girmez.

| Dosya | Değişkenler (ikisi birlikte) | Yayımlanan ilişki |
| --- | --- | --- |
| `/.well-known/assetlinks.json` | `ANDROID_ASSET_LINKS_PACKAGE_NAME`, `ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS` | `delegate_permission/common.get_login_creds` |
| `/.well-known/apple-app-site-association` | `APPLE_APP_SITE_ASSOCIATION_TEAM_ID`, `APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID` | `webcredentials.apps: ["<TEAM_ID>.<BUNDLE_ID>"]` |

Biçimler (Mobile Lab bu biçimde teslim eder; örnekler yalnız biçim içindir):

- `ANDROID_ASSET_LINKS_PACKAGE_NAME`: uygulamanın Android application ID'si (`applicationId`). En az iki noktalı parça, her parça harfle başlar ve yalnız `A-Z a-z 0-9 _` içerir; en fazla 255 karakter. Örnek biçim: `org.skylab.mobile`.
- `ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS`: imza sertifikalarının SHA-256 parmak izleri, virgülle ayrılmış. Her biri iki nokta ile ayrılmış 32 hex bayttır (`keytool -list -v` ya da Play Console → App integrity çıktısındaki gibi). Play App Signing anahtarı mutlaka, upload/debug anahtarı gerekiyorsa o da eklenir. Küçük harf kabul edilir, büyük harfle yayımlanır; tekrarlar tekilleşir. Örnek biçim: `AB:CD:…:EF` (32 bayt).
- `APPLE_APP_SITE_ASSOCIATION_TEAM_ID`: 10 karakterlik Apple Developer Team ID (App ID prefix), yalnız `A-Z 0-9`. Örnek biçim: `A1B2C3D4E5`.
- `APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID`: iOS bundle ID; en az iki noktalı parça, parçalar yalnız `A-Z a-z 0-9 -`; en fazla 155 karakter. Örnek biçim: `org.skylab.mobile`.

Çift ya hep birlikte ya hiç tanımlanır. Hiçbiri tanımlı değilse dosya yayımlanmaz (`404`); biri tanımlı diğeri değilse, bir değer biçime uymuyorsa ya da yer tutucu içeriyorsa `scripts/validate-env.mjs` süreci başlatmaz.

Yanıtlar: yapılandırılmış dosya `200`, `Content-Type: application/json`, `Cache-Control: public, max-age=300`; yapılandırılmamış dosya gövdesiz `404` ve `no-store`, böylece sonradan eklenen değer bir sonraki istekte görünür. Başka bir `/.well-known/*` yolu uygulamanın `404` sayfasıdır. Hiçbiri redirect değildir: Android de Apple da yönlendirilen dosyayı kabul etmez. `next.config.ts`'teki genel `Cache-Control: no-store` yalnız `/.well-known/` altında uygulanmaz; diğer güvenlik başlıkları aynen gelir. Değerler istek anında okunur, imajı yeniden kurmak gerekmez; değişken değişince container'ı yeniden başlatmak yeter.

Yalnız kimlik bilgisi ilişkisi yayımlanır. App Links / Universal Links (`handle_all_urls`, `applinks`) bilinçli olarak yoktur: SkyApp'in `my.` bağlantılarını tarayıcıdan devralması ayrı bir karardır ve kod değişikliği ister.

**RP ID notu.** Keycloak'taki passkey RP ID'si `yildizskylab.com`'dur (`KEYCLOAK_PASSKEY_RP_ID`). Android Credential Manager ve iOS `webcredentials` bu dosyaları RP ID alan adında, yani `https://yildizskylab.com/.well-known/…` adresinde arar; `my.` altındaki kopya yalnız `my.yildizskylab.com` için geçerlidir. Kök alan adında da gerekirse ya kökü sunan uygulama aynı içeriği yayımlar ya da Traefik'te ``Host(`yildizskylab.com`) && (Path(`/.well-known/assetlinks.json`) || Path(`/.well-known/apple-app-site-association`))`` router'ı Account Center servisine **redirect değil proxy** olarak bağlanır (route handler `Host` başlığına bakmaz). Bu bir operasyon kararıdır (OPS1b: Mobile Lab'in değerlerini ve kök alan adı proxy'sini bekliyor); değişkenler girilmedikçe dosyalar `my.` altında da `404` döner.

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

Oturuma bağlı bütçeler (Sudo, kimlik, e-posta ve güvenlik işlemleri) ayrıdır ve oturum kimliğiyle anahtarlanır ([mimari](architecture.md#sudo-modu)). Bu anonim bütçeler istemci başınadır. Mod kenar topolojisiyle uyuşmazsa istemci adresi okunamaz, bütün anonim ziyaretçiler tek `unavailable` bucket'ını paylaşır ve platform geneli bir availability sınırı ortaya çıkar; bu yüzden mod dağıtımla birlikte doğrulanır.

## İstek gövdesi sınırı

Edge ve ingress katmanı genel istek gövdesi üst sınırını uygulamalıdır; uygulama içi kontrol bu dış DoS sınırının yerine geçmez. BFF ayrıca `Content-Length` varlığına güvenmeden stream'i byte bazında keser: `/api/auth/backchannel-logout` URL-encoded gövdesi en fazla 16 KiB, `/api/auth/logout` gövdesi en fazla 1 KiB olabilir. Local logout yalnız tam `application/x-www-form-urlencoded` media type'ını kabul eder; multipart, media-type parametresi ve sıkıştırılmış gövde reddedilir. Chunked veya eksik `Content-Length` aynı byte sınırına tabidir. Traefik, varsa Cloudflare ve origin ingress limitleri bu değerlerden düşük olmamalı, fakat genel ürün endpoint'leri için ayrıca makul global üst sınır taşımalıdır.
