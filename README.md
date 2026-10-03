<div align="center">
  <a href="https://yildizskylab.com">
    <img src="https://raw.githubusercontent.com/skylab-kulubu/skylab-assets/main/logos/skylab/skylab-colored.svg" alt="SKY LAB Logosu" width="120" />
  </a>

  <h1>SKY LAB Hesap Merkezi</h1>

  <p>
    SKY LAB üyeleri için güvenli ve markalı<br />
    hesap, oturum ve kimlik bilgisi yönetimi.
  </p>

  <p>
    <a href="https://my.yildizskylab.com"><img src="https://img.shields.io/badge/Canlı-my.yildizskylab.com-003694?style=for-the-badge" alt="Canlı" /></a>
    <img src="https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs" alt="Next.js 16" />
    <img src="https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React 19" />
    <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5" />
    <img src="https://img.shields.io/badge/Keycloak-26.7.4-4D4D4D?style=flat-square&logo=keycloak" alt="Keycloak 26.7.4" />
  </p>
</div>

---

## Projenin amacı

Hesap Merkezi, bir SKY LAB üyesinin kendi hesabıyla ilgili her işi tek bir arayüzden yapmasını sağlar: ad ve kullanıcı adı, okul ve kişisel e-posta, parola, geçiş anahtarları (passkey), doğrulama uygulaması, açık oturumlar, kulüp profili, yetkilerin görünümü ve hesap silme. `my.yildizskylab.com` üzerinde bağımsız bir ürün olarak çalışır; Superadmin'in veya Keycloak giriş temasının içine gömülmez.

Keycloak kimliğin tek kaynağıdır. Bu uygulama ikinci bir kullanıcı dizini oluşturmaz; tarayıcıya Keycloak erişim ya da yenileme token'ı vermez. Hassas işlemler sunucu tarafındaki BFF üzerinden yürütülür; kimlik ve kimlik bilgisi değişiklikleri Keycloak'a eklenen `sky-account` uzantısıyla (SPI) yapılır ve her biri `my.` içinde alınan bir Sudo modu kanıtı ister.

## Özellikler

