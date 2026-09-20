# SKY LAB Account Center

`my.yildizskylab.com` için bağımsız SKY LAB hesap yönetimi ürünü. Next.js App Router ve sunucu taraflı BFF mimarisi kullanır. Keycloak kimliğin kaynağıdır; tarayıcı hiçbir zaman Keycloak access veya refresh token’ı almaz.

## Geliştirme

```bash
pnpm install
pnpm dev
```

Doğrulama:

```bash
pnpm check
docker build -t account-center:local .
```

Playwright browser testi auth bypass kullanmaz. Loopback `_test` PostgreSQL’e migration uygulandıktan sonra her test ve retry kendine yeni, şifreli bir opaque session kaydı üretir. Test server’ı git tarafından yok sayılan `.e2e-certificates` dizininde geçici self-signed HTTPS sertifikası üretir; Chromium’un host-only `Secure __Host-` cookie’yi kabul ettiğini, shell refresh çağrısının handle’ı döndürdüğünü ve gerçek logout formunun session’ı hard-delete ettiğini doğrular. CI browser job’ı PostgreSQL service, migration ve gerekli test environment’ını otomatik hazırlar.

İlk açılıştan önce BFF oturum tablolarını production image içinden oluştur:

```bash
node scripts/migrate.mjs
```

Auth materyali retention işi uygulama timer’ı değildir. Deployment scheduler’ında tekil bir job olarak saatte bir `node scripts/prune-auth.mjs` çalıştırılır; advisory lock aynı anda yalnız bir job’ın silme yapmasını sağlar. Tüketilmiş/süresi dolmuş OIDC transaction’ları 1 saat, revoke olmuş veya mutlak/idle süresi dolmuş session kayıtları 24 saatlik operasyonel grace sonrasında token ciphertext’iyle birlikte hard-delete edilir. Süresi dolmuş logout replay, rate-limit bucket ve tek kullanımlık action-result kayıtları da aynı job’da temizlenir. Job sonucu yalnız silinen kayıt sayılarını loglar. Kurulum, alarm ve hata kurtarma adımları [auth retention runbook'unda](docs/auth-retention-runbook.md) tanımlıdır.

Production başlangıcında `.env.example` içindeki sunucu değişkenleri doğrulanır. Secret’lar `NEXT_PUBLIC_` önekiyle tanımlanamaz ve client bundle’a taşınmaz. Dosyadaki köşeli parantezli değerler bilerek geçersizdir; doğrudan kullanılırsa servis başlamaz. `SESSION_SECRET` için `openssl rand -base64 48`, `TOKEN_ENCRYPTION_KEY` için `openssl rand -base64 32` kullanılabilir. Keycloak client secret en az 32 karakterli gerçek confidential-client secret’ı olmalıdır.

Ortak hesap engelleme sözleşmesi `ACCOUNT_ACCESS_GATE_MODE=off|enforce` ile açıkça seçilir. `enforce`, yalnız `https://e.yildizskylab.com/realms/e-skylab` issuer’ını ve `.env.example` içindeki ayrı Redis host/port/kullanıcı/şifre/DB/TLS/deadline değerlerinin tamamını kabul eder; production’da TLS kapatılamaz. Bu Redis uygulama cache’i değildir: ayrı `noeviction` keyspace, kalıcı AOF ve read-only Account Center ACL’i kullanır. Readiness tam v1 contract sentinel’ını okur; liveness Redis’e dokunmaz. Contract/Redis doğrulanamazsa kimlik doğrulanmış iş 503 ile kapanır ve session idle/rotation süresi uzatılmaz.

Engelli bir subject mevcut opaque cookie ile geldiğinde bütün yerel Account Center session’ları revoke edilir ve cookie temizlik rotasında silinir. Callback ile native handoff create/consume/redeem akışları da session veya tek-kullanımlık durum oluşturmadan önce aynı gate kararını uygular. Local logout ile imzalı Keycloak backchannel logout, gate erişilemese bile yalnız temizlik yapabildiği için kullanılabilir kalır. Platformdaki bütün reader servisler aynı sözleşmeyi `enforce` etmeden hesap silme intake/worker açılmamalıdır.

Native SSO köprüsü için `NATIVE_BRIDGE_HMAC_SECRET`, `SESSION_SECRET` ve `TOKEN_ENCRYPTION_KEY` değerlerinden farklı ayrı bir 32-byte secret; `NATIVE_BRIDGE_MTLS_CLIENT_SHA256` ise internal ingress’in doğruladığı Keycloak client certificate’ın lowercase SHA-256 fingerprint’idir. Public native kod, PAR bridge ve Keycloak authenticator sözleşmesi [native handoff belgesinde](docs/native-handoff-keycloak-contract.md) tanımlıdır. SPI ve gerçek WebView/AIA production-clone testi tamamlanmadan bu akış production’a açılmaz.

`APP_URL` credentials, path, query, fragment, trailing slash veya normalize edilen port içermeyen canonical HTTPS origin olmalıdır. `OIDC_ISSUER` aynı kurallara ek olarak tam `https://<host>/realms/<realm>` biçimini taşır. Startup doğrulaması ile runtime/readiness aynı fixture tabanlı kabul-red sözleşmesine karşı test edilir.

`/api/health` yalnız proses liveness’ını, `/api/ready` ise production environment sözleşmesini, PostgreSQL erişimini ve beklenen migration sürümlerini doğrular. Trafik yalnız readiness 200 döndüğünde yönlendirilmelidir.

Browser login katmanı Authorization Code + S256 PKCE + PAR kullanır. OIDC transaction ve opaque session kayıtları PostgreSQL’dedir; Keycloak token setleri AES-256-GCM ile şifrelenir. 26.7.4 realm/client configuration-as-code ve production-clone doğrulaması tamamlanmadan canlı Keycloak entegrasyonu açılmamalıdır. Ayrıntılı blok listesi [Keycloak sözleşme notunda](docs/keycloak-26.7.4-contract.md) yer alır.

Şifre, passkey ve TOTP değişiklikleri aynı callback URI’sini kullanan server-side PAR/AIA akışlarıdır. Allowlist, sahiplik referansı, fresh-auth ve başarı sonrası credential envanteri doğrulaması [hesap aksiyonları sözleşmesinde](docs/account-actions.md) tanımlıdır. AIA için ayrı URL/env yoktur; `OIDC_CLIENT_ID` tam olarak `account-center` olmalıdır.

Oturum yönetimi yalnız kullanıcının sunucu tarafında tutulan Account REST token’ıyla çalışır. `/api/account/sessions` güvenli cihaz/tarayıcı/zaman görünümünü ve session-bound CSRF proof’unu döndürür; Keycloak session ID’si tarayıcıya verilmez. Boş olmayan upstream listede tam bir `current=true` kaydı yoksa liste salt-okunur hata durumuna geçer, opaque referans üretilmez ve hiçbir revoke çağrısı yapılmaz; gerçek boş liste ayrı bir boş durumdur. Tekil kapatma `DELETE /api/account/sessions/{opaque-reference}`, diğer tüm cihazları kapatma `DELETE /api/account/sessions` üzerinden raw `Origin` değerinin yapılandırılmış scheme+host(+port) ile birebir eşleşmesi ve CSRF denetiminden sonra yapılır. Her iki işlem de Keycloak’ın mevcut oturumunu korur. Keycloak yeniden doğrulama istediğinde yerel opaque session revoke edilir ve cookie temizlenir; yerel revoke geçici olarak hata verse de tarayıcı cookie’si kesin olarak sonlandırılır.

## Sınırlar

- Kişisel bilgiler yalnız Keycloak’taki ad, soyad ve birincil e-postadır.
- Şifre, OTP ve passkey mutasyonları Keycloak AIA ile yapılır.
- Telefon, öğrenci kartı, kulüp rolleri, SkyPass ve uygulama verileri bu ürünün kapsamında değildir.
- Mobile repository değiştirilmez; WebView entegrasyonu ayrı, sürümlü bir sözleşmeyle teslim edilir.
- Oturum kapatma için browser veya BFF tarafında Keycloak Admin API, service account ya da kullanıcı/subject parametresi kullanılmaz.
- Hesap silme mevcut fiziksel kullanıcı silme endpoint’ini çağırmaz; dayanıklı silme/anonimleştirme akışı kullanır.

Ayrıntılar için [mimari notlara](docs/architecture.md) bakın.
