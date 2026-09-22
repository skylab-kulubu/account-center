# Hesap silme sözleşmesi

## Akış

Hesap silme, Keycloak Account Console veya `DELETE_ACCOUNT` AIA işlemi değildir. `/delete-account` sayfası kişiyi sırayla şu adımlardan geçirir:

1. **Niyet.** Sonuçlar okunduktan sonra "Hesabımı silmek istiyorum" denir. Bu ana kadar hiçbir uç çağrılmaz.
2. **Sudo modu.** Sayfa `useSudo().ensureSudo()` ile ürün içi doğrulama diyaloğunu açar: parola, passkey ya da doğrulama kodu; hiçbiri yoksa Microsoft yedeği (bkz. [Sudo modu](architecture.md#sudo-modu)). Diyaloğun sonucu tarayıcının kararı değildir: hem `POST /api/account/deletion/prepare` hem de `POST /api/account/deletion` kapıyı sunucuda `requireAccountSudo` ile yeniden uygular. Taze proof yoksa yanıt `428 sudo_required`, tarayıcı gezintisinde `/delete-account?deletionError=sudo_required` olur ve akış birinci adıma döner. Hesap silme SPI'ye `X-Sky-Sudo` sunmadığı için token'sız bir `reauth` proof'u da kabul edilir.
3. **Onay metni.** `HESABIMI SİL` birebir yazılır.
4. **Gönderim.** Form `POST /api/account/deletion` ucuna gider.

İkinci ve üçüncü adım arasında `POST .../deletion/prepare` (exact `Origin`, `x-csrf-token`, access gate, oturum, sudo) Core'un taze kimlik doğrulama koşulunun nasıl karşılanacağına karar verir. Karar tek bir yerdedir: `planDeletionReauthentication` (`src/server/account-deletion/reauthentication.ts`). Yanıt yalnız `{ "step": … }` taşır; subject, token ya da Keycloak ayrıntısı taşımaz.

- **`confirm`** — oturumdaki ID token Core'un doğruladığı sözleşmeye uyuyorsa (RS256 `JWT`, aynı issuer ve subject, `aud` tam olarak `account-center`, boş olmayan `sid`, gelecekte `exp`, en fazla beş dakikalık `auth_time`) intent bu uçta oluşturulur, proof ve yerel receipt cookie'leri yazılır ve Keycloak'a hiç gidilmez. Sudo modunun Microsoft yedeği tam olarak bu durumu üretir: callback taze token setini oturuma yazdığı için `auth_time` zaten tazedir.
- **`keycloak_reauthentication`** — oturumdaki ID token yalnız ilk girişi kanıtlıyorsa sayfa "Hesap silme için Keycloak üzerinden ek doğrulama gerekiyor" der ve bugünkü `prompt=login&max_age=0` hop'unu (`POST /api/account/deletion/reauthenticate`) sunar. `prompt=none` ile sessiz bir tur aynı `auth_time` değerini döndürdüğü için Core'un beş dakikalık kuralını karşılamaz; bu yüzden denenmez. Hiçbir token üretilmez, tazeymiş gibi yeniden yazılmaz.

Hop'un kendisi değişmedi: callback mevcut opaque BFF session, aynı subject, doğrulanmış `sid` ve en fazla beş dakikalık `auth_time` ile bağlıdır ve dönüşte intent ile cookie'leri yine callback yazar. Tarayıcıya Keycloak token'ı veya subject verilmez. Takip bileti **A7b** Core intake'i sky-account sudo token'ını kabul ettiğinde yalnız yukarıdaki ikinci dal değişir; adım sırası, intent, idempotency key, receipt cookie ve durum sayfası aynı kalır.

Onay metni girildikten sonra BFF, Core'un dar self-service intake ucuna yalnız fresh Account REST access token'ını, fresh ID token'ını ve 256-bit idempotency key'i yollar. Subject request body/header'dan alınmaz. Core kalıcı global access-gate marker'ını doğrulamadan başarılı yanıt veremez. Başarıdan sonra Account Center aynı yerel subject'e ait bütün session'ları, intentteki güvenilir session kimliği üzerinden revoke eder; ancak bundan sonra silme durumuna yönlendirir.

Core çağrısı ile browser cevabı arasındaki kayıp idempotent'tir. Beş dakikalık kısa recovery penceresi callback saatinden değil doğrulanmış `auth_time` değerinden başlar; şifreli access/ID token çifti bu sınırı aşamaz. Browser yalnız `Secure`, `HttpOnly`, `SameSite=Lax`, host-only receipt cookie taşır. İlk yerel receipt, aynı durable intent/idempotency key ile Core'u yeniden çağırabilir. Core receipt alındığı anda şifreli access/ID token çifti atomik olarak şifreli Core receipt ile değiştirilir. Receipt URL'ye, HTML'e, JSON'a, localStorage/sessionStorage'a veya loglara yazılmaz.

Public `/account-deletion` sayfası session istemeden HttpOnly receipt üzerinden durum okur. Böylece global marker yüzünden normal hesap layout'u erişimi kapattıktan sonra da kullanıcı `blocking`, `pending`, `processing`, `completed` ve `manual_intervention` durumlarını görebilir. Retry yalnız `manual_intervention` için receipt-bound CSRF proof ile yapılır; erişimi yeniden açmaz ve tamamlanan checkpoint'leri geri almaz.

## Core sınırı

Production HTTP adapter'ın kabul ettiği cevap şemaları bilinçli olarak dardır:

- `POST /v1/account-deletion-requests/self`: `receipt`, `status`, `partial`, `platformBlocked`, zaman alanları.
- `GET /v1/account-deletion-requests/status` ve `POST .../status/retry`: receipt içermeden `status`, `partial`, `platformBlocked`, zaman alanları.
- Her normal başarıda `platformBlocked=true` zorunludur. Bu alan Account Center public API'sine taşınmaz.
- Intake ve retry komutlarında `blocking`/`pending`/`processing` yalnız HTTP 202; `completed`/`manual_intervention` yalnız HTTP 200 ile kabul edilir. Status/body uyuşmazlığı fail-closed sonuçlanır.
- Core problem gövdeleri kullanıcıya veya loga aktarılmaz; yalnız sabit kullanıcı durumlarına çevrilir.

Core remote-but-owned bağımlılıktır. Route ve UI HTTP ayrıntılarını bilmez; yalnız `AccountDeletionOrchestrator` arayüzünü kullanır. Production adapter ile test in-memory adapter aynı observable outcome testlerine tabidir.

### Hop'un tamamen kalkması için Core'da gerekenler (A7b)

Intake bugün `Authorization: Bearer <Account REST token>` yanında `X-Account-Reauth-Token` içinde ikinci bir JWT bekler ve bu ID token'ın `auth_time` değerini beş dakikayla sınırlar (`ParseSelfDeleteContext`). Sudo modu bu koşulu karşılayamaz: ürün içi kanıt Keycloak oturumunun `auth_time` değerini değiştirmez. Hop yalnız Core şunları yaparsa kalkar:

1. `X-Account-Reauth-Token` yerine `X-Sky-Sudo` kabul etmeli; sky-account sudo token'ını realm JWKS ile RS256 doğrulamalı, `sub` değerinin bearer ile aynı olduğunu, token'ın sudo türünde ve süresinin dolmadığını görmeli (sky-account beş dakikalık token verir, dolayısıyla tazelik yine token'ın kendisinden gelir).
2. Sudo token'ının `aud`/`azp` ve tür alanlarını kendi tarafında sabitlemeli; `auth_time` koşulu bu yolda aranmamalı.
3. Geçiş boyunca iki başlıktan birini kabul etmeli ki Account Center ile Core sürümleri bağımsız dağıtılabilsin; eski başlık ancak `keycloak_reauthentication` dalı kalktıktan sonra düşürülebilir.
4. Bearer'ın audience kuralı `aud` alanını tam olarak `"account"` dizgisi olarak arıyor. K2 reconcile'dan sonra kullanıcı token'ı `["account","core"]` taşıdığı için bu kural gevşetilmeli (kümenin `account` içermesi yeterli olmalı), yoksa intake her çağrıyı reddeder.

Bu dört madde Core PR'ı ve sürümü gerektirir; A7 kapsamında Core'a dokunulmadı.

## Saklama ve temizlik

Onay öncesinde yalnız HMAC/hash kimlik bağları ve AES-256-GCM şifreli fresh token çifti saklanır. Intent kimliği subject için fresh-auth tekrarlarında sabit kalır; token ciphertext AAD'i en güncel session+proof'a bağlıdır. Core kabulünden sonra subject/session/proof bağları ve tokenlar scrub edilir.

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

Bu kapılar tamamlanmadan environment flag açılmaz ve deployment yapılmaz.
