# Hesap silme sözleşmesi

## Akış

Hesap silme, Keycloak Account Console veya `DELETE_ACCOUNT` AIA işlemi değildir. `/delete-account` sayfası kişiyi sırayla şu adımlardan geçirir:

1. **Niyet.** Sonuçlar okunduktan sonra "Hesabımı silmek istiyorum" denir. Bu ana kadar hiçbir uç çağrılmaz.
2. **Sudo modu.** Sayfa `useSudo().ensureSudo()` ile ürün içi doğrulama diyaloğunu açar: parola, passkey ya da doğrulama kodu; hiçbiri yoksa Microsoft yedeği (bkz. [Sudo modu](architecture.md#sudo-modu)). Diyaloğun sonucu tarayıcının kararı değildir: hem `POST /api/account/deletion/prepare` hem de `POST /api/account/deletion` kapıyı sunucuda `requireAccountSpiSudo` ile yeniden uygular; `X-Sky-Sudo` gönderen her uçla aynı kapıdır. Taze proof yoksa yanıt `428 sudo_required`, tarayıcı gezintisinde `/delete-account?deletionError=sudo_required` olur ve akış birinci adıma döner. Sky-account token'ı taşımayan bir `reauth` proof'u (Microsoft yedeğinin `POST sudo/authentication` çağrısı başarısız olmuşsa kalan nadir durum) `428 spi_token_required` ile reddedilir ve kasadan silinir: Core onu doğrulayamaz.
3. **Onay metni.** `HESABIMI SİL` birebir yazılır.
4. **Gönderim.** Form `POST /api/account/deletion` ucuna gider.

İkinci ve üçüncü adım arasında `POST .../deletion/prepare` (exact `Origin`, `x-csrf-token`, access gate, oturum, sudo) intenti oluşturur: Account REST access token'ı ile oturumun Sudo modu kasasındaki (`SudoVault`) sudo token'ı intentin şifreli recovery zarfına yazılır, proof ve yerel receipt cookie'leri set edilir. Yanıt yalnız `{ "step": "confirm" }` taşır; subject, token ya da Keycloak ayrıntısı taşımaz. Keycloak'a gidilmez. Silmeye özel `prompt=login&max_age=0` hop'u (`POST /api/account/deletion/reauthenticate`, `account-deletion-reauthentication` OIDC amacı ve `planDeletionReauthentication`) A7b ile kaldırıldı; parolası, passkey'i ya da TOTP'si olmayan kişinin Microsoft yedeği genel Sudo modunun parçasıdır (`POST sudo/authentication`, yöntem `authentication`). Kaldırılan hop'un sürüm öncesinde başlatılmış bir transaction'ı callback'te reddedilir.

Intentin tazelik penceresi sudo token'ın kendi `exp` değerinden gelir: `min(sudo expiresAt − 5 sn, şimdi + 5 dk)`. Beş saniye, kasanın proof'u dağıtırken bıraktığı paydır; böylece ne onay ne de recovery tekrarı Core'a süresi dolmuş bir token sunar. Pencere dolmuşsa `prepare` yine `428` döner ve diyalog yeniden açılır.

### Core'a giden kanıt

Onay metni girildikten sonra BFF, Core'un dar self-service intake ucuna yalnız şunları yollar:

- `Authorization: Bearer <Account REST access token>`;
- `X-Sky-Sudo: <sky-account sudo token>`. BFF token'ı opak bir dize olarak taşır ve içine bakmaz. Core onu realm introspection'ıyla doğrular: `typ=sky-sudo`, realm `iss`, `azp=account-center`, `aud` içinde hem `sky-account` hem `core` (K3e), bearer ile aynı `sub` ve `sid`, gelecekte `exp`. Bu yolda `auth_time` kuralı yoktur; tazelik token'ın beş dakikalık ömründen gelir;
- 256-bit `Idempotency-Key`.

`X-Account-Reauth-Token` (taze ID token) artık gönderilmez. Core iki başlık birlikte gelirse yalnız sudo token'a bakar; ID token'ı eklemek hiçbir şey kanıtlamaz, yalnız yola ikinci bir kimlik bilgisi koyar. Core eski başlığı geri dönüş için bir süre daha kabul eder. Subject request body/header'dan alınmaz. Core kalıcı global access-gate marker'ını doğrulamadan başarılı yanıt veremez. Başarıdan sonra Account Center aynı yerel subject'e ait bütün session'ları, intentteki güvenilir session kimliği üzerinden revoke eder; ancak bundan sonra silme durumuna yönlendirir.

Core'un cevapları şöyle karşılanır:

- **`401 invalid_end_user_token`**: Core kanıtı reddetti. Sudo token'ın süresi dolmuş, Keycloak oturumu kapanmış ya da token başka bir oturumun olabilir; bearer'ın reddi de aynı koddur ve çaresi aynıdır. Kimlik bilgileri her şeyden önce doğrulandığı için hiçbir şey kabul edilmemiştir. BFF sudo proof'unu kasadan siler (SPI'nin reddettiği proof'larla aynı kural), proof cookie'sini temizler ve sayfayı `/delete-account?deletionError=sudo_rejected` adresine gönderir: "Silme isteğin için kimlik doğrulaman kabul edilmedi ya da süresi doldu. Hesabında hiçbir değişiklik yapılmadı. Devam etmek için kimliğini yeniden doğrula." Akış birinci adımdan başlar ve diyalog yeni bir proof ister. API çağıranı, kapının verdiği `428 sudo_required` (`reason: "expired"`) yanıtını alır. Yerel receipt cookie'si silinmez: intentin idempotency key'ine tek tutamaktır ve pencereyle birlikte düşer.
- **`503 account_deletion_unavailable`** (Core kapalı, projeksiyon başarısız ya da realm'e sorulamadı), zaman aşımı veya sözleşme dışı yanıt: kabul edilip edilmediği kesin değildir, çünkü Core projeksiyon başarısız olsa bile durable isteği tutar ve aynı key ile tamamlar. BFF yerel receipt'i korur ve `/account-deletion?recovery=1` durum sayfasına yönlendirir. Sayfa aynı mühürlü kanıt ve aynı idempotency key ile Core'u yeniden dener; yine olmazsa "Durum alınamadı … Kısa bir süre sonra yeniden kontrol edebilirsin" der. API çağıranı `503` ve `Retry-After: 3` alır. Diyalogdan sonra `prepare` `503` alırsa sayfa "Hesap silme işlemi şu anda başlatılamıyor. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene." der.

Route'lar orchestrator hatalarını `instanceof` ile değil sabit `name` değerleriyle tanır (`accountDeletionErrorKind`). Servisler `globalThis` üzerinde önbelleklenir ve `next dev` altında bir route, orchestrator'ı kuran modülün başka bir kopyasına karşı derlenmiş olabilir.

Core çağrısı ile browser cevabı arasındaki kayıp idempotent'tir. Kısa recovery penceresi sudo token'ın `exp` değerine bağlıdır; şifreli access/sudo token çifti bu sınırı aşamaz. Browser yalnız `Secure`, `HttpOnly`, `SameSite=Lax`, host-only receipt cookie taşır. İlk yerel receipt, aynı durable intent/idempotency key ile Core'u yeniden çağırabilir. Core receipt alındığı anda şifreli access/sudo token çifti atomik olarak şifreli Core receipt ile değiştirilir. Receipt ve sudo token URL'ye, HTML'e, JSON'a, localStorage/sessionStorage'a veya loglara yazılmaz. Tekrar introspection'a dayandığı için Core'un saga'sı Keycloak oturumunu kapattıktan sonra aynı sudo token artık kabul edilmez; eski ID-token yolunda bu sınır yoktu (bkz. rollout kapıları).

Public `/account-deletion` sayfası session istemeden HttpOnly receipt üzerinden durum okur. Böylece global marker yüzünden normal hesap layout'u erişimi kapattıktan sonra da kullanıcı `blocking`, `pending`, `processing`, `completed` ve `manual_intervention` durumlarını görebilir. Retry yalnız `manual_intervention` için receipt-bound CSRF proof ile yapılır; erişimi yeniden açmaz ve tamamlanan checkpoint'leri geri almaz.

## Core sınırı

Production HTTP adapter'ın kabul ettiği cevap şemaları bilinçli olarak dardır:

- `POST /v1/account-deletion-requests/self`: `receipt`, `status`, `partial`, `platformBlocked`, zaman alanları.
- `GET /v1/account-deletion-requests/status` ve `POST .../status/retry`: receipt içermeden `status`, `partial`, `platformBlocked`, zaman alanları.
- Her normal başarıda `platformBlocked=true` zorunludur. Bu alan Account Center public API'sine taşınmaz.
- Intake ve retry komutlarında `blocking`/`pending`/`processing` yalnız HTTP 202; `completed`/`manual_intervention` yalnız HTTP 200 ile kabul edilir. Status/body uyuşmazlığı fail-closed sonuçlanır.
- Core problem gövdeleri kullanıcıya veya loga aktarılmaz; yalnız sabit kullanıcı durumlarına çevrilir.

Core remote-but-owned bağımlılıktır. Route ve UI HTTP ayrıntılarını bilmez; yalnız `AccountDeletionOrchestrator` arayüzünü kullanır. Production adapter ile test in-memory adapter aynı observable outcome testlerine tabidir.

### Sudo kanıtı (A7b)

Core self-delete intake'i `X-Sky-Sudo` başlığını core-backend PR #92 ile kabul eder (`docs/account-self-delete.md`). Token Keycloak'ın iç HMAC anahtarıyla imzalandığı için Core onu JWKS ile doğrulayamaz; realm'in introspection ucuna kendi `core` istemcisiyle sorar. Keycloak yalnız token'ın `aud` değerinde adı geçen istemciye `active:true` döndüğü için sky-account sudo token'ını `aud: ["sky-account","core"]` ile verir (K3e, e-skylab-keycloak PR #32). Introspection yanıtına `account-center` mapper'ları `account`'u da ekler; Core `aud` için eşitlik değil içerme arar. Bearer'ın `aud` kuralı da küme olarak okunur (`["account","core"]` kabul edilir; core-backend PR #88).

## Saklama ve temizlik

Onay öncesinde yalnız HMAC/hash kimlik bağları ve AES-256-GCM şifreli access/sudo token çifti saklanır. Sudo token'ın asıl yeri oturumun Sudo modu kasasıdır; intentteki kopya yalnız onayın ve recovery tekrarının Core'a aynı kanıtı sunması içindir ve token'ın kendi ömrüyle sınırlıdır. Intent kimliği subject için fresh-auth tekrarlarında sabit kalır; token ciphertext AAD'i en güncel session+proof'a bağlıdır. Core kabulünden sonra subject/session/proof bağları ve tokenlar scrub edilir.

Saatlik auth maintenance işi:

- fresh-auth penceresi dolan, Core tarafından kabul edilmemiş intenti hard-delete eder;
- kabul edilmiş intentte kısa yerel receipt ve şifreli recovery receipt'i fresh pencere sonunda scrub eder;
- hashlenmiş Core receipt kaydını Core receipt expiry sonunda hard-delete eder.

## Rollout kapıları

Kod ve migration production'da varsayılan olarak inerttir: `ACCOUNT_ERASURE_MODE=off`. `enforce` yalnız `ACCOUNT_ACCESS_GATE_MODE=enforce` ve canonical HTTPS `CORE_API_URL` ile başlar. Açılıştan önce şunların tamamı kanıtlanmalıdır:

1. Core PR #79 ile merge edilen self-service intake/status/retry sözleşmesinin GHCR `main` candidate'ı production'a deploy edilmiş olmalı.
2. Core queued saga Keycloak disable/session sonlandırma, aktif servis checkpoint'leri, anonimleştirme ve sertifika/ticket/check-in korunumu için production-clone'da doğrulanmalı.
3. Core, Forms, CMS ve SkyMail aynı kalıcı access-gate marker'ını fail-closed okumalı; eski JWT matrisi yeşil olmalı.
4. Dedicated Redis `noeviction`/AOF/ACL ve PostgreSQL migration+maintenance job hazır olmalı.
5. Account Center ve Core candidate image'ları birlikte uçtan uca crash/retry testinden geçmeli.
6. A7b sudo kanıtı şu sırayla canlıya çıkmış olmalı: önce K3e (sky-account sudo token'ını `aud: ["sky-account","core"]` ile verir), sonra Core (`X-Sky-Sudo` kabulü, PR #92), sonra Account Center (`X-Sky-Sudo` gönderen, hop'suz sürüm). Ancak üçü de canlıdayken `ACCOUNT_ERASURE_MODE=enforce` açılabilir. Account Center daha önce yayına çıkarsa silme kapalı olduğu için bir şey değişmez; açık olsaydı Core her kanıtı `401` ile reddeder, kişi Sudo moduna geri gönderilirdi ve hiçbir şey silinmezdi.
7. Recovery tekrarının Core saga'sının Keycloak oturumunu kapatmasından sonra da çalıştığı (ya da kayıp yanıtın başka yoldan kurtarıldığı) production-clone'da kanıtlanmalı: sudo token introspection'la doğrulandığı için oturum kapanınca aynı token `401` alır.

Bu kapılar tamamlanmadan environment flag açılmaz ve deployment yapılmaz.
