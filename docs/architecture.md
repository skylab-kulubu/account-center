# Mimari sınırlar

## Ürün

Account Center, `my.yildizskylab.com` üzerinde çalışan ayrı bir Next.js (App Router, standalone çıktı) ürünüdür. SKY LAB üyesinin kendi hesabıyla ilgili her işi burada yapar: ad ve kullanıcı adı, okul / kişisel / birincil e-posta, parola, passkey, TOTP, oturumlar ve cihazlar, kulüp profili, yetkilerin salt okunur görünümü ve hesap silme. Keycloak Account Console ürün arayüzü olarak kullanılmaz ya da gömülmez; kişi `e.`'ye yalnız ilk girişte, YTÜ Microsoft hesabını bağlarken ve hiçbir yöntemi olmayan kişinin Sudo modu yedeğinde gider (ADR-0041, ADR-0043). Bu belgedeki terimler (Account center, Sudo mode, sky-account SPI, Web handoff, Verified YTÜ account, School/Personal/Primary e-mail, Permissions view, Account erasure, Sign-in session) `skylab-kulubu/e-skylab` deposundaki `CONTEXT.md` sözlüğündendir.

## Katmanlar ve veri kaynakları

| Katman | Görev | Kod |
| --- | --- | --- |
| Next.js sayfaları ve route handler'ları | Arayüz ve HTTP uçları | `src/app`, `src/components` |
| BFF | OIDC (PAR + PKCE), opak oturum, CSRF, Sudo modu, hız sınırı | `src/server/auth` |
| Keycloak (OIDC) | Giriş, token yenileme, çıkış, backchannel logout | [Keycloak sözleşmesi](keycloak-26.7.4-contract.md) |
| Keycloak Account REST | Kişinin kendi profil metaverisi, oturumları, grupları (salt okuma; oturum silme) | `src/server/keycloak-account` |
| sky-account SPI | Ad, kullanıcı adı, e-posta, parola, TOTP, passkey, Sudo token'ı | `src/server/sky-account`, [sky-account-api.md](sky-account-api.md) |
| core API | Kulüp profili (`/v1/users/me`), SkyPass Google Cüzdan (`/v1/skypass/wallet…`) ve hesap silme komutu | `src/server/core`, `src/server/skypass-wallet`, `src/server/account-deletion` |
| PostgreSQL | Şifreli oturum ve token kayıtları, OIDC transaction'ları, JTI replay, hız sınırı, silme niyetleri | `migrations/`, `src/server/*/postgres-repository*.ts` |
| Redis | Platform çapındaki hesap erişim engeli (salt okuma) | `src/server/access-gate` |

Hangi veri nereden gelir: ad, kullanıcı adı, e-postalar ve kimlik bilgileri envanteri sky-account `GET identity`'den; profil metaverisi, oturum listesi ve gruplar Account REST'ten; SKY numarası, öğrenci kartı, telefon, üniversite/fakülte/bölüm, LinkedIn ve fotoğraf core'dan; uygulama yetkileri token'daki `sky_authorization` claim'inden. Yazma yolları: kimlik ve kimlik bilgileri yalnız sky-account SPI (Account REST'te `POST /account` yoktur); kulüp alanları ve fotoğraf core; oturum kapatma Account REST `DELETE`. Tarayıcı veri çağrılarını yalnız `my.` BFF uçlarına yapar; Keycloak'a yalnız giriş, YTÜ bağlama ve Sudo modunun Microsoft yedeği yönlendirmeleriyle, fotoğraflar için core'un medya origin'ine gider.

## Güvenlik modeli

