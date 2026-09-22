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

Hesap Merkezi, bir SKY LAB üyesinin kişisel bilgilerini, parolasını, geçiş
anahtarlarını ve açık oturumlarını tek bir arayüzden yönetmesini sağlar.
`my.yildizskylab.com` üzerinde bağımsız bir ürün olarak çalışır; Superadmin'in
veya Keycloak giriş temasının içine gömülmez.

Keycloak kimliğin tek kaynağıdır. Bu uygulama ikinci bir kullanıcı dizini
oluşturmaz; tarayıcıya Keycloak erişim ya da yenileme token'ı vermez. Hassas
işlemler sunucu tarafındaki BFF üzerinden yürütülür.

## Özellikler

- Ad, soyad ve birincil e-posta bilgilerinin güvenli görünümü.
- Hassas işlemlerden önce ürün içi "kimliğini doğrula" adımı (Sudo modu):
  parola, passkey ya da doğrulama kodu ile beş dakikalık, sunucuda şifreli
  saklanan yeniden doğrulama; hiçbiri yoksa Microsoft ile yeniden giriş.
- Parola, TOTP ve geçiş anahtarı işlemleri için yeniden doğrulamalı Keycloak
  AIA akışları (ürün içi güvenlik yüzeyi A5 ile Sudo modu üzerinden sky-account
  SPI'ye taşınır).
- Bu sürüm v2 sözleşmelerini, istemcilerini ve Sudo modunu taşır
  (genişletilmiş token sözleşmesi, sky-account SPI istemcisi, core kulüp
  profili istemcisi, şifreli sudo saklama ve doğrulama diyaloğu). Kullanıcı
  adı, e-posta ve ürün içi güvenlik yüzeyleri A1–A5 işleriyle gelir; bu
  sürümde arayüzde yer almaz.
- Kulüp profili: SKY numarası, öğrenci kartı durumu, okul e-postası ve kendi
  telefonun salt okunur; üniversite, fakülte, bölüm ve LinkedIn bağlantısı
  düzenlenebilir; profil fotoğrafı önizlemeyle yüklenir, değiştirilir veya
  kaldırılır. Veriler core `/v1/users/me` uçlarından aynı kullanıcı
  token'ıyla okunup yazılır; `CORE_API_URL` tanımsız ortamlarda sayfa
  kapalı olduğunu söyler ve kimlik özetini yine gösterir.
- Açık cihaz ve tarayıcı oturumlarını görüntüleme, tek tek kapatma veya mevcut
  cihaz dışındaki tüm oturumları sonlandırma.
- Yetkilerim: takımlar, liderlik ve yetki seviyesi (Yönetim/Denetim) ile
  uygulama yetkilerinin salt okunur, Türkçe görünümü; ham rol kodları ve grup
  yolları yalnız katlanmış "Teknik ayrıntılar" bölümünde, realm rolleri hiç
  gösterilmez.
- Yerel uygulamalar için tek kullanımlık, mTLS ve HMAC korumalı native SSO
  köprüsü.
- Dayanıklı, izlenebilir ve yeniden denenebilir hesap silme/anonimleştirme
  süreci.
- SKY LAB tasarım dili, erişilebilir klavye kullanımı ve mobil uyumlu arayüz.

## Mimari

| Katman | Sorumluluk |
| --- | --- |
| Next.js App Router | Sayfalar, sunucu bileşenleri ve HTTP uçları |
| BFF | OIDC/PAR/PKCE, token saklama, CSRF ve oturum işlemleri |
| Keycloak | Kullanıcı, credential, grup ve kimlik oturumlarının kaynağı |
| PostgreSQL | Şifreli token setleri, opaque oturumlar ve tek kullanımlık işlemler |
| Redis | Platform çapındaki hesap erişim engeli için salt okunur güven sınırı |
| sky-account SPI | Keycloak içindeki kimlik/kimlik bilgisi değişiklikleri ve Sudo modu (`${OIDC_ISSUER}/sky-account/v1`) |
| Core API | Kulüp profili (`/v1/users/me`) ve silme/anonimleştirme iş akışının koordinasyonu |

Tarayıcı yalnız `Secure`, `HttpOnly`, `SameSite` ve `__Host-` kurallarına uyan
opaque bir oturum çerezi taşır. Keycloak token setleri PostgreSQL'de
AES-256-GCM ile şifrelenir.

## Güvenlik ilkeleri

- Authorization Code + S256 PKCE + PAR zorunludur.
- Gizli anahtarlar `NEXT_PUBLIC_` değişkenlerine konamaz ve istemci paketine
  giremez.
- Parola, geçiş anahtarı ve TOTP değişiklikleri uygulama tarafından taklit
  edilmez; Keycloak'ın yeniden doğrulamalı akışları kullanılır.
- Oturum kapatma işlemlerinde ham Keycloak oturum kimliği tarayıcıya verilmez.
- Hesap erişim engeli doğrulanamazsa kimlik doğrulanmış işler güvenli biçimde
  `503` ile kapanır; çıkış ve temizlik yolları çalışmaya devam eder.
- Hesap silme özelliği, bütün platform okuyucuları aynı engelleme sözleşmesini
  uygulamadan üretimde etkinleştirilmez.

## Hızlı başlangıç

Gereksinimler: Node.js 22+, pnpm ve PostgreSQL.

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Tam doğrulama:

```bash
pnpm check
docker build -t account-center:local .
```

`pnpm check`; lint, tip kontrolü, birim testleri, betik testleri ve üretim
derlemesini birlikte çalıştırır. Uçtan uca tarayıcı testleri gerçek HTTPS,
PostgreSQL migration'ı ve gerçek opaque oturum kaydı kullanır; kimlik
doğrulamasını atlayan özel bir test yolu yoktur.

## Üretim işletimi

İlk açılıştan önce veritabanı migration'larını üretim imajı içinden çalıştırın:

```bash
pnpm db:migrate
```

Süresi dolmuş veya iptal edilmiş kimlik materyalini temizleyen işi dağıtım
zamanlayıcısında saatte bir, tekil görev olarak çalıştırın:

```bash
pnpm db:prune-auth
```

`/api/health` yalnız proses canlılığını; `/api/ready` ise ortam sözleşmesini,
PostgreSQL bağlantısını, migration sürümünü ve gerekli erişim engeli sınırını
doğrular. Trafik yalnız readiness başarılı olduğunda yönlendirilmelidir.

Ortam değişkenlerinin tam listesi ve güvenli örnek değerleri
[`.env.example`](.env.example) dosyasındadır. Gerçek gizli bilgiler repoya
eklenmez. `CORE_API_URL` isteğe bağlıdır: tanımlıysa kulüp profili çağrıları
için canonical, credential'sız bir HTTPS origin olmak zorundadır; tanımsızsa
kulüp profili özellikleri kapalı kalır. Yeni bir gizli değer gerekmez;
sudo proof'ları mevcut `TOKEN_ENCRYPTION_KEY` ile oturum kaydında şifrelenir.

Sürüm geçişi: bu sürüm Keycloak kullanıcı token'ında K2 geçişi boyunca
eski `aud=account` ve güncel `aud=["account","core"]` kümelerinden tam olarak
birini kabul eder; eski küme her doğrulamada `token_audience_legacy` log
olayı üretir. Sıra: önce bu imaj dağıtılır, sonra Keycloak reconcile (K2)
uygulanır, en geç 8 saat içinde loglarda sıfır `token_audience_legacy` olayı
doğrulanır, ardından takip bileti A0c ile sözleşme tek kümeye daraltılır;
ayrıntı [Keycloak sözleşmesinde](docs/keycloak-26.7.4-contract.md).

## Ayrıntılı belgeler

- [Mimari ve güven sınırları](docs/architecture.md)
- [Keycloak 26.7.4 sözleşmesi](docs/keycloak-26.7.4-contract.md)
- [sky-account API v1 sözleşmesi](docs/sky-account-api.md)
- [Parola, TOTP ve geçiş anahtarı işlemleri](docs/account-actions.md)
- [Native SSO köprüsü](docs/native-handoff-keycloak-contract.md)
- [Kenar güveni ve mTLS](docs/auth-edge-trust.md)
- [Kimlik materyali saklama ve temizlik kılavuzu](docs/auth-retention-runbook.md)
- [Hesap silme ve anonimleştirme](docs/account-deletion.md)

## Ürün sınırları

- Telefon (salt okunur görünüm dışında), öğrenci kartı, kulüp rolleri, SkyPass
  ve etkinlik verileri Core'un alanıdır.
- Hesap Merkezi Keycloak'ın yerine geçmez ve kullanıcı parolası saklamaz.
- Superadmin kulüp operasyon panelidir; kişisel hesap güvenliği burada
  yönetilmez.
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
