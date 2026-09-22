# Native handoff ve Keycloak köprü sözleşmesi

Bu belge Account Center BFF ile `sky-native-handoff` Keycloak authenticator arasındaki sürümlü güvenlik sözleşmesidir. Mobile kodu bu repository'de değiştirilmez. BFF yarısı uygulanmış olsa da authenticator, realm flow ve gerçek WebView/AIA testi tamamlanmadan native akış production-ready değildir.

## Dış akış

1. Native uygulama, kendi `skyapp` access token'ını `Authorization: Bearer <JWT>` ile gövdesiz `POST /v1/native-handoff` isteğine koyar. Bir browser `Origin` gönderiyorsa yalnız tam `https://my.yildizskylab.com` ve `Sec-Fetch-Site: same-origin` kabul edilir; native HTTP istemcisi bu iki başlığı göndermez.
2. BFF JWT'yi doğrudan realm JWKS'iyle, yalnız `RS256` kullanarak doğrular. `iss`, audience içinde `account-center`, `azp=skyapp`, `exp`, `sub`, `sid` ve integer/non-future `auth_time` zorunludur.
3. Başarılı cevap yalnız `{ "handoffUrl": "https://my.yildizskylab.com/handoff?code=...", "expiresIn": 45 }` içerir. Kod 32-byte rastgele değerdir; PostgreSQL'de yalnız SHA-256 özeti bulunur ve token ömründen daha uzun yaşayamaz.
4. WebView bu URL'yi üst seviye navigation olarak açar. `/handoff` kodu atomik olarak tek kez tüketir, ayrı bir 32-byte internal bridge code oluşturur ve OIDC Code + S256 PKCE isteğini PAR ile başlatır.
5. `sky_native_handoff=<bridge-code>` yalnız PAR gövdesindedir. Browser authorization URL'sinde yalnız `client_id` ve `request_uri` bulunur; access token, refresh token veya bridge code bulunmaz.
6. OIDC callback, imzalı ID token `sub` ve `auth_time` değerlerini handoff'ta beklenen değerlerle birebir bağlar. Eşleşmezse BFF session oluşturulmaz. Başarıda standart opaque `__Host-sky-account` cookie oluşturulur. Bu session'ın ömrü uygulamadaki ilk girişten değil, köprünün açtığı yeni Keycloak web session'ından (callback anı) başlar: `offline_access` kullanan uygulamanın `auth_time` değeri günlerce eski olabilir. `auth_time` ise değişmeden kalır; Sudo modu ve hesap silme taze giriş kanıtını yine ayrı bir `prompt=login&max_age=0` turundan ister. Aynı yanıt, session ile aynı ömürde yalnız görünüm için `__Host-sky-account-embed=skyapp` çerezini de yazar; hesap sayfaları bu çerez varken mobil üst çubuğu çizmez, çünkü SkyApp WebView'ının kendi header'ı vardır.

`/handoff` query'si uygulama loglarına alınmaz ve cevap `Referrer-Policy: no-referrer` taşır. Cloudflare, ingress, APM ve access-log ayarları bu path'te query string kaydetmeyecek biçimde ayrıca doğrulanmalıdır.

## Internal redemption endpoint

Keycloak authenticator şu sabit endpoint'i çağırır:

```text
POST /internal/v1/native-handoff/redeem
Content-Type: application/json
X-Sky-mTLS-Client-SHA256: <64 lowercase hex>
X-Sky-Timestamp: <unix seconds>
X-Sky-Nonce: <16-64 random bytes, base64url>
X-Sky-Signature: <base64url HMAC-SHA256>

{"code":"<bridge-code>"}
```

İmza girdisi, gövdenin byte-for-byte UTF-8 haliyle şöyledir:

```text
v1\nPOST\n/internal/v1/native-handoff/redeem\n{timestamp}\n{nonce}\n{base64url(sha256(body))}
```

HMAC secret, session ve token encryption key'lerinden farklı, ayrı ve en az 32-byte bir secret'tır. Timestamp en fazla ±30 saniye sapabilir. Nonce canonical, padding içermeyen base64url biçiminde decode edildiğinde 16–64 byte olmalıdır; özeti 60 saniye saklanır. Nonce kaydı ile bridge consume aynı PostgreSQL transaction'ında yürür; aynı imzalı istek veya aynı bridge code için yalnız bir consumer başarılı olabilir. Belirsiz timeout sonrasında aynı bridge code yeniden denenmez; mobile yeni public handoff başlatır.