- Tarayıcı OIDC Authorization Code + S256 PKCE + PAR kullanır; authorization scope tam olarak `openid`'dır. Keycloak token'ları tarayıcıya hiç verilmez; PostgreSQL'de AES-256-GCM ile (kayıt kimliğine bağlı AAD) şifreli tutulur.
- Mutation uçları exact `Origin` ve oturuma bağlı CSRF kanıtı (`x-csrf-token`) ister; `Origin` serileştirmesi birebir eşleşmek zorundadır (path, credentials, sondaki `/`, büyük harf ya da başka port kabul edilmez).
- Parolayla giriş Keycloak'ın giriş formundadır (`sky-username-password-form`, K4): kullanıcı adı, birincil e-posta, YTÜ bağlantısı olan hesabın okul e-postası ve kodla doğrulanmış kişisel e-posta kabul edilir. Account Center'ın kodu bunu ayırt etmez; OIDC akışı aynıdır ([Keycloak sözleşmesi](keycloak-26.7.4-contract.md#giriş-formu-k4)).
- Hassas işlemler Sudo modu ister ([aşağıda](#sudo-modu)); oturumun `auth_time` değeri ya da girişin tazeliği Sudo yerine geçmez.
- Keycloak'a yalnız iki özel istek türü gider: Sudo yedeği için zorunlu yeniden doğrulama (`prompt=login&max_age=0`) ve YTÜ hesabı bağlama (`kc_action=idp_link`, tek ve dar bir allowlist; başka hiçbir `kc_action` PAR gövdesine giremez). Ayrıntı: [Keycloak sözleşmesi](keycloak-26.7.4-contract.md#zorunlu-yeniden-doğrulama-ve-tek-application-initiated-action-idp_link).
- Kaldırılabilir kimlik bilgileri ve başka oturumlar tarayıcıya yalnız oturuma bağlı HMAC referansıyla görünür; referans her seferinde taze bir okumaya karşı sabit-zamanlı karşılaştırmayla çözülür. Credential kimlikleri ve Keycloak oturum kimlikleri tarayıcıya çıkmaz.
- Cevaplar ve loglar token, cookie, kişisel veri, handoff kodu, credential kimliği, parola, kod, assertion ya da attestation içermez (`src/server/auth/logging.ts` anahtar adına göre karartır).
- Güvenlik başlıkları `next.config.ts`'te (COOP/CORP `same-origin`, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `nosniff`), `Cache-Control: no-store` `/.well-known` dışında varsayılandır. İstek başına nonce'lu CSP `src/proxy.ts`'tedir: `form-action 'self' https://e.yildizskylab.com`, `frame-ancestors 'none'`, `img-src` yalnız `PROFILE_PICTURE_ORIGIN`'i (varsayılan `https://cdn.yildizskylab.com`) ek olarak tanır.

## Oturum ve çerezler

Tarayıcıda yalnız `Secure`, `HttpOnly`, domain'siz `__Host-` çerezleri bulunur (`SameSite=Lax`; yalnız silme makbuzu `Strict`):

| Çerez | İçerik / ömür |
| --- | --- |
| `__Host-sky-account` | 256-bit rastgele opak oturum tutamağı; veritabanında yalnız SHA-256 özeti. Oturumun mutlak bitişine kadar. |
| `__Host-sky-account-txn` | Giriş / Sudo yedeği / YTÜ bağlama transaction'ının tarayıcı bağı; sunucudaki transaction'la aynı 15 dakika (`OIDC_TRANSACTION_TTL_SECONDS`). PAR `request_uri` ömrü (`expires_in`, 60 sn) yalnız Keycloak'a yönlendirmeyi sınırlar, bu süreyi kısaltmaz; 15 dakika realm'in giriş zaman aşımının (`accessCodeLifespanLogin`, 30 dk) içindedir. |
| `__Host-sky-account-embed` | Yalnız SkyApp WebView görünümü; claim'siz yeni girişte ve çıkışta silinir. [Web handoff](web-handoff.md). |
| `__Host-sky-account-delete-proof` (`Lax`), `__Host-sky-account-delete-receipt` (`Strict`) | Hesap silme akışı; [hesap silme](account-deletion.md). |

Oturum kuralları: tutamak ilk açılışta, beş dakikalık zamanlayıcıda, görünürlük ve odak olaylarında `POST /api/auth/session/refresh` ile sunucuya doğrulatılır; 15 dakikada bir döndürülür ve yarışan istekler için önceki değer yalnız 30 saniye kabul edilir. Boşta ömür 30 dakikadır. Mutlak bitiş callback anında `min(şimdi + min(8 saat, OIDC_UPSTREAM_SESSION_MAX_SECONDS), Keycloak oturumunun bitişi)` olarak hesaplanır (bitiş: imzalı `sky_session_expires`, yoksa başlangıç + `OIDC_UPSTREAM_SESSION_MAX_SECONDS`; [Keycloak sözleşmesi](keycloak-26.7.4-contract.md#oturum-ömrü-claimleri)); geçmiş ya da geçersiz bitiş oturum yaratmaz. Token yenilemesi yerel mutlak ömrü uzatmaz; yenilenen token seti aynı sıkı sözleşmeden geçer ve ciphertext optimistic compare-and-swap ile yazılır.

Başarısız giriş `oidc_login_failed` olarak loglanır: `reason`, varsa `providerStage`, transaction okunabildiyse akışı (`purpose`: `login`, `sudo`, `ytu_link`; süresi dolmuş, kullanılmış ya da başka tarayıcının transaction'ında yoktur) ve callback bir OAuth `error` taşıyorsa onun izin listesinden geçmiş değeri (`oauthError`: `access_denied`, `login_required`, `interaction_required`, `consent_required`, `temporarily_unavailable`, `server_error`, `invalid_request`, `unauthorized_client`, `invalid_scope`, başka her şey `other`). `error_description` loglanmaz.

Çıkış: yerel çıkış (`POST /api/auth/logout`) oturum ve token kaydını önce hard-delete eder, varsa refresh token'ı Keycloak'ta best-effort iptal eder; upstream başarısız olsa bile yerel erişim geri gelmez. Keycloak backchannel logout JTI replay kaydını ve oturum silmeyi tek PostgreSQL transaction'ında yapar. Anonim `login`/`callback` hız sınırı PostgreSQL'de atomiktir; istemci adresi yalnız `AUTH_TRUSTED_PROXY` ile seçilen güvenilen kenardan alınır ve hemen HMAC'lenir ([kenar güveni](auth-edge-trust.md)).

## Hesap erişim engeli (Redis)

OIDC kimliği doğrulandıktan sonra ve her oturum kullanımında, issuer ve subject'in SHA-256 özetiyle adlanan marker, ayrılmış bir Redis'ten **tek `MGET`** ile contract sentinel'iyle birlikte okunur (`ACCOUNT_ACCESS_GATE_MODE=enforce`; Account Center Redis'e yalnız `MGET`/`GET` ile okur ve hazırlık sorgusu için `INFO` gerektirmez: bağlantıyı contract anahtarını okuyarak kanıtlar). Contract sentinel eksik ya da yanlışsa, marker bozuksa ya da Redis deadline'ı (`ACCOUNT_ACCESS_REDIS_OPERATION_TIMEOUT_MS`) aşılırsa karar `unavailable`'dır ve kimlik doğrulanmış her iş `503` ile kapanır. `blocked` karar bütün yerel subject oturumlarını revoke eder ve cookie'yi güvenli temizlik rotasında sonlandırır. Yerel çıkış ve backchannel logout bu kapıyı atlar: yalnız mevcut oturumu yok ederler. Oturum kullanımı iki aşamalıdır: PostgreSQL'den salt-okunur aday çözülür, kapı sorulur, yalnız `active` ise tutamak atomik olarak yeniden doğrulanıp dokunulur/döndürülür. `ACCOUNT_ACCESS_GATE_MODE=off` kapıyı devre dışı bırakır (her karar `active`) ve CI ile geliştirme içindir; `ACCOUNT_ERASURE_MODE=enforce` yalnız `enforce` ile başlar.

## Keycloak ve token sözleşmesi

Account Center service account ya da Admin REST kullanmaz. Oturumdaki kullanıcı access token'ı pinli sözleşmeyi (`azp=account-center`, `scope=openid`, `aud` kümesi, `manage-account` + `view-profile`, core rolü yok) karşılamadan hiçbir upstream çağrısı yapılmaz. `aud` tam olarak `{account, core}` olmalıdır; K2 geçişinde kabul edilen eski `{account}` kümesi A0c ile kaldırıldı ve reddedilir: bkz. [Keycloak sözleşmesi](keycloak-26.7.4-contract.md#kullanıcı-access-token-sözleşmesi). Account REST adaptörü yalnız `GET`/`DELETE` yapar, yanıtta bilinen alan/tür sözleşmesinden sapma fail-closed olur (API `application/problem+json`, sayfalar güvenli Türkçe durum kartı).

## sky-account SPI istemcisi

`src/server/sky-account/client.ts`, taban `${OIDC_ISSUER}/sky-account/v1`: aynı kullanıcı access token'ı bearer, hassas uçlarda `X-Sky-Sudo`. Çağrılar yeniden denenmez; 10 saniyelik zaman aşımı, 64 KB yanıt sınırı, yalnız HTTPS issuer. Başarı yanıtlarında **belgelenmiş her üye sıkı doğrulanır, bilinmeyen üyeler yok sayılır** (eklemeli SPI sürümleri BFF'yi kapatmaz); RFC 7807 hataları sabit `code` tablosuna göre `SkyAccountProblem` olarak eşlenir, tabloda olmayan kod ya da durum uyuşmazlığı sözleşme hatasıdır. İstek ve yanıt gövdeleri hiçbir hata mesajına ya da loga girmez. İstemci yalnız `docs/sky-account-api.md`'deki sürüm 1'e yazılmıştır; kanonik kopya e-skylab-keycloak deposundadır.

## Sudo modu

Hassas bir işlemden (parola, passkey, TOTP, e-posta, kullanıcı adı, YTÜ bağlama, hesap silme) önce kişi kim olduğunu `my.` içinde yeniden kanıtlar: parola, passkey ya da doğrulama kodu; hiçbiri yoksa Microsoft ile yeniden giriş. Kanıt beş dakika geçerlidir. Akış `src/server/auth/sudo-routes.ts` ve `src/app/api/account/sudo/*` altındadır:

| Uç | Gövde | Başarı | Not |
| --- | --- | --- | --- |
| `GET /api/account/sudo/methods` | — | `{ methods, fallback, active, csrfToken }` | `methods` sky-account `GET identity.credentials`'tan (`password`, `passkey` yalnız `webauthn-passwordless`, `totp`; sekme sırasıyla); `fallback: "microsoft"` yalnız hiçbiri yokken; `active` taze kanıtın yöntemi ve bitişi. Etiket ya da kimlik bilgisi id'si taşımaz. |
| `POST /api/account/sudo/password` | `{ password }` (JSON, ≤ 2 KB) | `{ method, expiresAt }` | SPI `POST sudo/password` |
| `POST /api/account/sudo/totp` | `{ code }` (4-10 rakam, boşluklar atılır) | `{ method, expiresAt }` | SPI `POST sudo/totp` |
| `POST /api/account/sudo/webauthn/options` | — | SPI'nin assertion seçenekleri | tarayıcı `navigator.credentials.get()` çalıştırır |
| `POST /api/account/sudo/webauthn/verify` | `{ assertion }` (≤ 64 KB) | `{ method, expiresAt }` | yalnız sudo sözleşmesinin üyeleri iletilir (`id`, `rawId`, `type`, `response`); `authenticatorAttachment` ve istemci uzantı sonuçları düşer |
| `POST /api/account/sudo/reauthenticate` | form: `csrfToken`, `returnTo` | `303` → Keycloak | Microsoft yedeği; yalnız yöntemi olmayan kişi için |

Yazma uçları sırayla exact `Origin`, CSRF, erişim kapısı ve oturum doğrulaması yapar; ardından oturum başına yerel bütçe tüketilir (parola ve TOTP için ortak `sudo` 10, passkey için SPI'nin `sudo-passkey` bütçesi gibi ayrı `sudo_passkey` 10, `sudo_options` 30 istek / 15 dk; `account_auth_rate_limits`'te HMAC'lenmiş oturum kimliğiyle), gövde ayrıştırılır ve SPI çağrılır. Brute-force sayacı ve kilit Keycloak'tadır; yerel bütçe yalnız SPI bütçesini korur. Hata eşlemesi: `invalid_credentials` / `webauthn_invalid` / `webauthn_origin_not_allowed` → `401 invalid_credentials`; `user_temporarily_locked` → `423 locked`; `user_disabled` → `403 disabled`; `rate_limited` → `429` + `Retry-After`; `password_not_configured` / `totp_not_configured` / `passkey_not_registered` → `400 method_unavailable`; `webauthn_challenge_expired` → `400 challenge_expired`; `webauthn_not_configured` / `unmanaged_attributes_enabled` → `503 unavailable` + `Retry-After: 60`; sözleşme dışı yanıt → `502 upstream_error`; ulaşılamayan SPI → `503` + `Retry-After: 3`. Bearer'ın reddi (yenilenemeyen token, SPI `unauthorized`) yerel oturumu iptal eder ve `401` ile cookie'yi temizler.

**Saklama.** Sudo token Keycloak'ın verdiği opak bir JWT'dir ve tarayıcıya verilmez. `SudoVault` (`src/server/auth/sudo.ts`) onu yöntem etiketiyle (`password`/`totp`/`passkey`/`reauth`) birlikte `session:<id>:sudo` AAD'siyle AES-256-GCM şifreleyip `account_sessions.sudo_token_ciphertext` ve `sudo_expires_at` sütunlarına yazar (migration `0006`; iki sütun birlikte boş ya da dolu). Yerel ömür en çok 15 dakikadır (SPI beş dakikalık token verir); bitişine 5 saniyeden az kalan kanıt verilmez. Şifresi çözülemeyen ya da yöntemi tanınmayan materyal atılır. Süresi dolan kanıtları saatlik prune işi aktif oturumlardan da siler.

**Kapı.** Mutation uçları `requireAccountSudo` / `requireAccountSpiSudo` (`src/server/auth/sudo-gate.ts`) ile taze kanıt ister; yoksa `428 { error: "sudo_required", reason: "missing" | "expired", methods, fallback }` döner. SPI'ye `X-Sky-Sudo` sunacak uçlar SPI kapısını kullanır: token'sız bir `reauth` kanıtı `428 reason: "spi_token_required"` ile reddedilir ve silinir. SPI kaydedilmiş kanıtı reddederse (`sudo_required` / `sudo_expired`) yerel kopya silinir ve aynı `428` `reason: "expired"` ile döner. Yöntem listesi yalnız kapı gerektiğinde `GET identity` ile çözülür; kimlik hizmeti okunamıyorsa hata çağırana geçer (boş liste kişiye yanlış yönlendirirdi).

**Microsoft yedeği.** Parolası, passkey'i ve TOTP'si olmayan kişi `POST /api/account/sudo/reauthenticate` ile `prompt=login&max_age=0` akışına gider; yöntemi olan kişi `409 method_available` alır, yöntemler okunamıyorsa kapalı-güvenli (`503` / `?sudo=unavailable`). Transaction `sudo-reauthentication` amaçlı, mevcut oturuma ve başlangıç anına bağlı, tek kullanımlıktır; `returnTo` sabit allowlist'ten geçer. Callback imzalı `auth_time` değerinin işlemi başlatma anından eski olmadığını doğrular, token setini değiştirir ve **taze ID token'ı** sky-account `POST sudo/authentication`'a sunar (`src/server/auth/sudo-reauthentication.ts`); dönen sudo token `reauth` yöntemiyle SPI'nin verdiği bitişe kadar saklanır. ID token yalnız bu çağrıda kullanılır; saklanmaz, loga ya da adrese girmez. SPI kanıtı kabul etmezse (`stale`, `refused`, `unavailable`, `contract`; `sudo_authentication_failed` olayı) token'sız, `auth_time + 5 dk` bitişli bir `reauth` kanıtı yazılır: yalnız `my.` içindeki yerel kapıları karşılar, SPI ve core `X-Sky-Sudo` beklediği için o mutation'lar onu `428 spi_token_required` ile reddeder. Sayfaya `returnTo?sudo=confirmed|cancelled|unavailable` ile dönülür; adres parametresi yerel olarak Sudo saymaz, tarayıcı gerçek durumu `GET methods`'taki `active` alanından öğrenir.

**Tarayıcı.** `SudoProvider` (`src/components/sudo-provider.tsx`, hesap layout'unda) `useSudo().ensureSudo()` ile `SudoDialog`'u açar; diyalog yalnız var olan sekmeleri (Parola · Passkey · Doğrulama kodu) gösterir, sunucu taze bir kanıt bildiriyorsa açılmaz, `423`/`429`'da bekleme süresini yazar, yöntem yoksa Microsoft formunu sunar. Bir mutation `428` döndürürse sayfa sağlayıcının hafızasını düşürüp diyaloğu yeniden açar ve isteği bir kez yeniden dener (`runWithSudo`, `src/lib/security-client.ts`). Parola ve kod bellekte yalnız gönderim anına kadar tutulur.

## Sayfalar ve uçlar

| Sayfa | Veri | Uçlar (`/api/account/…`) | Ayrıntı |
| --- | --- | --- | --- |
| `/` Özet | Account REST profil + kimlik bilgisi özeti (sunucuda okunur) | yok | — |
| `/identity` Kimlik | sky-account `GET identity` | `identity`, `identity/name`, `identity/username`, `identity/ytu-link` | [account-actions.md](account-actions.md) |
| `/email` E-posta ve giriş | sky-account `email/*` | `email`, `email/pending`, `email/change-request`, `email/confirm`, `email/primary`, `email/personal`, `email/nudge/dismiss` | [account-actions.md](account-actions.md) |
| `/club-profile` Kulüp profili | core `/v1/users/me`, `/v1/skypass/wallet` | `club-profile`, `club-profile/picture`, `skypass/wallet/google` | [aşağıda](#kulüp-profili) |
| `/security` Giriş ve güvenlik | sky-account `GET identity` + kimlik bilgisi uçları | `security`, `security/password`, `security/totp/*`, `security/passkeys/*`, `security/credentials/{reference}` | [account-actions.md](account-actions.md) |
| `/sessions` Oturumlar ve cihazlar | Account REST `sessions` | `sessions`, `sessions/{reference}` | [aşağıda](#oturumlar-ve-cihazlar) |
| `/permissions` Yetkilerim | `sky_authorization` + Account REST `groups` | yok (salt okunur) | [aşağıda](#yetkilerim) |
| `/delete-account` Hesabı sil | core silme komutu | `deletion/prepare`, `deletion`, `deletion/status`, `deletion/status/retry` | [account-deletion.md](account-deletion.md) |

`/personal-information` kalıcı olarak (308) `/identity`'ye yönlenir (`next.config.ts`; proxy'den önce çalışır). `/login` ve `/account-deletion` oturumsuz erişilebilen tek sayfalardır. Sayfalar sunucuda yalnız kabuğu üretir; `/identity`, `/email` ve `/security` verisini tarayıcıda ilgili uçlardan okur ve her değişiklikten sonra yeniden okur (liste sunucunun envanteridir, mutation yanıtı değil).

### Kulüp profili

`/club-profile` ve `GET/PATCH /api/account/club-profile`, `POST/DELETE /api/account/club-profile/picture` (`src/server/club-profile`) core'a kişinin kendi kullanıcı token'ıyla gider: token `aud` kümesinde `core` vardır ve core rolü taşımaz; sızan bir token yalnız kişinin kendi `/v1/users/me` uçlarına ulaşır. Taşıma kuralları hesap silme gateway'iyle aynıdır (canonical HTTPS `CORE_API_URL`, 5 sn / yükleme 15 sn zaman aşımı, yeniden deneme yok, yalnız durum kodu eşlemesi, üst servis gövdesi hata ve loga girmez). `CORE_API_URL` tanımsızsa istemci kurulmaz, sayfa kapalı olduğunu söyler ve kimlik özetini Account REST'ten gösterir. Core'un 401'i yerel oturumu sonlandırmaz (token bir kez zorla yenilenip tekrar denenir; yine reddedilirse sayfa yeniden giriş bağlantısı gösterir); Keycloak oturumunun yenilenememesi sonlandırır.

Yazma uçları exact `Origin`, CSRF ve erişim kapısı ister, **Sudo modu istemez** (kulüp verisi, kimlik bilgisi değil). Ad/soyad bu sayfadan yazılamaz; telefon, SKY numarası ve öğrenci kartı salt okunurdur ve gövdede görünürlerse `400`. Üniversite/fakülte/bölüm kırpılmış, kontrol/biçimlendirme/satır ayırıcı karakter içermeyen ve en çok 120 karakter; LinkedIn `https://` ile başlayan, host'u tam olarak `linkedin.com` ya da `www.linkedin.com` olan, kimlik bilgisi ve port içermeyen, en çok 200 karakterlik URL'dir (boş değer bağlantıyı siler; kayıt `new URL(value).href` ile). PATCH önce core'daki profili okur (`GET /v1/users/me`) ve yalnız değişen alanları `PATCH` eder; değişiklik yoksa core'a yazmaz (`changed: false`). **YTÜ'ye bağlı** kişide (core'un `ytuLinked`'i; kimin bağlı olduğuna yalnız core karar verir) üniversite, fakülte ve bölüm YTÜ girişinden gelir: sayfa onları "YTÜ hesabından gelir" rozetiyle salt okunur gösterir ve BFF bu alanları değiştiren PATCH'i core'a yazmadan `409 club-profile-ytu-managed` ile reddeder.

Fotoğraf: tarayıcı `image/png|jpeg|webp` kabul eder, 5 MB üstünü göndermeden reddeder ve `blob:` önizleme gösterir. BFF gövdeyi 5 MB + 64 KB çerçeve payıyla sınırlı okur, multipart'tan yalnız `file` alanını alır, türü beyan edilene değil sihirli baytlara göre belirler ve core'a o türle iletir. Her iki işlemden sonra profil core'dan yeniden okunur; tarayıcıya yalnız görünüm alanları döner (core kimlikleri, medya kimliği ve gölge adlar dönmez). Fotoğraf URL'si core'un medya origin'indedir (`PROFILE_PICTURE_ORIGIN`).

#### SkyPass Google Cüzdan

Sözleşme core'da: `docs/skypass-google-wallet.md`. Sayfa profil okunduktan sonra, aynı token'la `GET /v1/skypass/wallet` okur; bölüm yalnız `google.available` doğruyken görünür (kapalı, okunamayan ya da reddedilen durumda sessizce gizlenir; core'un kapalı olduğunu kulüp profili bandı zaten söyler). `issued` "Pas etkin / Pas yok" rozetidir ve "Cüzdandan kaldır" yalnız pas varken çıkar.

`POST /api/account/skypass/wallet/google` core'dan `saveUrl` alır ve `no-store` ile yalnız soran tarayıcıya döner; `DELETE` aynı yolda pası bitirir (`204`). İkisi de yazma ucu gibi exact `Origin`, CSRF ve erişim kapısı ister, Sudo modu istemez (core'un kendisi de kişinin token'ından fazlasını istemez). Core'a giden istek 25 sn'de kesilir (core'un Google çağrıları 20 sn'lik tek süre paylaşır). Core yanıtları `code` ile eşlenir: `503 skypass_google_wallet_off`, `409 skypass_wallet_pass_ended` (bağlantı yazılırken pas bitti), `429 skypass_wallet_rate_limited` (`retryAfterSeconds` + `Retry-After`), `502 skypass_google_wallet_unavailable`.

`saveUrl`'in süresi yoktur ve onu ilk kaydeden pası alır; bu yüzden BFF onu loglamaz, hataya koymaz, saklamaz ve yalnız `https://pay.google.com/gp/v/save/<JWS>` biçimindeyse iletir (aynı denetim tarayıcıda da yapılır: `src/lib/skypass-wallet.ts`). Tarayıcı tıklamanın içinde boş bir sekme açar (`opener` kaldırılır, `Referrer-Policy: same-origin`), istek bitince o sekmeyi `location.replace(saveUrl)` ile Google'a yollar; hata olursa sekmeyi kapatır. Tarayıcı yeni sekmeye izin vermezse aynı sekme Google'a gider. Bağlantı React durumuna, DOM'a, sorgu dizesine ya da depolamaya hiç girmez. Düğme Google'ın "Google Cüzdan'a ekle" görselidir (`public/google-wallet/`, marka kurallarına göre değiştirilmeden, en az 48 px).

### Oturumlar ve cihazlar

Tekil kapatma Account REST oturum kimliğine değil, yerel oturum kimliği ve Keycloak oturum kimliğine bağlı HMAC referansına dayanır; kurallar [Keycloak sözleşmesinde](keycloak-26.7.4-contract.md#oturum-silme). Başka bir oturumu kapatmak Sudo modu istemez ve exact `Origin` + CSRF ile `DELETE /api/account/sessions/{reference}` (tekil) ya da `DELETE /api/account/sessions` (mevcut oturum dışındakiler) çağırır.

### Yetkilerim

`/permissions` salt okunur bir sayfadır; Account Center içinde hiçbir yetki kararı vermez. İki kaynaktan beslenir: Account REST grupları (grup yolu ve `display_name_tr`, `public_listing`, `team_door_scan` öznitelikleri) ve doğrulanmış kullanıcı token'ındaki `sky_authorization` claim'i (istemci → istemci rolleri). `src/server/permissions/view-model.ts` bunlardan takımları (`/UYELER/...` altındaki gruplar; `LIDERLER` ya da `KOORDINATORLER` alt grubu o takımda liderlik/koordinatörlük), yetki seviyesini (`ADMIN`/`YK`/`DK` üyeliği: Yönetim, Yönetim Kurulu, Denetim Kurulu) ve uygulama yetkilerini türetir. Rol kodları `src/config/permission-catalog.ts` içindeki elle bakımlı Türkçe katalogla etiketlenir; katalogda olmayan kodlar ve ham grup yolları yalnız katlanmış "Teknik ayrıntılar" bölümünde görünür, Keycloak'ın kendi istemcilerinin (`account`, `realm-management`, `broker`…) ve realm rolleri hiç gösterilmez. Grup okuması başarısız olursa sayfa token'dan gelen yetkileri yine gösterir ve takım bölümünde uyarı verir; token okunamıyorsa tek durum kartı döner. Değişiklikler superadmin'de yapılır.

## Hesap silme

Self-delete: kişinin `my.` içinde verdiği Sudo modu kanıtı, core'un kalıcı global engeli doğrulaması, bütün yerel subject oturumlarının revoke edilmesi ve core'un kuyruklu, idempotent silme saga'sı. Akışı core yönetir (ADR-0051); Account Center yalnız isteği gönderir ve ilerlemeyi gösterir. `ACCOUNT_ERASURE_MODE=off` iken (bugünkü production değeri) silme uçları Core'a hiçbir şey göndermeden yanıt verir: yanlış `Origin` önce `403` alır; `POST /api/account/deletion` HTML gezintisinde `/delete-account?deletionError=deletion_unavailable` adresine `303`, aksi hâlde `503` döner; `prepare`, `status` ve `status/retry` `503` döner (hepsinde `Retry-After: 60`). `/delete-account` yalnız sonuçları ve "Silme akışı henüz etkin değil" notunu gösterir. Sözleşme, kanıt, kurtarma ve açılış kapıları [hesap silme belgesindedir](account-deletion.md).

## Web handoff ve kenar yolları

SkyApp'ten `my.`'ye oturum açık geçiş Keycloak'taki Web handoff'tur (`sky-handoff`, ADR-0048); `my.` sıradan bir hedeftir. Emekli native handoff uçları `404` döner: [web-handoff.md](web-handoff.md). `/internal/*` her istekte oturumdan önce gövdesiz `404` alır, `/.well-known/*` giriş yönlendirmesinden muaftır ve `assetlinks.json` ile `apple-app-site-association` ortam değişkenlerinden üretilir: [auth-edge-trust.md](auth-edge-trust.md).

## Veritabanı ve bakım

Migration'lar `scripts/migrate.mjs` ile sırayla uygulanır (`account_center_schema_migrations`, advisory lock): `0001` oturumlar ve OIDC transaction'ları, `0002` JTI replay ve hız sınırı, `0003` emekli native handoff tabloları, `0004` `account_action_results`, `0005` ve `0007` silme niyetleri ve onay kaydı, `0006` Sudo sütunları, `0008` native handoff tablolarını kaldırır, `0009` kişinin kapattığı e-posta önerilerini (K4c, `account_notice_dismissals`) tutar. `0004` tablosu hiçbir kod yolunda yazılmaz (parola/TOTP/passkey artık SPI ile yapılır); readiness onu hâlâ aradığı için tablo yerinde durur. `scripts/prune-auth.mjs` (`pnpm db:prune-auth`) saatlik, tekil bir işle süresi dolmuş transaction, oturum, replay, hız sınırı, silme niyeti ve Sudo kanıtını temizler ([saklama kılavuzu](auth-retention-runbook.md)). `/api/health` yalnız proses canlılığını; `/api/ready` ortam yapılandırmasının ayrıştırılabildiğini, PostgreSQL tablolarını ve sudo sütunlarını, `0001`-`0007` ve `0009` migration kayıtlarını ve erişim engeli sentinel'ini doğrular (`0008` şart değildir).

## Açık işler

- **K4b**: parola sıfırlamanın (reset credentials) de okul ya da kişisel adresi tanıması devam ediyor (e-skylab-keycloak; [rollout-v2.md](rollout-v2.md#bekleyen-işler)).
- **Hesap silme açılışı** (`ACCOUNT_ERASURE_MODE=enforce`): core'un diğer servislere silme komutları ve kapılar tamamlanınca ([account-deletion.md](account-deletion.md#account_erasure_mode-ve-açılış-kapıları)).
- Mobil `/.well-known` değerleri (Mobile Lab) ve kök alan adı proxy'si (OPS1b).
