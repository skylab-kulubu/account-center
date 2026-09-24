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

- Kimlik sayfası: ad ve soyad (doğrulanmış YTÜ hesabında YTÜ kaydından gelir
  ve kilitlidir, diğer hesaplarda yerinde düzenlenir; değişiklik sky-account
  SPI'ye yazılır ve core'daki kulüp profili gölgesi aynı işlemde eşitlenir),
  kullanıcı adı değişikliği (benzersizlik ve 14 günlük bekleme SPI'de,
  sonuçları anlatan onay penceresi ve Sudo modu), YTÜ durumu ve birincil /
  okul e-postası satırları. Doğrulanmamış hesap "YTÜ hesabımı bağla" ile
  sonuçları anlatan bir onay penceresi ve Sudo modundan sonra Keycloak'ın
  `idp_link` işlemine gider (Microsoft girişi; dönüşte bağlantı `GET identity`
  ile doğrulanır, ad ve okul e-postası kilitlenir; bağlantı kaldırma yoktur).
  `/personal-information` kalıcı olarak `/identity` adresine yönlenir.
- Hassas işlemlerden önce ürün içi "kimliğini doğrula" adımı (Sudo modu):
  parola, passkey ya da doğrulama kodu ile beş dakikalık, sunucuda şifreli
  saklanan yeniden doğrulama; hiçbiri yoksa Microsoft ile yeniden giriş.
  Dönüşte BFF, taze ID token'ı sky-account `POST sudo/authentication` ucuna
  sunar ve aldığı sudo token'ı aynı beş dakikalık pencere için saklar, böylece
  ürün içi yöntemi olmayan kişi de güvenlik sayfasındaki işlemleri yapabilir.
- Giriş ve güvenlik sayfası tamamen `my.` içinde: parola değiştirme ya da
  belirleme (realm parola politikası geri bildirimiyle, isteğe bağlı olarak
  diğer cihazlardaki oturumları kapatarak), doğrulama uygulaması (TOTP)
  kurulumu tarayıcıda çizilen QR kodu ve elle giriş anahtarıyla, passkey
  ekleme WebAuthn ceremony'si `my.` üzerinde çalışarak ve kimlik bilgisi
  kaldırma. Her adım Sudo modundan geçer ve sky-account SPI ile yapılır;
  Keycloak'a yönlendirme yoktur.
- E-posta ve giriş sayfası (`/email`): okul e-postası (salt okunur,
  doğrulanmış YTÜ hesabında rozetli), kişisel e-posta ekleme ve değiştirme
  (Sudo modu, ardından adrese gönderilen altı haneli kodun aynı sayfada
  girilmesi; on dakikalık geri sayım, yeni kod isteme, yanlış / tükenmiş /
  süresi dolmuş kod mesajları; sayfa yenilense ya da posta uygulamasından
  dönülse de bekleyen kod paneli geri gelir) ve kaldırma, birincil adres
  seçimi (Sudo modu). Kulüp postaları birincil adrese gider; iki adresle de
  giriş yapılabilir.
- Bu sürüm v2 sözleşmelerini ve istemcilerini taşır (genişletilmiş token
  sözleşmesi, sky-account SPI istemcisi, core kulüp profili istemcisi, şifreli
  sudo saklama ve doğrulama diyaloğu).
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
- SkyApp'ten Keycloak Web handoff'uyla (ADR-0048) oturum açık gelen kişi
  için uygulamanın kendi üst çubuğuna yer bırakan görünüm; oturum ömrü
  Keycloak oturumunun gerçek bitişine (`sky_session_expires`) göre sayılır.
  Eski native SSO köprüsü kaldırıldı.
- Dayanıklı, izlenebilir ve yeniden denenebilir hesap silme/anonimleştirme
  süreci: niyet onayı, Sudo modu, birebir `HESABIMI SİL` metni ve gönderim.
  Core intake'i taze bir ID token istediği için, oturumda yeterince yeni bir
  giriş yoksa araya bugünkü Keycloak doğrulaması girer ve sayfa nedenini
  söyler.
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
- Parola, geçiş anahtarı ve TOTP değişiklikleri Keycloak'ın kendi servislerini
  kullanan sky-account uzantısıyla yapılır; BFF beş dakikalık, şifreli saklanan
  bir Sudo modu kanıtı olmadan hiçbir değişikliği iletmez ve parola, kod, sır
  ya da attestation hiçbir log ya da yanıta yazılmaz.
- Keycloak'a gönderilen tek application-initiated action YTÜ hesabı bağlama
  (`kc_action=idp_link`, yalnız `YTU_IDP_ALIAS` için) olur; başka hiçbir
  `kc_action` istek gövdesine giremez. Geri alınamaz bir işlem olduğu için
  Sudo modu ister, tarayıcı yalnız sunucudan basılan Keycloak origin'ine
  yönlendirilir ve bağlantı Keycloak'ın "başarılı" demesiyle değil, kimliğin
  yeniden okunmasıyla doğrulanır.
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

Migration'lar normalde yeni sürüm trafiğe alınmadan önce uygulanır.
`0008_drop_native_handoff.sql` ile gelen sürümde sıra terstir: önce sürüm
deploy edilir, `pnpm db:migrate` ancak sürüm her yerde yayındayken, yedek
alınıp geri yüklemesi denendikten sonra çalıştırılır (ops sihirbazı
`account-center-drop-native-tables-wizard.sh`). `db:migrate` bekleyen her
dosyayı uyguladığı için `0008`'i atlayamaz; erken çalışırsa eski sürüm
readiness'i kaybeder. Ayrıntı
[saklama kılavuzunda](docs/auth-retention-runbook.md#doğrulama-ve-geri-dönüş).

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
kulüp profili özellikleri kapalı kalır. `PROFILE_PICTURE_ORIGIN` de isteğe
bağlıdır: core'un profil fotoğraflarını yayımladığı origin'dir, Content
Security Policy `img-src` yalnız bu origin'i ek olarak tanır; tanımsızsa
`https://cdn.yildizskylab.com` kullanılır, tanımlıysa credential'sız,
canonical bir HTTPS origin olmak zorundadır. `YTU_IDP_ALIAS` de isteğe
bağlıdır: YTÜ Microsoft identity provider'ının Keycloak alias'ıdır, tanımsızsa
`OBS` kullanılır, tanımlıysa 1-64 karakterlik URL-güvenli bir alias olmak
zorundadır; "YTÜ hesabımı bağla" yalnız bu alias için `kc_action=idp_link`
ister ve Keycloak tarafında `account-center` istemcisinin
`account.manage-account-links` scope mapping'ine, kişinin de
`account.manage-account` rolüne ihtiyaç duyar (K2 reconcile). Yeni bir gizli
değer gerekmez; sudo proof'ları mevcut `TOKEN_ENCRYPTION_KEY` ile oturum
kaydında şifrelenir.

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
- [Parola, TOTP ve passkey işlemleri](docs/account-actions.md)
- [Native SSO köprüsü (emekli)](docs/native-handoff-keycloak-contract.md)
- [Kenar güveni ve rate limit](docs/auth-edge-trust.md)
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
