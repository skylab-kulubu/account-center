# Mimari sınırlar

## Ürün

Account Center, `my.yildizskylab.com` üzerinde çalışan ayrı bir Next.js ürünüdür. Skyforms’un koyu görsel dili kullanılır; Keycloak Account Console ürün arayüzü olarak kullanılmaz veya embed edilmez.

## Güvenlik modeli

- Browser OIDC Authorization Code + PKCE kullanır.
- Tarayıcı yalnız `Secure`, `HttpOnly`, `SameSite=Lax`, domain’siz `__Host-` BFF session cookie taşır.
- Keycloak token’ları şifreli sunucu oturum kaydında kalır.
- Mutation endpoint’leri exact origin ve session-bound CSRF token doğrular.
- Password, OTP ve passkey değişiklikleri sabit allowlist içindeki AIA işlemleridir.
- Native handoff kodu kısa ömürlü, hash’lenmiş ve tek kullanımlıdır; browser’a native token aktarılmaz.
- Account/auth cevapları ve loglar token, cookie, PII, handoff code ve credential id içermez.

## Üretime açılış blokları

1. Keycloak, SPI ve test fixture’ları doğrulanmış `26.7.4` sürümüne birlikte yükseltilmeli.
2. `account-center` confidential client, PAR, PKCE, backchannel logout ve realm config-as-code tamamlanmalı.
3. Mobile WebView için client-specific browser flow ve `sky-native-handoff` authenticator kurulmalı; köprü orijinal `auth_time` değerini korumalı.
4. Core’da `active/deletion_pending/anonymized` hesap durumu, JIT guard ve cascade güvenli anonimleştirme tamamlanmalı.
5. Core, Forms, CMS ve SkyMail eski JWT’leri ortak access gate ile reddetmeli.

## Hesap silme

Self-delete; yeniden doğrulama, anında erişim engeli ve idempotent queued saga’dan oluşur. Kullanıcı PII’si silinir veya anonimleştirilir. Bilet, check-in, etkinlik medyası ve verilmiş sertifika gibi zorunlu operasyon kayıtları aktif kimlikten ayrılarak korunur. Mevcut cascade-prone fiziksel admin delete akışı kullanılmaz.