Endpoint pathname değeri uygulamanın gözlemlediği request URL'den imzaya girer ve tam olarak `/internal/v1/native-handoff/redeem` olmalıdır. Query string taşıyan istekler imza doğru olsa dahi reddedilir; ingress rewrite bu kontrolü gevşetemez.

Başarılı cevap tam olarak şudur:

```json
{"sub":"keycloak-user-id","sid":"original-native-sid","auth_time":1789904700}
```

Başka claim, profil verisi, token veya rol dönmez. Hata cevapları yalnız redacted `invalid_request`, `too_many_requests` veya geçici servis durumudur.

`X-Sky-mTLS-Client-SHA256` yalnız doğrulanmış client certificate'tan internal ingress tarafından yeniden yazılmalıdır. Public ingress bu başlığı silmeli, internal path internete açılmamalı ve Account Center origin yalnız Keycloak'ın sabit egress/mTLS kimliğini kabul etmelidir. Header tek başına mTLS kanıtı değildir.

## `sky-native-handoff` authenticator gereksinimleri

- Realm config-as-code, `skyapp` access token'ına `account-center` audience mapper'ını eklemeli; `azp` değeri `skyapp` olarak kalmalıdır. Başka audience değerleri bulunabilir, fakat `account-center` yoksa BFF token'ı reddeder. Bu mapper Account Center client rolü veya ek scope yetkisi vermez.
- Keycloak `26.7.4` ile derlenmeli ve foundation image'ın aynı dependency setini kullanmalıdır.
- Yalnız `account-center` client'ına atanmış client-specific browser flow'da çalışmalıdır.
- `sky_native_handoff` yoksa normal desktop browser flow'a devam etmelidir. Parametre varsa redemption başarısız olduğunda password formuna düşmemeli; flow güvenli biçimde başarısız olmalıdır.
- Bridge code yalnız authentication-session note içinde kısa süre tutulmalı; event, error, access veya debug loguna yazılmamalı ve kullanımdan sonra silinmelidir.
- Internal endpoint'e yukarıdaki exact body/HMAC sözleşmesiyle ve doğrulanmış client certificate ile bağlanmalıdır.
- Kullanıcı yalnız response `sub` değeriyle realm user store'dan seçilmelidir. `sid`, kullanıcı araması veya hesap seçimi için kullanılmamalıdır. Kullanıcı yoksa veya disabled ise flow reddedilmelidir.
- Authenticator özgün `auth_time` değerini yeni browser SSO context'ine taşımalıdır. BFF callback bu değeri ayrıca doğruladığı için sessizce yeni authentication time üretmek akışı bloke eder.
- Client note/handoff hint bir kez kullanılmalı; invalid, expired, replayed veya subject mismatch durumunda generic hata verilmelidir.
- Token/code/header değerleri Keycloak events, metrics label, traces veya browser'a yansıtılmamalıdır.

## Production kanıtı

Production-clone ortamında gerçek Keycloak browser testi şunları tek akışta kanıtlamalıdır:

1. Valid `skyapp` token yalnız bir public handoff üretir; wrong issuer/audience/azp/alg/expired token reddedilir.
2. İki eşzamanlı `/handoff` tüketicisinden yalnız biri PAR redirect alır.
3. Authenticator internal bridge'i tek kez redeem eder, disabled/unknown kullanıcıyı reddeder ve real Keycloak SSO cookie oluşturur.
4. WebView password ekranı görmeden `my.` oturumuna girer; parola, passkey ve TOTP değişiklikleri WebView'ı terk etmeden Sudo modu ile tamamlanır, yalnız yöntemi olmayan kişinin Microsoft yeniden doğrulaması (`prompt=login&max_age=0`) `my.` callback'e döner.
5. Replay, expiry, HMAC nonce replay, mTLS mismatch ve BFF callback subject mismatch testleri fail-closed geçer.
6. Browser history, redirect URL, storage, source map, Cloudflare/ingress/APM logları access/refresh token veya bridge code içermez.

Bu test ve SPI kurulumu ayrı Keycloak foundation işinin parçasıdır; BFF unit/PostgreSQL testleri gerçek SSO cookie veya yeniden doğrulama davranışının kanıtı değildir.
