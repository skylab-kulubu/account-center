# Mimari sınırlar

## Ürün

Account Center, `my.yildizskylab.com` üzerinde çalışan ayrı bir Next.js ürünüdür. Skyforms’un koyu görsel dili kullanılır; Keycloak Account Console ürün arayüzü olarak kullanılmaz veya embed edilmez.

## Güvenlik modeli

- Browser OIDC Authorization Code + PKCE kullanır; authorization scope tam olarak yalnız `openid` değeridir.
- Tarayıcı yalnız `Secure`, `HttpOnly`, `SameSite=Lax`, domain’siz `__Host-` BFF session cookie taşır.
- Keycloak token’ları şifreli sunucu oturum kaydında kalır.
- Mutation endpoint’leri exact origin ve session-bound CSRF token doğrular.
- Password, OTP ve passkey değişiklikleri sabit allowlist içindeki AIA işlemleridir.
- Native handoff kodu kısa ömürlü, hash’lenmiş ve tek kullanımlıdır; browser’a native token aktarılmaz.
- Account/auth cevapları ve loglar token, cookie, PII, handoff code ve credential id içermez.

Browser cookie’sinde yalnız 256-bit rastgele bir opaque handle bulunur; veritabanında bunun SHA-256 özeti tutulur. Handle ilk mount, beş dakikalık timer, görünürlük ve focus olaylarında sunucuya doğrulatılır; 15 dakika dolduğunda döndürülür ve yarışan istekler için önceki değer yalnız 30 saniyelik grace süresinde kabul edilir. ID token’ın imza doğrulamasından geçmiş `auth_time` claim’i zorunludur. Yerel mutlak deadline, callback anında `min(now + local 8 saatlik cap, auth_time + doğrulanmış OIDC_UPSTREAM_SESSION_MAX_SECONDS)` olarak hesaplanır; geçmiş veya geçersiz deadline session yaratmaz. Idle ömür 30 dakikadır. OIDC transaction bağlamı ve Keycloak token seti kayıt kimliğine bağlı AAD ile AES-256-GCM şifrelenir.

Keycloak backchannel logout RS256/JWKS, issuer, audience, event, `sid|sub`, `iat` ve `jti` doğrulamasından sonra JTI replay kaydını ve session hard-delete işlemini tek PostgreSQL transaction’ında yapar. Local logout session ve token ciphertext’i önce hard-delete eder, varsa refresh token’ı Keycloak revocation endpoint’inde best-effort iptal eder; upstream çağrı başarısız olsa bile yerel erişim ve cookie geri gelmez.

Anonymous login/callback limiti PostgreSQL’de atomiktir. İstemci adresi yalnız güvenilen Cloudflare sınırından alınır ve bellekte normalize edildikten hemen sonra HMAC’lenir; ham IP veritabanına veya loglara yazılmaz. Edge güven varsayımları [ayrı sözleşmede](auth-edge-trust.md) tanımlıdır.

## Üretime açılış blokları

1. Keycloak, SPI ve test fixture’ları doğrulanmış `26.7.4` sürümüne birlikte yükseltilmeli.
2. `account-center` confidential client, PAR, PKCE, backchannel logout ve realm config-as-code tamamlanmalı.
3. Mobile WebView için client-specific browser flow ve `sky-native-handoff` authenticator kurulmalı; köprü orijinal `auth_time` değerini korumalı.
4. Core’da `active/deletion_pending/anonymized` hesap durumu, JIT guard ve cascade güvenli anonimleştirme tamamlanmalı.
5. Core, Forms, CMS ve SkyMail eski JWT’leri ortak access gate ile reddetmeli.

## Hesap silme

Self-delete; yeniden doğrulama, anında erişim engeli ve idempotent queued saga’dan oluşur. Kullanıcı PII’si silinir veya anonimleştirilir. Bilet, check-in, etkinlik medyası ve verilmiş sertifika gibi zorunlu operasyon kayıtları aktif kimlikten ayrılarak korunur. Mevcut cascade-prone fiziksel admin delete akışı kullanılmaz.
