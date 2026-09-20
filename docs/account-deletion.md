# Hesap silme sözleşmesi

## Akış

Hesap silme, Keycloak Account Console veya `DELETE_ACCOUNT` AIA işlemi değildir. Account Center kullanıcıyı `prompt=login` ve `max_age=0` ile yeniden doğrular; callback mevcut opaque BFF session, aynı subject, doğrulanmış `sid` ve en fazla beş dakikalık `auth_time` ile bağlıdır. Tarayıcıya Keycloak token'ı veya subject verilmez.

Kullanıcı `HESABIMI SİL` metnini birebir girdikten sonra BFF, Core'un dar self-service intake ucuna yalnız fresh Account REST access token'ını, fresh ID token'ını ve 256-bit idempotency key'i yollar. Subject request body/header'dan alınmaz. Core kalıcı global access-gate marker'ını doğrulamadan başarılı yanıt veremez. Başarıdan sonra Account Center aynı yerel subject'e ait bütün session'ları, intentteki güvenilir session kimliği üzerinden revoke eder; ancak bundan sonra silme durumuna yönlendirir.

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
