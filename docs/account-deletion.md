# Hesap silme sözleşmesi

## Akış

Hesap silme, Keycloak Account Console veya `DELETE_ACCOUNT` AIA işlemi değildir. `/delete-account` sayfası kişiyi sırayla şu adımlardan geçirir:

1. **Niyet.** Sonuçlar okunduktan sonra "Hesabımı silmek istiyorum" denir. Bu ana kadar hiçbir uç çağrılmaz.
2. **Sudo modu.** Sayfa `useSudo().ensureSudo()` ile ürün içi doğrulama diyaloğunu açar: parola, passkey ya da doğrulama kodu; hiçbiri yoksa Microsoft yedeği (bkz. [Sudo modu](architecture.md#sudo-modu)). Diyaloğun sonucu tarayıcının kararı değildir: hem `POST /api/account/deletion/prepare` hem de `POST /api/account/deletion` kapıyı sunucuda `requireAccountSpiSudo` ile yeniden uygular; `X-Sky-Sudo` gönderen her uçla aynı kapıdır. Taze proof yoksa yanıt `428 sudo_required`, tarayıcı gezintisinde `/delete-account?deletionError=sudo_required` olur ve akış birinci adıma döner. Sky-account token'ı taşımayan bir `reauth` proof'u (Microsoft yedeğinin `POST sudo/authentication` çağrısı başarısız olmuşsa kalan nadir durum) `428 spi_token_required` ile reddedilir ve kasadan silinir: Core onu doğrulayamaz.
3. **Onay metni.** `HESABIMI SİL` birebir yazılır.
4. **Gönderim.** Form `POST /api/account/deletion` ucuna gider.

İkinci ve üçüncü adım arasında `POST .../deletion/prepare` (exact `Origin`, `x-csrf-token`, access gate, oturum, sudo) intenti oluşturur: Account REST access token'ı ile oturumun Sudo modu kasasındaki (`SudoVault`) sudo token'ı intentin şifreli recovery zarfına yazılır. Access token, oturumdan en az 5 dk 30 sn daha geçerli kalacak biçimde alınır; daha erken dolacaksa önce yenilenir (`accessTokenWithExpiry`). Beş dakikalık access token veren bir realm'de bu, her `prepare`'de yenileme demektir. Ardından proof ve yerel receipt cookie'leri set edilir. Yanıt yalnız `{ "step": "confirm" }` taşır; subject, token ya da Keycloak ayrıntısı taşımaz. Keycloak'a gidilmez. Silmeye özel `prompt=login&max_age=0` hop'u (`POST /api/account/deletion/reauthenticate`, `account-deletion-reauthentication` OIDC amacı ve `planDeletionReauthentication`) A7b ile kaldırıldı; parolası, passkey'i ya da TOTP'si olmayan kişinin Microsoft yedeği genel Sudo modunun parçasıdır (`POST sudo/authentication`, yöntem `authentication`). Kaldırılan hop'un sürüm öncesinde başlatılmış bir transaction'ı callback'te reddedilir.

Intentin tazelik penceresi mühürlenen iki token'ın kendi `exp` değerlerinden gelir: `min(sudo expiresAt − 5 sn, bearer exp − 30 sn, şimdi + 5 dk)`. Beş saniye, kasanın proof'u dağıtırken bıraktığı paydır. Otuz saniye, Account Center ile Core saatleri arasındaki olası kaymadan büyüktür. Böylece ne onay ne de recovery tekrarı Core'a süresi dolmuş bir sudo token ya da bearer sunar. Pencere dolmuşsa `prepare` yine `428` döner ve diyalog yeniden açılır.

### Core'a giden kanıt

Onay metni girildikten sonra BFF, Core'un dar self-service intake ucuna yalnız şunları yollar:

- `Authorization: Bearer <Account REST access token>`;
- `X-Sky-Sudo: <sky-account sudo token>`. BFF token'ı opak bir dize olarak taşır ve içine bakmaz. Core onu realm introspection'ıyla doğrular: `typ=sky-sudo`, realm `iss`, `azp=account-center`, `aud` içinde hem `sky-account` hem `core` (K3e), bearer ile aynı `sub` ve `sid`, gelecekte `exp`. Bu yolda `auth_time` kuralı yoktur; tazelik token'ın beş dakikalık ömründen gelir;
- 256-bit `Idempotency-Key`.

`X-Account-Reauth-Token` (taze ID token) artık gönderilmez. Core iki başlık birlikte gelirse yalnız sudo token'a bakar; ID token'ı eklemek hiçbir şey kanıtlamaz, yalnız yola ikinci bir kimlik bilgisi koyar. Core eski başlığı geri dönüş için bir süre daha kabul eder. Subject request body/header'dan alınmaz. Core kalıcı global access-gate marker'ını doğrulamadan başarılı yanıt veremez. Başarıdan sonra Account Center aynı yerel subject'e ait bütün session'ları, intentteki güvenilir session kimliği üzerinden revoke eder; ancak bundan sonra silme durumuna yönlendirir.

Core'un cevapları şöyle karşılanır:

- **`401 invalid_end_user_token`**: Core kanıtı reddetti. Sudo token'ın süresi dolmuş, Keycloak oturumu kapanmış ya da token başka bir oturumun olabilir; bearer'ın reddi de aynı koddur ve çaresi aynıdır. Kimlik bilgileri her şeyden önce doğrulandığı için hiçbir şey kabul edilmemiştir. BFF sudo proof'unu kasadan siler (SPI'nin reddettiği proof'larla aynı kural), proof cookie'sini temizler ve sayfayı `/delete-account?deletionError=sudo_rejected` adresine gönderir: "Silme isteğin için kimlik doğrulaman kabul edilmedi ya da süresi doldu. Hesabında hiçbir değişiklik yapılmadı. Devam etmek için kimliğini yeniden doğrula." Akış birinci adımdan başlar ve diyalog yeni bir proof ister. API çağıranı, kapının verdiği `428 sudo_required` (`reason: "expired"`) yanıtını alır. Yerel receipt cookie'si silinmez: intentin idempotency key'ine tek tutamaktır ve pencereyle birlikte düşer. Onay gönderiminde "hiçbir değişiklik yapılmadı" demek dürüsttür. Gönderim Account Center'ın access gate'inin arkasındadır ve Core bir isteği kabul etmeden önce kalıcı marker'ı yazar, bu yüzden gönderim Core'un kabul ettiği bir key'i hiç tekrar etmez. Bearer da pencere boyunca geçerlidir.
- **`503 account_deletion_unavailable`** (Core kapalı, projeksiyon başarısız ya da realm'e sorulamadı), zaman aşımı veya sözleşme dışı yanıt: kabul edilip edilmediği kesin değildir, çünkü Core projeksiyon başarısız olsa bile durable isteği tutar ve aynı key ile tamamlar. BFF yerel receipt'i korur ve `/account-deletion?recovery=1` durum sayfasına yönlendirir. Sayfa aynı mühürlü kanıt ve aynı idempotency key ile Core'u yeniden dener; yine olmazsa "Durum alınamadı … Kısa bir süre sonra yeniden kontrol edebilirsin" der. API çağıranı `503` ve `Retry-After: 3` alır. Diyalogdan sonra `prepare` `503` alırsa sayfa "Hesap silme işlemi şu anda başlatılamıyor. Hesabında hiçbir değişiklik yapılmadı; kısa bir süre sonra tekrar dene." der.

Route'lar orchestrator hatalarını `instanceof` ile değil sabit `name` değerleriyle tanır (`accountDeletionErrorKind`). Servisler `globalThis` üzerinde önbelleklenir ve `next dev` altında bir route, orchestrator'ı kuran modülün başka bir kopyasına karşı derlenmiş olabilir.

Core çağrısı ile browser cevabı arasındaki kayıp idempotent'tir. Kısa recovery penceresi sudo token'ın ve bearer'ın `exp` değerine bağlıdır; şifreli access/sudo token çifti bu sınırı aşamaz. Browser yalnız `Secure`, `HttpOnly`, `SameSite=Strict`, host-only receipt cookie taşır. İlk yerel receipt, aynı durable intent/idempotency key ile Core'u yeniden çağırabilir, ama yalnız onay metni kaydedildiyse (bkz. [Onay kaydı](#onay-kaydı-a7d)). Core receipt alındığı anda şifreli access/sudo token çifti atomik olarak şifreli Core receipt ile değiştirilir. Receipt ve sudo token URL'ye, HTML'e, JSON'a, localStorage/sessionStorage'a veya loglara yazılmaz. Core'un saga'sı Keycloak oturumunu kapattıktan sonra aynı sudo token introspection'da artık etkin görünmez. Bu yüzden Core, daha önce kabul ettiği bir key'in tekrarını sudo token'a bakmadan, saklanan istekten cevaplar (core-backend PR #94). Bearer'ı ise yine yerel olarak doğrular; süresi dolmuş bearer'ı kabul etmez. Recovery penceresinin bearer'dan uzun yaşamaması bu yüzdendir. Recovery tekrarında Core mühürlü kimlik bilgilerini yine de `401` ile reddederse, önceki denemenin kabul edilip edilmediği bilinemez ve aynı bilgilerle öğrenilemez. Durum ucu `409 outcome_unknown` döner, receipt cookie'si korunur. Sayfa "Durum doğrulanamadı: Silme isteğin işleme alınmış olabilir. Durumu yeniden kontrol edebilir ya da yeniden giriş yapabilirsin." der. Pencere bir cevap alınamadan kapanırsa `/account-deletion?recovery=1` sayfası "bulunamadı" yerine aynı durumu gösterir. "Hiçbir değişiklik yapılmadı" hiçbirinde söylenmez.

### Onay kaydı (A7d)

`prepare` yerel receipt'i onay metninden önce verir. Bu yüzden receipt tek başına bir silme başlatamaz. Başlatan tek şey kaydedilmiş onaydır:

- **Kayıt Core'dan önce yapılır.** `POST /api/account/deletion` onay metnini, oturumu, proof ve receipt cookie'lerini doğrular. Ardından Core'a gitmeden önce onayı `account_deletion_confirmations` tablosuna yazar (migration `0007`). Kayıt, intentin o anki `proof_hash` değerine bağlıdır. Yazılamazsa Core çağrılmaz ve sonuç `unavailable` olur. Intent bu arada değiştiyse sonuç `proof` olur.
- **Durum ucu yalnız onaylanmış intenti kurtarır.** `GET /api/account/deletion/status`, `awaiting_confirmation` aşamasındaki bir intent için Core'u yalnız o proof altında kaydedilmiş bir onay varsa çağırır. Onaysız intent `404 not_found` alır ve Core'a hiçbir şey gitmez. Receipt cookie'si silinmez, çünkü bekleyen gönderim ona hâlâ ihtiyaç duyar. Core'un kabulü (`acceptCore`) de aynı proof altında kayıtlı bir onay ister ve onayı proof ile birlikte scrub eder.
- **Onay geri alınabilir ve eskiyebilir.** Core gönderimi kesin olarak reddederse (`401`, "hiçbir değişiklik yapılmadı") onay silinir. Böylece durum ucu onu tekrar oynatamaz. Yeniden doğrulama `proof_hash` değerini değiştirir; eski onay yeni kimlik bilgilerine hiç bağlanmaz, bunu hangi sürüm yazmış olursa olsun.
- **Geriye uyumlu, fail-closed migration.** `0007` yalnız yeni bir tablo ekler. `account_deletion_intents` ve `0005`'in parmak izi değişmez; eski sürüm bu tabloyu hiç okumaz. `0007`'den önce mühürlenmiş, yolda kalmış bir intentin onay kaydı yoktur: onaysız sayılır ve durum ucundan Core'a gitmez. Onay kaydı intentiyle birlikte silinir (`ON DELETE CASCADE`), saatlik temizlik de böylece onu kapsar.

Üç karar:

- **Receipt cookie'si yine `prepare`'de verilir.** Kaybolabilen şey gönderimin cevabıdır. Kurtarma tutamacı yalnız o cevapla gelseydi, kurtarılması gereken tek durumda eksik olurdu. Kapıyı cookie değil, sunucudaki onay kaydı tutar.
- **Durum ucu oturum istemez.** Core kabul ettiği anda kalıcı marker'ı yazar ve Account Center'ın access gate'i o subject'i engeller; başarılı gönderim de yerel oturumları kapatır. Oturum şartı, kurtarılması gereken isteği tam o anda kilitlerdi. Onay kaydıyla oturumsuz bir istek en fazla kişinin kendi onayladığı komutu, aynı key ve aynı kimlik bilgileriyle idempotent olarak tekrarlar.
- **Receipt cookie'si `SameSite=Strict`.** Durum sayfası receipt'i aynı origin'den `fetch` ile okur. Başka bir sitenin başlattığı hiçbir istek bu cookie'yi taşımaz, top-level gezinme de. Bu derinlemesine savunmadır, asıl kapı değildir: `*.yildizskylab.com` altındaki kardeş alt alanlar aynı sitedir ve onların istekleri `Strict` cookie'yi taşır. Asıl kapı onay kaydıdır. Proof cookie'si `Lax` kalır; gönderim zaten oturum ve CSRF token'ı ister.

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

- fresh-auth penceresi dolan, Core tarafından kabul edilmemiş intenti hard-delete eder; onay kaydı da onunla birlikte silinir;
- kabul edilmiş intentte kısa yerel receipt ve şifreli recovery receipt'i fresh pencere sonunda scrub eder;
- hashlenmiş Core receipt kaydını Core receipt expiry sonunda hard-delete eder.

## Rollout kapıları

Kod ve migration production'da varsayılan olarak inerttir: `ACCOUNT_ERASURE_MODE=off`. `enforce` yalnız `ACCOUNT_ACCESS_GATE_MODE=enforce` ve canonical HTTPS `CORE_API_URL` ile başlar. Açılıştan önce şunların tamamı kanıtlanmalıdır:

1. Core PR #79 ile merge edilen self-service intake/status/retry sözleşmesinin GHCR `main` candidate'ı production'a deploy edilmiş olmalı.
2. Core'un kuyruklu saga'sı yerel tam düzenekte, gerçek Keycloak'a karşı doğrulanmalı (account-erasure ticket 10). Tam production klonu kurulmaz (Yusuf, 2026-09-24).
   - Düzenek Keycloak disable'ı, oturum sonlandırmayı, aktif servis checkpoint'lerini, anonimleştirmeyi, `404` sonrası tekrarı ve sertifika/ticket/check-in korunumunu kanıtlar.
   - Aktif servis checkpoint'leri ADR-0051'in saga adımlarıdır: Core'un worker'ı SkyMail, CMS ve Forms'a birer Erasure command gönderir. Üçü de onaylamadan istek tamamlanmaz.
   - Realm'de LDAP federasyonu yoktur; YTÜ girişi `OBS` IdP'sidir. Düzenek, silinmiş biri sahte bir `OBS` IdP ile yeniden girince yeni ve boş bir hesap (yeni `sub`) açıldığını kaydeder. Eski marker yeni `sub`'ı engellemez.
   - Kimlik servisi sahibi bu kayıtlara dayanarak yazılı onay verir. Onay bu `OBS` davranışını da kabul eder (ticket 11).
3. Core, Forms, CMS ve SkyMail aynı kalıcı access-gate marker'ını fail-closed okumalı; eski JWT matrisi yeşil olmalı.
4. Dedicated Redis `noeviction`/AOF/ACL ve PostgreSQL migration+maintenance job hazır olmalı.
5. Account Center ve Core candidate image'ları aynı yerel tam düzenekte birlikte uçtan uca crash/retry testinden geçmeli (ticket 10). Servis kapalıyken ertelenen retry, servis çağrısı sırasında çöken Core ve gece secret rotasyonu penceresi de bu testin parçasıdır.
6. A7b sudo kanıtı şu sırayla canlıya çıkmış olmalı: önce K3e (sky-account sudo token'ını `aud: ["sky-account","core"]` ile verir), sonra Core (`X-Sky-Sudo` kabulü, PR #92), sonra Account Center (`X-Sky-Sudo` gönderen, hop'suz sürüm). Ancak üçü de canlıdayken `ACCOUNT_ERASURE_MODE=enforce` açılabilir. Account Center daha önce yayına çıkarsa silme kapalı olduğu için bir şey değişmez; açık olsaydı Core her kanıtı `401` ile reddeder, kişi Sudo moduna geri gönderilirdi ve hiçbir şey silinmezdi.
7. Kayıp yanıtın recovery tekrarı, Core saga'sı Keycloak oturumunu kapattıktan sonra da çalışmalı. Core, kabul ettiği bir key'in tekrarını sudo token'ı introspect etmeden, saklanan istekten cevaplar (core-backend PR #94). Bunun için tekrar yalnız sudo intake biçiminde olmalı: bir `X-Sky-Sudo`, boş gövde ve yerel olarak doğrulanan Account Center bearer'ı. Yeni bir key her zaman canlı bir proof ister. Account Center, `prepare`'de pencereden uzun yaşayan bir bearer mühürler: 5 dk 30 sn'den erken dolacaksa önce yeniler. Pencereyi de `min(sudo exp − 5 sn, bearer exp − 30 sn, şimdi + 5 dk)` ile sınırlar; böylece tekrar süresi dolmuş bir bearer sunmaz. Core #94 ile Account Center'ın bu sürümü aynı ortamda canlı olmalı. Yerel tam düzenekte, gerçek Keycloak'a karşı şu senaryo kanıtlanmalı (ticket 10): kabul → kayıp yanıt → saga oturumu kapatır → aynı key ile recovery tekrarı kabul edilen durumu döndürür, `401` değil.
8. Durum ucu onaysız bir intenti Core'a göndermemeli (A7d, migration `0007`). Bu sürüm ve migration'ı aynı ortamda canlı olmalı.

Bu kapılar tamamlanmadan environment flag açılmaz ve deployment yapılmaz.
