# Mimari sınırlar

## Ürün

Account Center, `my.yildizskylab.com` üzerinde çalışan ayrı bir Next.js ürünüdür. Skyforms’un koyu görsel dili kullanılır; Keycloak Account Console ürün arayüzü olarak kullanılmaz veya embed edilmez.

## Güvenlik modeli

- Browser OIDC Authorization Code + PKCE kullanır; authorization scope tam olarak yalnız `openid` değeridir.
- Tarayıcı yalnız `Secure`, `HttpOnly`, `SameSite=Lax`, domain’siz `__Host-` BFF session cookie taşır.
- Keycloak token’ları şifreli sunucu oturum kaydında kalır.
- Mutation endpoint’leri exact origin ve session-bound CSRF token doğrular.
- Password, OTP ve passkey değişiklikleri sabit allowlist içindeki AIA işlemleridir.
- AIA başlangıcı exact origin, session-bound CSRF ve account-access gate sonrasında server-side PAR ile yapılır. Tarayıcı Keycloak action adı veya credential ID seçemez; removable credential için yalnız session-bound HMAC referansı görür. Callback aynı opaque session, subject, state, nonce, PKCE ve fresh `auth_time` ile bağlıdır. Keycloak başarı durumu ancak taze credential envanterindeki beklenen değişiklikle doğrulanır; token ciphertext ve güncel Keycloak `sid` atomik değiştirilir. UI sonucu hash'lenmiş, session-bound ve tek kullanımlık bir kayıtla taşınır; query parametresi sonuç seçemez.
- Native handoff kodu kısa ömürlü, hash’lenmiş ve tek kullanımlıdır; browser’a native token aktarılmaz.
- Public native kod ile Keycloak’a giden internal bridge kodu ayrıdır. Bridge yalnız PAR gövdesinde taşınır; callback beklenen `sub` ve özgün `auth_time` ile bağlanır. Internal redemption sözleşmesi [ayrı belgede](native-handoff-keycloak-contract.md) tanımlıdır.
- Account/auth cevapları ve loglar token, cookie, PII, handoff code ve credential id içermez.
- OIDC veya native identity doğrulandıktan sonra exact issuer ve subject’in SHA-256 özetiyle dedicated Redis access gate okunur. Contract sentinel eksik/yanlışsa, marker bozuksa ya da Redis deadline aşılırsa kimlik doğrulanmış iş fail-closed 503 olur.

Browser cookie’sinde yalnız 256-bit rastgele bir opaque handle bulunur; veritabanında bunun SHA-256 özeti tutulur. Handle ilk mount, beş dakikalık timer, görünürlük ve focus olaylarında sunucuya doğrulatılır; 15 dakika dolduğunda döndürülür ve yarışan istekler için önceki değer yalnız 30 saniyelik grace süresinde kabul edilir. ID token’ın imza doğrulamasından geçmiş `auth_time` claim’i zorunludur. Yerel mutlak deadline, callback anında `min(now + local 8 saatlik cap, auth_time + doğrulanmış OIDC_UPSTREAM_SESSION_MAX_SECONDS)` olarak hesaplanır; geçmiş veya geçersiz deadline session yaratmaz. Idle ömür 30 dakikadır. OIDC transaction bağlamı ve Keycloak token seti kayıt kimliğine bağlı AAD ile AES-256-GCM şifrelenir.

Keycloak backchannel logout RS256/JWKS, issuer, audience, event, `sid|sub`, `iat` ve `jti` doğrulamasından sonra JTI replay kaydını ve session hard-delete işlemini tek PostgreSQL transaction’ında yapar. Local logout session ve token ciphertext’i önce hard-delete eder, varsa refresh token’ı Keycloak revocation endpoint’inde best-effort iptal eder; upstream çağrı başarısız olsa bile yerel erişim ve cookie geri gelmez.

Anonymous login/callback limiti PostgreSQL’de atomiktir. İstemci adresi yalnız güvenilen Cloudflare sınırından alınır ve bellekte normalize edildikten hemen sonra HMAC’lenir; ham IP veritabanına veya loglara yazılmaz. Edge güven varsayımları [ayrı sözleşmede](auth-edge-trust.md) tanımlıdır.

Opaque session kullanımı iki aşamalıdır: PostgreSQL’den salt-okunur aday subject çözülür, tek Redis `MGET` ile contract ve marker birlikte okunur, yalnız `active` kararından sonra aynı handle atomik olarak yeniden doğrulanıp touch/rotate edilir. `blocked` bütün yerel subject session’larını revoke eder ve cookie’yi güvenli temizlik rotasında sonlandırır. `unavailable` session zamanlarını ve ürün verisini değiştirmez. Local ve backchannel logout bu gate’i atlar; yalnız mevcut session’ı yok eder ve korunan veri açmaz.

## Keycloak Account REST okuma sınırı

Hesap bilgileri yalnız sunucu tarafındaki, `26.7.4` sürümüne sabitlenmiş adaptörden okunur. Adaptör yalnız kullanıcının authorization-code oturumundan gelen, `iss`, `sub`, `azp=account-center`, `scope=openid` ve tek `aud=account` sözleşmesini karşılayan access token’ı kabul eder. Client-credentials/service-account ve `/admin` yolu bu tasarımda yoktur.

