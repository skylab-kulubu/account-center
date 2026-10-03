# Hesap Merkezi v2: yayın kaydı ve işletim

v2 (kimliğin tamamı `my.` içinde: Sudo modu, sky-account SPI, iki e-posta, kulüp profili, Yetkilerim) production'dadır; ilk sürümü 22 Eylül 2026'da çıktı. Bu belge üç şeyi yazar: v2'nin gerçekte nasıl yayına alındığı, bugün bir sürümün nasıl çıkarılıp doğrulandığı ve neyin bekleyen iş olduğu. Mimari için [architecture.md](architecture.md), Keycloak tarafı için [keycloak-26.7.4-contract.md](keycloak-26.7.4-contract.md).

## Gerçek yayın sırası

v2 tek bir "anahtar çevirme" ile açılmadı: planlanan `ACCOUNT_ACTIONS_MODE=spi` bayrağı hiçbir zaman koda girmedi. Parola/TOTP/passkey yolu görüntüyle değişti; eski application-initiated action yolu (`POST /api/auth/action`) v2 imajıyla birlikte kaldırıldı ve geri dönüş önceki imajı yeniden dağıtmaktı.

| Tarih (2026) | Ne | Not |
| --- | --- | --- |
| 21 Eylül | Hesap Merkezi v1 (`cdbd5ea`), core C1 (kendi telefonu ve profil fotoğrafını silme), Keycloak tek tasarım sistemli tema (`eb5a5b7`) | v1 yalnız `aud=["account"]` kabul ediyordu. |
| 22 Eylül | Keycloak v2 kimlik katmanı: sky-account SPI (K3a/K3b/K3d) + v2 uzlaştırıcısı (K2), production `dc6fa30` | Sonra sunucuda `keycloak-v2-identity-release-wizard.sh`: Keycloak veritabanı yedeği + geri yükleme provası, salt-okunur ön kontrol SQL'i (yalnız passkey'i olan kişiler), `default-roles` ön kontrolü (A6), v2 reconcile, `keycloak-mailer` istemcisi, doğrulama. Touch ID kanıtı: `e-skylab-keycloak` issue #1. |
| 22 Eylül | **Hesap Merkezi v2**, production `2ced4b8` (#31) | `account-center-v2-release-wizard.sh` (aşağıda). |
| 23 Eylül | K3c (kişisel e-posta, `46c75b5`) ve e-posta sayfası A1b (`0b63fb1`) | |
| 24 Eylül | Web handoff (`sky-handoff`, `e383db6`), native köprünün sökümü (Keycloak `d3e6514`, Hesap Merkezi `183ded5`), Sudo kanıtının core'a sunulması (A7b/K3e), silme korumaları A7c/A7d (`e45ba0e`, migration `0007`), `account_native_*` kullanımının sökülmesi (`e4738ce`, #52); tabloları kaldıran migration `0008` ertesi gün (25 Eylül) elle uygulandı | [web-handoff.md](web-handoff.md) |
| 25 Eylül | YTÜ'den gelen alanlar (C2), eski birincil adresi kodla doğrulama (A1c) | |
| 28-29 Eylül | Silme durumu düzeltmesi ve yedek notu (#57, #58, #60); `/internal` `404` ve `/.well-known` dosyaları (#62 → `3a84e3f`) | |
| 29 Eylül - 2 Ekim | **K4**, okul ya da kişisel e-postayla parolalı giriş: Keycloak imajı `f71eecb` (#54, 29 Eylül), realm geçişi uzlaştırıcıyla 2 Ekim ~20:50Z; Touch ID ve Microsoft girişi doğrulandı. `/email` metni `account-center#64` (`9f4f971`) | Production'a #67 ile çıktı (2 Ekim, `849d009`, dağıtım başarılı). Parola sıfırlama K4b devam ediyor (e-skylab-keycloak, PR açılacak). |

### v2'nin açılışı (22 Eylül), adım adım

Sıra production sunucusunda, SKY LAB hub'ındaki ops sihirbazlarıyla (`ops/wizards/`) yürütüldü.

1. **Keycloak önce.** Yeni Keycloak imajı ve uzlaştırıcı çalıştı; passkey RP ID `yildizskylab.com` (ek origin `https://my.yildizskylab.com`), kaba kuvvet koruması (10 başarısız denemede geçici kilit; bekleme 60 sn'lik adımlarla en çok 15 dakika, kalıcı kilit yok), parola politikası `length(8) and notUsername and notEmail`, User Profile ve `account-center` token mapper'ları uygulandı. RP ID değiştiği için o güne kadar kayıtlı 35 passkey geçersiz oldu (kişiler YTÜ/Microsoft ile girip yeniden kaydeder); geçersiz passkey'ler sonradan `cleanup-legacy-passkeys.sh` ile temizlendi (34 → 0, K3c sonrası).
2. **Geçici uyum.** Çalışan v1 yalnız `aud=["account"]` kabul ettiği için uzlaştırıcının eklediği `core` audience mapper'ı v2 imajı çıkana kadar elle kaldırıldı.
3. **Hesap Merkezi veritabanı yedeği ve geri yükleme provası.** `account_center` veritabanının `pg_dump -Fc` yedeği alındı ve `--network none` çalışan geçici bir PostgreSQL'e geri yüklenip sayılar karşılaştırıldı.
4. **Migration, uygulamadan önce.** `0006_account_sudo.sql` (Sudo sütunları) `main` imajıyla elle uygulandı: `node scripts/migrate.mjs`; migration sayısı 5 → 6, iki Sudo sütunu mevcut.
5. **İmaj.** `main` → `production` tek squash PR'ı birleşti; CI imajı doğrulayıp yayımladı, Dokploy deploy hook'u dağıttı.
6. **Doğrulama.** `/api/health` ve `/api/ready` `200`.
7. **Reconcile yeniden.** Yeni imaj iki audience kümesini de kabul ettiği için (`token_audience_legacy` olayıyla izlenir) `core` audience mapper'ı reconcile ile geri kondu; token'lar `["account","core"]` taşımaya başladı.

Bugün bu sıranın dersi şudur: **token sözleşmesini genişleten Keycloak değişikliği, genişlemeyi kabul eden Hesap Merkezi imajından önce canlıya çıkmamalıdır.** v2'de bu, `core` mapper'ının geçici olarak elle kaldırılmasıyla çözüldü; bundan sonra aynı türden bir değişiklik "önce kabul eden imaj, sonra Keycloak" sırasıyla çıkar (A0b iki kümeyi kabul eden imajdı, A0c tek kümeye döndürdü; aşağıda).

### Sıkılaştırma (A0c)

K2'den sonra eski `{account}` kümesi yalnız geçiş için kabul ediliyordu. Production loglarında sıfır `token_audience_legacy` olayı kanıtlandı: 2 Ekim 2026 ~21:10Z, salt okunur `ops/wizards/account-center-audience-legacy-check.sh` (SKY LAB hub'ı) ile; log penceresi 84 saat, son 24 saatte 0 olay, çalışan imajda olayı üreten kod doğrulandı. account-center#65 ile kabul edilen küme yalnız `{account, core}` oldu ve `token_audience_legacy` olayı koddan kalktı. Bu değişikliği taşıyan imajdan önceki imajlar iki kümeyi de kabul eder. Saklı oturum token'ı eski küme taşıyorsa oturum bayat sayılır ve kişi yeniden girişe yönlenir. Ayrıntı ve geri alma notu: [Keycloak sözleşmesi](keycloak-26.7.4-contract.md#geçiş-sırası).

## Bugün bir sürümün çıkışı

1. **PR ve CI.** Değişiklik `main`'e PR ile girer. `ci.yml`: `verify` (lint, tip, birim testleri, derleme, üretim derlemesiyle çalışan sunucuda `test:retired-handoff` ve `test:edge-paths`), `browser` (Playwright), `container` (Docker derlemesi) ve `migration-compatibility` (migration'lar PostgreSQL 17 ve 18'de iki kez).
2. **Release.** `main` → `production` tek squash commit'idir (`release/production-<tarih>-<konu>` dalı, PR tabanı `production`); `production` dalı squash olduğu için `git log` değil ağaç karşılaştırılır. `main`'de başkasının yayınlanmamış işi varsa release hepsini taşır: önce sahiplerine sorulur.
3. **Yayın.** `main` ve `production` push'larında `container.yml`: testler, aday imaj (migrate, prune, `/api/ready`, retired handoff ve edge path smoke testleri) ve GHCR'ye `<dal>` ile `<dal>-<sha>` etiketleriyle yayın (`production-2ced4b8` gibi); yalnız `production`'da `DOKPLOY_DEPLOY_HOOK` ile Dokploy tetiklenir. Push'tan sonra o SHA için gerçekten bir build başladığı doğrulanır; başlamadıysa boş bir aynı-ağaç commit'iyle yeniden tetiklenir.
4. **Migration.** Ek (additive) migration deploy'dan **önce**, üretim imajının içinden ve uygulamanın kullandığı `DATABASE_URL` ile çalıştırılır (`node scripts/migrate.mjs`; ikinci koşu no-op). Şemayı daraltan ya da eski imajı bozabilecek bir migration yedek + geri yükleme provasından sonra, yeni sürüm her yerde yayındayken çalıştırılır ([saklama kılavuzu](auth-retention-runbook.md#doğrulama-ve-geri-dönüş)).
5. **Doğrulama.** `/api/health` ve `/api/ready` `200`; çalışan imajın digest'i; `GET /internal/x` ve `GET /handoff` `404`; `GET /.well-known/assetlinks.json` değişkenler tanımlıysa `200`, değilse `404`; `my.`'de çıkış yapıp yeniden giriş. Loglarda `oidc_login_failed`, `account_access_gate` (`unavailable`/`blocked`) ve `auth_prune_failed` izlenir.
6. **Keycloak değişikliği** ayrı depodadır (`e-skylab-keycloak`): her yayın fiziksel Touch ID kanıtı ister (`keycloak-production` ortam değişkenleri ve issue #1 yorumu), yayından sonra çoğu zaman sunucuda uzlaştırıcı iki kez koşar (ikincisi no-op olmalı). Hesap Merkezi'ni etkileyen yerler: token claim'leri ve audience'ları, passkey RP ID, SPI sürümü.

Ortam değişkenleri Dokploy uygulamasındadır (gizli değerler OpenBao referansıdır, ADR-0049); repoya gizli değer girmez. Tam liste ve biçimler: [README, ortam değişkenleri](../README.md#ortam-değişkenleri).

### Bakım işi

`node scripts/prune-auth.mjs` saatte bir, tekil bir iş olarak çalıştırılır (Dokploy Schedules, `0 * * * *`; 25 Eylül'de ilk elle koşu yapıldı ve zamanlayıcı kurulumu başlatıldı). Zamanlayıcının varlığı ve son koşusu (`auth_prune_completed`) Dokploy günlüğünden doğrulanır; çalışmıyorsa süresi dolmuş transaction'lar, oturumlar ve Sudo kanıtları ile onaylanmamış silme niyetleri birikir. Ayrıntı: [saklama kılavuzu](auth-retention-runbook.md).

## Geri dönüş

- **Hesap Merkezi:** bir önceki imajı yeniden dağıtmak. Migration'lar geri alınmaz. `0008`'den (#51, `e4738ce`) önceki imajlar `/api/ready`'de `account_native_*` tablolarını aradığı için `0003` elle yeniden uygulanmadan hazır olmaz; bu yüzden geri dönüş hedefi #51 ve sonrasıdır.
- **Audience:** kabul edilen küme yalnız `{account, core}` (A0c): `core` audience mapper'ını kaldırmak (K2'yi geri almak) bütün oturumları kilitler, çünkü `core` audience'ı olmayan token reddedilir. Önce imajı A0c'den önceki (iki kümeyi kabul eden) bir sürüme döndür; o imajda bile core çağrıları (kulüp profili, ad eşitleme) mapper olmadan çalışmaz.
- **Passkey RP ID** `yildizskylab.com`'dan geri dönmez: dönmek bütün passkey'leri yeniden geçersiz kılar.
- **K4 (e-postayla giriş, canlı):** Keycloak SPI'ı `1.14.0`'dan eski bir sürüme dönmeden önce `KEYCLOAK_PASSWORD_FORM=auth-username-password-form` ile parola formu eski hâline getirilmelidir (aksi hâlde parolalı giriş durur); ayrıntı Keycloak runbook'unda.

## Bekleyen işler

- **K4b, parola sıfırlama.** Keycloak'ın parola sıfırlama akışının da okul ya da kişisel adresi tanıması (ve "e-posta gönderildi" deyip göndermemesinin düzeltilmesi) devam ediyor (e-skylab-keycloak, PR açılacak); Account Center tarafında kod değişikliği gerekmez.
- **Hesap silme açılışı** (`ACCOUNT_ERASURE_MODE=enforce`): kod production'dadır ama kapalıdır; açılış platform kapılarına bağlıdır ([account-deletion.md](account-deletion.md#account_erasure_mode-ve-açılış-kapıları)).
- **Mobil `/.well-known` değerleri ve kök alan adı proxy'si** (OPS1b): Mobile Lab'in paket adı, parmak izi, Team ID ve bundle ID'sini vermesi bekleniyor ([kenar güveni](auth-edge-trust.md#public-yol-sınırı-internal-ve-well-known)).
- **Temizlik adayları** (acil değil): kullanılmayan `account_action_results` tablosu ve `0004` (readiness sorgusuyla birlikte), Account REST adaptöründeki hiçbir yerde çağrılmayan `linked-accounts` okumaları.
