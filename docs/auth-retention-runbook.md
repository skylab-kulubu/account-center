# Auth retention runbook

## Amaç

OIDC transaction, BFF session ve native handoff tablolarında artık doğrulama için kullanılamayan auth materyalinin süresiz kalmasını engeller. Bu bakım işi uygulama prosesinde timer çalıştırmaz; deployment scheduler tarafından tekil bir job olarak başlatılır.

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
- Tüketilmiş veya süresi dolmuş public native handoff ve internal bridge kayıtları bir saatlik grace sonrasında; süresi dolmuş internal HMAC nonce kayıtları hemen hard-delete edilir.

`maintenance/prune-auth.sql` yalnız auth-owned tablolara ve açık tarih koşullarına göre silme yapar. Kullanıcı, etkinlik veya başka ürün verilerine dokunmaz.

## İzleme

Başarılı çalışmada yalnız aşağıdaki alanlar loglanır:

```json
{"event":"auth_prune_completed","deletedTransactions":0,"deletedSessions":0,"deletedLogoutReplays":0,"deletedRateLimits":0,"deletedNativeHandoffs":0,"deletedNativeBridges":0,"deletedNativeBridgeNonces":0}
```

Loglarda token, cookie, state, subject veya PII bulunmaz. `auth_prune_failed` için alert oluşturulmalı; tek bir saatlik hata veri erişimini etkilemez fakat sonraki başarılı koşuya kadar retention uzar. 24 saat boyunca başarılı koşu görülmezse nöbetçiye bildirilmelidir.

## Doğrulama ve geri dönüş

Deployment öncesi migration uygulanmış olmalıdır:

```bash
node scripts/migrate.mjs
node scripts/prune-auth.mjs
```

Job idempotent'tir; başarısız koşudan sonra aynı komut yeniden çalıştırılabilir. Hard-delete edilen auth materyali geri yüklenmez ve geri yüklenmesine ihtiyaç yoktur: silinen session zaten kullanılamaz durumdadır, kullanıcı gerektiğinde yeniden giriş yapar. Beklenmeyen silme sayısı görülürse scheduler durdurulur, job image/config sürümü kaydedilir ve SQL koşulları incelenir; tabloya auth materyali elle geri yazılmaz.