Adaptör `/account/`, `/account/credentials`, `/account/sessions` ve isteğe bağlı `/account/sessions/devices` uçlarını kullanır. `/sessions` kanonik listedir; cihaz yanıtı farklı oturumları birleştirebildiği için yalnız işletim sistemi/cihaz etiketi sağlar. Normalize edilen view model yalnız ad, soyad, birincil e-posta, doğrulanma durumu, şifre/OTP/passkey özeti ve oturum zamanı/tarayıcı/cihaz etiketlerini içerir. Keycloak attributes, IP adresleri, credential kimlikleri/verileri, client listeleri, Keycloak session ID’leri ve ham JSON tarayıcıya taşınmaz.

Tekil oturum kapatma, yerel BFF session kimliği ve Keycloak session kimliğine bağlı HMAC referansı üzerinden seçilir. Referans yalnız aynı yerel oturumda tekrar eşleştirilebilir; servis önce kullanıcının kendi kanonik `/sessions` listesini okur, `current=false` kaydı sabit-zamanlı karşılaştırmayla bulur ve yalnız sonra `DELETE /account/sessions/{id}` çağırır. Boş olmayan kanonik listede tam bir `current=true` kaydı zorunludur; sıfır veya birden fazla current kaydı sözleşme sapmasıdır ve referans üretmeden/mutation yapmadan kapanır. Gerçek boş liste kullanılabilir boş durum ve idempotent mutation no-op olarak kalır. Bulunmayan, başka yerel session’a bağlı veya daha önce kapatılmış referans idempotent no-op’tur. Mevcut oturum için referans üretilmez. Diğer tüm oturumlar, aynı current invariant’ı yeniden okunduktan sonra `DELETE /account/sessions` ile kapatılır; Keycloak’ın varsayılan `current=false` davranışı production-clone’da ayrıca kanıtlanmalıdır.

Browser BFF mutation uçları raw `Origin` header’ının yapılandırılmış scheme+host(+port) serialization’ıyla birebir eşleşmesini ve session-bound CSRF proof ister; URL-normalize edilerek eşdeğer görünen path, credentials, trailing slash, case veya alternatif port serialization’ı kabul edilmez. Başarılı mutation sırasında opaque handle dönebilir; yeni `__Host-` cookie yanıta yazılır. Account REST yeniden doğrulama istediğinde yerel session revoke edilir ve cookie temizlenir; PostgreSQL revoke hatası güvenli telemetry üretir fakat 401 yanıtındaki cookie temizliğini engellemez. Diğer cihazdaki Account Center session’larının sonlandırılması Keycloak backchannel logout ile `keycloak_sid` üzerinden mevcut hard-delete sözleşmesine bağlanır.

Access token süresi dolduğunda refresh token yine yalnız şifreli sunucu oturumundan okunur. Yenilenen token aynı sıkı sözleşmeden geçer ve ciphertext optimistic compare-and-swap ile değiştirilir; yarışta kazanan geçerli değer okunur. İlk girişte doğrulanan ID token ve özgün `auth_time` korunur, refresh yerel mutlak oturum ömrünü uzatmaz.

Upstream JSON bilinen alan/tür sözleşmesinden saparsa okuma fail-closed olur. API `application/problem+json`, sayfalar ise aynı güvenli Türkçe durum kartını üretir; upstream gövdesi, alan değeri veya token hata/log metnine eklenmez.

## Üretime açılış blokları

1. Keycloak, SPI ve test fixture’ları doğrulanmış `26.7.4` sürümüne birlikte yükseltilmeli.
2. `account-center` confidential client, PAR, PKCE, backchannel logout ve realm config-as-code tamamlanmalı.
3. Mobile WebView için client-specific browser flow ve `sky-native-handoff` authenticator kurulmalı; köprü orijinal `auth_time` değerini korumalı.
4. Core’da `active/deletion_pending/anonymized` hesap durumu, JIT guard ve cascade güvenli anonimleştirme tamamlanmalı.
5. Core, Forms, CMS ve SkyMail eski JWT’leri ortak access gate ile reddetmeli.
6. Production clone’da SKY LAB kullanıcısıyla profile, credentials, sessions ve devices yanıtları alınarak `tests/fixtures/keycloak-26.7.4-account-*.json` sözleşmesi doğrulanmalı; cihaz endpoint’i yoksa yalnız 404 opsiyonel kabulü kanıtlanmalı. Aynı klonda tekil silmenin sahiplik filtresi/idempotent 204 davranışı, koleksiyon silmenin mevcut oturumu koruması ve ilgili Account Center backchannel logout temizliği de capture edilmelidir.

## Hesap silme

Self-delete; mevcut BFF session'ına bağlı recent reauthentication, Core tarafından kalıcı global engelin doğrulanması, bütün yerel subject session'larının revoke edilmesi ve idempotent queued saga’dan oluşur. Kullanıcı PII’si silinir veya anonimleştirilir. Bilet, check-in, etkinlik medyası ve verilmiş sertifika gibi zorunlu operasyon kayıtları aktif kimlikten ayrılarak korunur. Mevcut cascade-prone fiziksel admin delete akışı, Keycloak Account Console ve `DELETE_ACCOUNT` AIA kullanılmaz.

Core self-service komutu remote-but-owned bir boundary'dir. Account Center route/UI katmanı transport'u bilmez; production HTTP adapter yalnız exact response şemasını ve `platformBlocked=true` onayını kabul eder. Receipt yalnız host-only `Secure HttpOnly SameSite=Lax` cookie'dedir. Normal account layout global block sonrasında erişilemez olduğundan durum ve retry, root-level sessionless `/account-deletion` sayfasında receipt-bound yetkiyle çalışır. Fresh token recovery materyali Core kabulünde scrub edilir; tamamlanan intent kimlik bağlarını taşımaz. Ayrıntılı sözleşme, retention ve rollout kapıları [hesap silme belgesinde](account-deletion.md) yer alır.
