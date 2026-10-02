# Auth retention runbook

## Amaç

OIDC transaction ve BFF session tablolarında artık doğrulama için kullanılamayan auth materyalinin süresiz kalmasını engeller. Bu bakım işi uygulama prosesinde timer çalıştırmaz; deployment scheduler tarafından tekil bir job olarak başlatılır.

## Zamanlama ve komut

Scheduler saatte bir, uygulamanın kullandığı aynı image ve yalnız gerekli `DATABASE_URL` secret'ıyla aşağıdaki komutu çalıştırır; OIDC client secret veya token encryption key bu job'a verilmez:

```bash
node scripts/prune-auth.mjs
```

Komut PostgreSQL transaction-scoped advisory lock alır. Önceki job hâlâ çalışıyorsa ikinci job silme yapmadan başarılı biçimde `auth_prune_skipped` olayıyla çıkar. Statement timeout 30 saniye, lock timeout 5 saniyedir.

## Retention sözleşmesi

- Tüketilmiş veya süresi dolmuş OIDC transaction kayıtları bir saatlik inceleme grace süresinden sonra hard-delete edilir.
- Revoke olmuş, absolute expiry'yi veya idle expiry'yi geçmiş session kayıtları 24 saatlik operasyonel grace süresinden sonra şifreli access/refresh token materyaliyle birlikte hard-delete edilir.
- Aktif kayıtlar ve grace aralığındaki kayıtlar korunur.
- Süresi dolmuş backchannel logout JTI replay kayıtları ve anonymous auth rate-limit bucket’ları silinir.
- Emekli native handoff tabloları (`account_native_*`, migration `0003`) job'ın kapsamında hiç değildi: native handoff Web handoff'a bırakıldığında (ADR-0048) bu tablolara yazılması durdu ve içlerinde kalan kodlar (geçici altyapı verisi) tablolarla birlikte `0008_drop_native_handoff.sql` ile hard-delete edildi. Production'da `0008` 2026-09-25'te uygulandı.
- `account_action_results` tablosu hiçbir kod yolunda yazılmaz (parola/TOTP/passkey değişiklikleri `my.` içinde sky-account SPI ile yapılır) ama `/api/ready` varlığını hâlâ arar ve `0004` migration kaydı yerinde durur. Job süresi dolmuş ya da bir saatten eski tüketilmiş kayıtları yine hard-delete eder; session silindiğinde bağlı kayıtlar cascade ile kalkar. Tabloyu kaldırmak ayrı bir migration ile readiness sorgusunun değişmesini birlikte ister.
- Süresi dolmuş sudo proof’ları (`sudo_token_ciphertext`/`sudo_expires_at`) aktif oturum kayıtlarından hemen scrub edilir; iptal edilmiş veya süresi dolmuş oturumlardaki materyal kaydın kendisiyle birlikte hard-delete edilir.
- Onaylanmamış hesap silme niyetleri beş dakikalık fresh-auth penceresi biter bitmez şifreli kimlik tokenlarıyla birlikte hard-delete edilir. Core tarafından kabul edilmiş niyetlerde yerel kurtarma receipt'i ve şifreli Core receipt aynı pencerede scrub edilir; yalnız hashlenmiş Core receipt durum yetkisi kendi expiry tarihine kadar kalır, sonra kayıt hard-delete edilir.

`maintenance/prune-auth.sql` yalnız auth-owned tablolara ve açık tarih koşullarına göre silme yapar. Kullanıcı, etkinlik veya başka ürün verilerine dokunmaz.

## İzleme

Başarılı çalışmada yalnız aşağıdaki alanlar loglanır:

```json
{"event":"auth_prune_completed","deletedTransactions":0,"deletedSessions":0,"deletedLogoutReplays":0,"deletedRateLimits":0,"deletedActionResults":0,"deletedDeletionIntents":0,"scrubbedDeletionRecovery":0,"scrubbedSudoProofs":0}
```

Loglarda token, cookie, state, subject veya PII bulunmaz. `auth_prune_failed` için alert oluşturulmalı; tek bir saatlik hata veri erişimini etkilemez fakat sonraki başarılı koşuya kadar retention uzar. 24 saat boyunca başarılı koşu görülmezse nöbetçiye bildirilmelidir.

## Doğrulama ve geri dönüş

Migration'lar normalde yeni sürüm trafiğe alınmadan önce, üretim imajının içinden, uygulamanın kullandığı aynı `DATABASE_URL` ile uygulanır; ardından bakım işi bir kez elle çalıştırılıp çıktısı denetlenir:

```bash
node scripts/migrate.mjs
node scripts/prune-auth.mjs
```

`migrate.mjs` bekleyen her dosyayı sırayla uygular (`account_center_schema_migrations`, advisory lock, her dosya kendi transaction'ında) ve ikinci koşuda hiçbir şey yapmaz; CI aynı migration'ları PostgreSQL 17 ve 18'de iki kez çalıştırır. Şemayı daraltan bir migration (`0008` gibi) bir önceki imajın readiness'ini ya da bakım işini bozabilir; böyle bir sürümde sıra, sürüm yayındayken yedek alınıp geri yüklemesi denendikten sonra migration'ı elle çalıştırmaktır. Production'da `0006` (Sudo sütunları) ve `0008` bu biçimde, yedek ve geri yükleme provasıyla uygulandı; ayrıntı [rollout-v2.md](rollout-v2.md).

Job idempotent'tir; başarısız koşudan sonra aynı komut yeniden çalıştırılabilir. Hard-delete edilen auth materyali geri yüklenmez ve geri yüklenmesine ihtiyaç yoktur: silinen session zaten kullanılamaz durumdadır, kullanıcı gerektiğinde yeniden giriş yapar. Beklenmeyen silme sayısı görülürse scheduler durdurulur, job image/config sürümü kaydedilir ve SQL koşulları incelenir; tabloya auth materyali elle geri yazılmaz. Geri dönüş hedefi bir önceki Account Center v2 imajıdır; migration'lar geri alınmaz.