- **Kimlik** (`/identity`): ad ve soyad (doğrulanmış YTÜ hesabında YTÜ kaydından gelir ve kilitlidir; diğer hesaplarda değişiklik SPI'ye yazılır ve core'daki kulüp profili adı hemen ardından eşitlenir, eşitleme başarısız olursa uyarı çıkar), kullanıcı adı değişikliği (benzersizlik ve 14 günlük bekleme SPI'de; sonuçları anlatan onay penceresi ve Sudo modu), YTÜ durumu ve okul / birincil e-posta satırları. Doğrulanmamış hesap "YTÜ hesabımı bağla" ile (onay penceresi, Sudo modu, Keycloak `kc_action=idp_link`) Microsoft girişine gider; dönüşte bağlantı kimlik yeniden okunarak doğrulanır. Bağlantıyı kaldırma yoktur. `/personal-information` kalıcı olarak `/identity` adresine yönlenir.
- **E-posta ve giriş** (`/email`): okul e-postası (salt okunur; doğrulanmış YTÜ hesabında rozetli), kişisel e-postayı adrese gönderilen altı haneli kodla ekleme, değiştirme ve kaldırma (Sudo modu; kod aynı sayfada girilir, sayfa yenilense de bekleyen kod geri gelir) ve birincil adres seçimi (Sudo modu). Kulüp postaları birincil adrese gider. Parolayla girişte kullanıcı adı, birincil e-posta, YTÜ'ye bağlı hesabın okul e-postası ve kodla doğrulanmış kişisel e-posta kullanılabilir (K4); doğrulanmamış bir adres yanlış parolayla aynı cevabı alır.
- **Giriş ve güvenlik** (`/security`): parola değiştirme ya da belirleme (realm parola politikası geri bildirimiyle, isteğe bağlı olarak diğer cihazlardaki oturumları kapatarak), doğrulama uygulaması (TOTP) kurulumu (QR kodu tarayıcıda çizilir), passkey ekleme (WebAuthn `my.` üzerinde çalışır) ve kimlik bilgisi kaldırma. Her adım Sudo modundan geçer ve Keycloak'a yönlendirme gerektirmez.
- **Sudo modu**: hassas işlemlerden önce parola, passkey ya da doğrulama koduyla beş dakikalık yeniden doğrulama; hiçbiri yoksa Microsoft ile yeniden giriş. Kanıt sunucuda şifreli saklanır.
- **Kulüp profili** (`/club-profile`): SKY numarası, öğrenci kartı durumu, okul e-postası ve telefon salt okunur; üniversite, fakülte, bölüm ve LinkedIn bağlantısı düzenlenebilir (YTÜ'ye bağlı kişide ilk üçü YTÜ hesabından gelir ve salt okunurdur); profil fotoğrafı önizlemeyle yüklenir, değiştirilir ya da kaldırılır. Veriler core `/v1/users/me` uçlarından aynı kullanıcı token'ıyla okunur ve yazılır; `CORE_API_URL` tanımsızsa sayfa kapalı olduğunu söyler.
- **Oturumlar ve cihazlar** (`/sessions`): açık oturumları görüntüleme, tek tek ya da mevcut cihaz dışında hepsini kapatma.
- **Yetkilerim** (`/permissions`): takımlar, liderlik ve yetki seviyesi (Yönetim, Yönetim Kurulu, Denetim Kurulu) ile uygulama yetkilerinin salt okunur, Türkçe görünümü; ham rol kodları ve grup yolları yalnız katlanmış "Teknik ayrıntılar" bölümündedir, realm rolleri hiç gösterilmez.
- **Hesap silme** (`/delete-account`): dayanıklı, yeniden denenebilir silme/anonimleştirme isteği (niyet onayı, Sudo modu, birebir `HESABIMI SİL` metni); silmeyi core yönetir. Kod production'dadır ama `ACCOUNT_ERASURE_MODE=off` ile kapalıdır; sayfa bunu söyler.
- **SkyApp WebView'ı**: SkyApp'ten Keycloak'ın Web handoff'uyla oturum açık gelen kişide uygulamanın kendi üst çubuğuna yer bırakan görünüm; oturum ömrü Keycloak oturumunun gerçek bitişine göre sayılır ([web-handoff.md](docs/web-handoff.md)).
- SKY LAB tasarım dili, erişilebilir klavye kullanımı ve mobil uyumlu arayüz.

## Mimari

| Katman | Sorumluluk |
| --- | --- |
| Next.js App Router | Sayfalar, sunucu bileşenleri ve HTTP uçları |
| BFF | OIDC (PAR + PKCE), token saklama, CSRF, Sudo modu ve oturum işlemleri |
| Keycloak | Kullanıcı, credential, grup ve giriş oturumlarının kaynağı; Account REST ile salt okuma |
| sky-account SPI | Keycloak içindeki kimlik / kimlik bilgisi değişiklikleri ve Sudo token'ı (`${OIDC_ISSUER}/sky-account/v1`) |
| PostgreSQL | Şifreli token setleri, opak oturumlar ve tek kullanımlık işlemler |
| Redis | Platform çapındaki hesap erişim engeli için salt okunur güven sınırı |
| Core API | Kulüp profili (`/v1/users/me`) ve silme/anonimleştirme iş akışının koordinasyonu |

Tarayıcı yalnız `Secure`, `HttpOnly`, `SameSite` ve `__Host-` kurallarına uyan opak çerezler taşır. Keycloak token setleri PostgreSQL'de AES-256-GCM ile şifrelenir. Ayrıntı: [mimari belgesi](docs/architecture.md).

## Güvenlik ilkeleri

- Authorization Code + S256 PKCE + PAR zorunludur; authorization scope tam olarak `openid`'dır.
- Gizli anahtarlar `NEXT_PUBLIC_` değişkenlerine konamaz ve istemci paketine giremez.
- Parola, geçiş anahtarı, TOTP, e-posta ve kullanıcı adı değişiklikleri sky-account SPI ile yapılır; BFF beş dakikalık, şifreli saklanan bir Sudo modu kanıtı olmadan hassas değişiklikleri iletmez. Parola, kod, sır ya da attestation hiçbir log ya da yanıta yazılmaz.
- Keycloak'a gönderilen tek application-initiated action YTÜ hesabı bağlamadır (`kc_action=idp_link`, yalnız `YTU_IDP_ALIAS` için); başka hiçbir `kc_action` istek gövdesine giremez.
- Credential kimlikleri ve Keycloak oturum kimlikleri tarayıcıya verilmez; yalnız oturuma bağlı HMAC referansları görünür.
- Hesap erişim engeli doğrulanamazsa kimlik doğrulanmış işler güvenli biçimde `503` ile kapanır; çıkış ve temizlik yolları çalışmaya devam eder.
- `/internal/*` her zaman `404`'tür; `/.well-known/*` giriş yönlendirmesinden muaftır ([kenar güveni](docs/auth-edge-trust.md)).

## Hızlı başlangıç

Gereksinimler: Node.js 22+, pnpm 12 ve PostgreSQL.

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm db:migrate` ve `pnpm dev` ortam değişkeni ister ([aşağıda](#ortam-değişkenleri)); gerçek bir giriş akışı erişilebilir bir Keycloak gerektirir. Tarayıcı testleri oturumu veritabanına kendileri tohumlar, kimlik doğrulamayı atlayan özel bir yol yoktur.

Tam doğrulama:

```bash
pnpm check
docker build -t account-center:local .
```

`pnpm check`; lint, tip kontrolü, birim testleri, betik testleri ve üretim derlemesini birlikte çalıştırır. Ayrı komutlar: `pnpm test:e2e` (Playwright; önce `pnpm exec playwright install chromium`, gerçek HTTPS, PostgreSQL migration'ı ve gerçek opak oturum kaydı), `pnpm test:retired-handoff` ve `pnpm test:edge-paths` (üretim derlemesiyle çalışan sunucuya karşı; sırasıyla `RETIRED_HANDOFF_TEST_ORIGIN` ve `EDGE_PATHS_TEST_ORIGIN` ister). PostgreSQL ve Redis entegrasyon testleri `TEST_DATABASE_URL` ve `TEST_ACCOUNT_ACCESS_REDIS_URL` tanımlıysa çalışır, tanımsızsa atlanır.

## Ortam değişkenleri

Güvenli örnek değerler [`.env.example`](.env.example) dosyasındadır; gerçek gizli bilgiler repoya eklenmez. Konteyner girişi `node scripts/start.mjs`'tir (üretim imajında pnpm yoktur); açılışta bütün değişkenleri doğrular (`scripts/validate-env.mjs`) ve geçersiz ya da yer tutucu içeren bir değer süreci başlatmaz.

| Değişken | Zorunlu | Anlamı |
| --- | --- | --- |
| `APP_URL` | evet | Canonical, credential'sız HTTPS origin (`https://my.yildizskylab.com`). |
| `DATABASE_URL` | evet | Kimlik bilgili PostgreSQL URL'si. |
| `SESSION_SECRET` | evet | base64/base64url, en az 32 bayt; CSRF, referans ve hız sınırı HMAC anahtarı. |
| `TOKEN_ENCRYPTION_KEY` | evet | base64/base64url, tam 32 bayt; token, Sudo ve transaction şifreleme anahtarı (AES-256-GCM). |
| `OIDC_ISSUER` | evet | Canonical `https://<host>/realms/<realm>`; erişim engeli `enforce` iken tam olarak `https://e.yildizskylab.com/realms/e-skylab`. |
| `OIDC_CLIENT_ID` | evet | Tam olarak `account-center`. |
| `OIDC_CLIENT_SECRET` | evet | Confidential client sırrı, en az 32 karakter. |
| `OIDC_UPSTREAM_SESSION_MAX_SECONDS` | evet | Doğrulanmış Keycloak SSO Session Max değeri (60 sn – 30 gün); `sky_session_expires` yokken oturum bitişinin tahmini. |
| `AUTH_TRUSTED_PROXY` | evet | `traefik`, `cloudflare` ya da `none`: istemci adresi hangi kenardan okunur ([kenar güveni](docs/auth-edge-trust.md)). |
| `AUTH_TRUSTED_PROXY_RANGES` | hayır | `traefik` modunda atlanacak proxy hop CIDR blokları; tanımsızsa özel ağ aralıkları. |
| `ACCOUNT_ACCESS_GATE_MODE` | evet | `enforce` ya da `off`. `enforce` iken aşağıdaki `ACCOUNT_ACCESS_REDIS_*` on bir değişkenin tamamı zorunludur (`HOST`, `PORT`, `USERNAME`, `PASSWORD`, `DATABASE`, `TLS` (`true` olmak zorunda), `TLS_SERVER_NAME`, `CA_CERT_FILE`, `TLS_CERT_FILE`, `TLS_KEY_FILE` ve `OPERATION_TIMEOUT_MS` (50-1000)); sertifika ve anahtar okunabilir PEM dosyalarıdır. |
| `ACCOUNT_ERASURE_MODE` | hayır | `off` (varsayılan) ya da `enforce`; `enforce` erişim engeli `enforce` ve `CORE_API_URL` ister ([hesap silme](docs/account-deletion.md)). |
| `CORE_API_URL` | hayır | Core'un canonical HTTPS origin'i. Tanımsızsa kulüp profili özellikleri kapalı kalır. |
| `PROFILE_PICTURE_ORIGIN` | hayır | Core'un profil fotoğraflarını yayımladığı origin; CSP `img-src` yalnız bunu ek olarak tanır (varsayılan `https://cdn.yildizskylab.com`). |
| `YTU_IDP_ALIAS` | hayır | YTÜ Microsoft identity provider'ının Keycloak alias'ı (1-64 karakter `[A-Za-z0-9_-]`; varsayılan `OBS`). "YTÜ hesabımı bağla" yalnız bu alias için `kc_action=idp_link` ister; Keycloak tarafında `account-center` istemcisinin `account.manage-account-links` scope mapping'ine, kişinin de `account.manage-account` ya da `account.manage-account-links` rolüne ihtiyaç vardır (K2 reconcile). |
| `ANDROID_ASSET_LINKS_PACKAGE_NAME`, `ANDROID_ASSET_LINKS_SHA256_CERT_FINGERPRINTS` | hayır | İkisi birlikte ya hiç: `/.well-known/assetlinks.json`'u üretir; tanımsızsa `404`. |
| `APPLE_APP_SITE_ASSOCIATION_TEAM_ID`, `APPLE_APP_SITE_ASSOCIATION_BUNDLE_ID` | hayır | İkisi birlikte ya hiç: `/.well-known/apple-app-site-association`'ı üretir; tanımsızsa `404`. Biçimler [kenar güveni belgesinde](docs/auth-edge-trust.md#public-yol-sınırı-internal-ve-well-known). |
| `PORT`, `HOSTNAME` | hayır | Sunucu bağlama adresi (konteynerde `3000` ve `0.0.0.0`). |

Okunmayan ya da emekli değişkenler: `NATIVE_BRIDGE_HMAC_SECRET` ve `NATIVE_BRIDGE_MTLS_CLIENT_SHA256` kaldırıldı ([web-handoff.md](docs/web-handoff.md)); `validate-env.mjs` yedi adlı değişkenin `NEXT_PUBLIC_` önekli hâlini (`DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `OIDC_CLIENT_SECRET`, `ACCOUNT_ACCESS_REDIS_PASSWORD`, `ACCOUNT_ACCESS_REDIS_TLS_KEY_FILE`, `CORE_API_URL`) tanımlı bulursa başlatmayı reddeder; başka `NEXT_PUBLIC_` değişkenleri denetlenmez. Yalnız geliştirme ve test için okunanlar: `TEST_DATABASE_URL`, `TEST_ACCOUNT_ACCESS_REDIS_URL`, `E2E_PORT`, `E2E_MOCK_CORE_PORT`, `E2E_ERASURE_PORT`, `E2E_ERASURE_MOCK_CORE_PORT`, `RETIRED_HANDOFF_TEST_ORIGIN`, `EDGE_PATHS_TEST_ORIGIN`, `NEXT_DIST_DIR` ve `CI`.

## Üretim işletimi

Sürüm akışı, migration sırası, doğrulama ve geri dönüş [rollout-v2.md](docs/rollout-v2.md) belgesindedir. Özet:

- Migration'lar üretim imajının içinden, yeni sürüm trafiğe alınmadan önce uygulanır (şemayı daraltan bir migration hariç; yedek ve geri yükleme provası gerekir):

  ```bash
  node scripts/migrate.mjs
  ```

- Süresi dolmuş veya iptal edilmiş kimlik materyalini temizleyen iş dağıtım zamanlayıcısında saatte bir, tekil görev olarak çalıştırılır ([saklama kılavuzu](docs/auth-retention-runbook.md)):

  ```bash
  node scripts/prune-auth.mjs
  ```

- `/api/health` yalnız proses canlılığını; `/api/ready` ortam yapılandırmasının ayrıştırılabildiğini, PostgreSQL tablolarını ve migration kayıtlarını ve gerekli erişim engeli sınırını doğrular. Trafik yalnız readiness başarılı olduğunda yönlendirilmelidir.
- Keycloak kullanıcı token'ı sözleşmesi bugün `aud` için iki küme kabul eder (`{account, core}` ve eski `{account}`); eski küme her kabulde `token_audience_legacy` olayı üretir ve sıfır olduğu kanıtlanınca kaldırılacaktır ([Keycloak sözleşmesi](docs/keycloak-26.7.4-contract.md#geçiş-sırası)).

## Ayrıntılı belgeler

- [Mimari ve güven sınırları](docs/architecture.md)
- [Keycloak 26.7.4 sözleşmesi](docs/keycloak-26.7.4-contract.md)
- [sky-account API v1 sözleşmesi](docs/sky-account-api.md)
- [Hesap işlemleri: kimlik, e-posta, parola, TOTP ve passkey](docs/account-actions.md)
- [Web handoff (SkyApp'ten `my.`'ye)](docs/web-handoff.md)
- [Hesap silme ve anonimleştirme](docs/account-deletion.md)
- [Kenar güveni, `/internal` ve `/.well-known`](docs/auth-edge-trust.md)
- [Kimlik materyali saklama ve temizlik kılavuzu](docs/auth-retention-runbook.md)
- [v2 yayın kaydı ve işletim](docs/rollout-v2.md)

Sözlük (Sudo mode, sky-account SPI, Web handoff, Verified YTÜ account…) ve mimari kararlar (ADR) `skylab-kulubu/e-skylab` deposundadır.

## Ürün sınırları

- Telefon (salt okunur görünüm dışında), öğrenci kartı, kulüp rolleri, SkyPass ve etkinlik verileri Core'un alanıdır.
- Hesap Merkezi Keycloak'ın yerine geçmez ve kullanıcı parolası saklamaz.
- Superadmin kulüp operasyon panelidir; kişisel hesap güvenliği burada yönetilmez.
- Mobil uygulama entegrasyonu ayrı, sürümlü bir sözleşmeyle yapılır.

## Katkıda bulunanlar

Projeye katkı veren kişiler GitHub commit geçmişinden otomatik olarak
listelenir.

<a href="https://github.com/skylab-kulubu/account-center/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=skylab-kulubu/account-center" alt="Katkıda bulunanlar" />
</a>

## Geliştiren ekip

<div align="center">
  <p>SKY LAB Hesap Merkezi, kulüp ekiplerinin ürün geri bildirimleriyle <strong>WebLab</strong> tarafından geliştirilmektedir.</p>
  <a href="https://github.com/skylab-kulubu">
    <img src="https://raw.githubusercontent.com/skylab-kulubu/skylab-assets/main/logos/arge/weblab/weblab-colored.svg" alt="SKY LAB WebLab" width="150" />
  </a>
</div>
