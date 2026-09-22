# Keycloak 26.7.4 entegrasyon bloğu

BFF kodu canlı production realm’ine karşı doğrulanmış kabul edilmez. `tests/fixtures/keycloak-26.7.4-discovery.json` yalnız beklenen discovery sözleşmesini sabitler ve ağ çağrısı yapmaz.

Production’a açılmadan önce 00A Keycloak foundation işi şu kanıtları sağlamalıdır:

- Keycloak image, SPI ve integration fixture aynı anda 26.7.4’e yükseltilmiş olmalı.
- `account-center` confidential client config-as-code ile oluşturulmalı; exact callback URI `https://my.yildizskylab.com/api/auth/callback` olmalı.
- Implicit flow, Direct Access Grants ve service account kapalı; S256 PKCE ve PAR zorunlu olmalı.
- Authorization isteğinin scope değeri tam olarak `openid` olmalı; profile/email scope veya mapper bağımlılığı eklenmemeli. İmzalı ID token `sub`, `sid` ve özgün `auth_time` claim’lerini sağlamalı.
- `client_secret_basic`, authorization code, discovery, JWKS, PAR ve token endpoint contract testleri production clone’da geçmeli.
- Redirect URI veya web origin wildcard içermemeli. Backchannel logout URL tam olarak `https://my.yildizskylab.com/api/auth/backchannel-logout`, yöntemi OIDC form POST olmalı; front-channel logout kapalı kalmalı.
- Keycloak 26.7.4 production-clone testi logout token’ın RS256 imzasını, `iss`, `aud=account-center`, `iat`, `jti`, `sid|sub`, boş `{}` backchannel event değerini ve JOSE `typ` davranışını fixture olarak kaydetmeli. BFF eksik `typ` veya `logout+jwt` kabul eder, farklı açık bir `typ` değerini reddeder; bu uyumluluk canlı clone kanıtlanmadan production hazır sayılmaz.
- `OIDC_ISSUER` credentials/query/fragment içermeyen canonical `https://<host>/realms/<realm>` biçiminde olmalı; normalize edilen, percent-encoded veya ek path’li değerler startup/runtime/readiness tarafından reddedilir.
- `OIDC_UPSTREAM_SESSION_MAX_SECONDS`, doğrulanmış Keycloak SSO Session Max değerinden config-as-code ile beslenmeli. BFF absolute deadline’ı `min(callback now + 8 saat local cap, doğrulanmış auth_time + bu upstream sınır)` olarak uygular ve placeholder/güvensiz aralığı startup’ta reddeder.
- Client-specific browser flow, `sky-native-handoff` authenticator, mTLS/HMAC redemption ve gerçek WebView → SSO → step-up AIA kanıtı [native handoff sözleşmesine](native-handoff-keycloak-contract.md) göre tamamlanmalı.

Bu maddeler tamamlanana kadar yalnız fixture/unit testleri güvenilir kabul edilir; canlı `e.yildizskylab.com` smoke testi veya production deploy yapılmaz.

## Kullanıcı token sözleşmesi (K2 geçişi ve sonrası)

Account Center, service account veya Admin REST kullanmaz. Sunucu oturumundaki kullanıcı access token’ı aşağıdaki sözleşmeyi karşılamadan Account REST, sky-account veya core çağrısı yapılmaz (`src/server/keycloak-account/access-token.ts`):

- `aud` tam olarak `ACCEPTED_AUDIENCE_SETS` içindeki iki kümeden birine eşittir (sıra önemsiz; tekrar, eksik veya fazla audience reddedilir): K2 öncesi eski küme `{"account"}` (Keycloak tek audience’ı düz string `"account"` olarak yazar; bu biçim aynı kümedir) veya K2 sonrası güncel küme `{"account", "core"}`. `core` audience kişinin kendi core `/v1/users/me` uçları içindir; token core rolü taşımaz. Eski küme kabul edildiğinde her doğrulamada bir `token_audience_legacy` bilgi olayı loglanır; olay yalnız `requestId` ve `outcome` taşır, claim veya token içermez. `{"core"}` tek başına, `{"account", "core", "x"}` ve `{"account", "account"}` reddedilir.
- `azp=account-center`, `scope=openid`, eşleşen `iss/sub`, `RS256`, `typ=JWT`.
- `resource_access.account.roles` `manage-account` ve `view-profile` içerir; `resource_access.core` hangi değerle olursa olsun reddedilir.
- İsteğe bağlı `sky_authorization` claim’i (K2 client-role mapper, `sky_authorization.${client_id}.roles`) `{ [clientId]: string[] }` okuma modeline ayrıştırılır: en fazla 64 client, client başına 256 rol, adlar 255 karakter, boşluksuz client id, kontrol karakteri yok, tekrar yok, `__proto__`/`constructor`/`prototype` anahtarları yok. Biçim sapması token’ı bütünüyle reddeder. Okuma modeli yalnız Yetkilerim görünümü içindir; Account Center içinde hiçbir yetki vermez.

### Geçiş sırası (cutover)

`aud` değişikliği Keycloak tarafında **K2 reconcile** ile gelir (`account-center-account-api` scope’una `core` audience mapper’ı, `account.manage-account-links` hardcoded rolü ve `sky_authorization` client-role mapper’ı; audience-resolve mapper yok). Bu sürüm her iki audience kümesini de kabul ettiği için oturumlar geçiş boyunca kilitlenmez. Sıra kesin olarak şudur:

1. Bu Account Center imajı dağıtılır. Eski `aud=account` token’ları çalışmaya devam eder; her kabulde `token_audience_legacy` olayı loglanır.
2. K2 reconcile production realm’e uygulanır; yeni verilen ve yenilenen token’lar `["account","core"]` taşır.
3. En geç 8 saat içinde (bütün oturumlar yenilendikten sonra) loglarda sıfır `token_audience_legacy` olayı olduğu doğrulanır. Olay sürüyorsa K2 tamamlanmamış veya bir istemci hâlâ eski scope ile token alıyor demektir; sıkılaştırmaya geçilmez.
4. Takip bileti A0c ile `ACCEPTED_AUDIENCE_SETS` yalnız `{"account", "core"}` kümesine daraltılır; bundan sonra eski token’lar `AccountAccessTokenContractError` ile reddedilir.

Geri alma: bu sürüm her iki kümeyi de kabul ettiği için K2 geri alınmadan bu imajda kalınabilir. K2’den sonra yalnız `aud=account` kabul eden A0 öncesi imaja dönmek bütün oturumları kilitler.

Kontrat testleri `access-token.test.ts` ve `service.test.ts` içinde her iki kümenin kabulünü, eski küme için doğrulama başına tek `token_audience_legacy` olayını ve yalnız `core`, fazla veya tekrarlı audience ile core rollü token’ların reddini kanıtlar.

## Account REST okuma sözleşmesi

Sürüm sabitlemesi şu fixture’larda tutulur:

- `tests/fixtures/keycloak-26.7.4-account-profile.json` (`GET /account/?userProfileMetadata=true`)
- `tests/fixtures/keycloak-26.7.4-account-credentials.json`
- `tests/fixtures/keycloak-26.7.4-account-sessions.json`
- `tests/fixtures/keycloak-26.7.4-account-devices.json`
- `tests/fixtures/keycloak-26.7.4-account-groups.json` (`GET /account/groups?briefRepresentation=false`)
- `tests/fixtures/keycloak-26.7.4-account-linked-accounts.json` (`GET /account/linked-accounts`)
- `tests/fixtures/keycloak-26.7.4-account-linked-account-uri.json` (`GET /account/linked-accounts/{alias}?redirectUri=`)

Fixture’lar tagged `26.7.4` Java representation ve resource kodundaki alan sözleşmesini test eder. Foundation entegrasyonu şu anda yalnız canlı `/account/` profil okumasını kanıtlar. Credentials, canonical sessions, optional devices, groups ve linked-accounts payload’larının gerçek production-clone capture’ı release gate olarak açıktır; bu kanıt gelmeden Account REST adaptörü production-ready sayılmaz.

Adaptör (`src/server/keycloak-account/adapter.ts`) yalnız `GET`/`DELETE` yapar; `POST /account` yoktur. Ad, kullanıcı adı, e-posta ve kimlik bilgisi değişiklikleri yalnız sky-account SPI istemcisinden geçer.

- Profil: `userProfileMetadata=true` ile okunur. View model `username`, ad, soyad, birincil e-posta, doğrulanma durumu, yalnız `schoolEmail`/`personalEmail`/`skyNumber`/`department`/`university` öznitelikleri (ilk değer) ve `userProfileMetadata.attributes[]` içinden `name`/`displayName`/`required`/`readOnly`/`validators`/`annotations` alanlarını taşır. Diğer öznitelikler (`skyMail`, `usernameChangedAt`, `locale`…) ve `group`/`multivalued`/`defaultValue` alanları düşürülür. Keycloak 26.7.4 `DefaultUserProfile.toRepresentation` kök öznitelikleri `attributes` haritasından çıkarır; `enabled` yalnız kalıcı brute-force kilidinde `false` döner.
- Gruplar: `auth.requireOneOf(manage-account, view-groups)`; view model `id`, `name`, `path`, `attributes` (ör. `display_name_tr`). `realmRoles`/`clientRoles`/`parentId`/`description` düşürülür.
- Bağlı hesaplar: `linked` parametresi verilmeden çağrılır (tüm sağlayıcılar, `connected` bayrağıyla). View model `connected`, `providerAlias`, `displayName`, `linkedUsername`, `social`.
- Bağlantı URI’si: Keycloak 26.7.4’te `GET /account/linked-accounts/{alias}` **deprecated**’dir; login protocol `allow-client-initiated-account-linking` (varsayılan `false`) açık değilse `404` döner ve adaptör bunu `KeycloakAccountLinkingDisabledError` olarak bildirir. Açık olsa bile URI `client_id=account-console` ile üretilir. Account Center bu ucu kullanmaz; YTÜ hesabı bağlama `kc_action=idp_link` + `kc_action_parameter=<alias>` AIA’sıyla yapılır (aşağıda). Adaptör yanıtı yalnız `https://<issuer-origin>/realms/<realm>/broker/<alias>/link` yolunda kabul eder.

## Zorunlu yeniden doğrulama ve tek application-initiated action (`idp_link`)

Parola, TOTP ve passkey değişiklikleri Keycloak application-initiated action'larıyla değil, `my.` içinde sky-account SPI ile yapılır ([güvenlik işlemleri](account-actions.md)). Keycloak'a giden iki "adım" vardır:

1. **Zorunlu yeniden doğrulama**: hesap silme ve Sudo modunun Microsoft yedeği (`POST /api/account/sudo/reauthenticate`, yalnız parolası, passkey'i ve TOTP'si olmayan kişi için) `prompt=login` ve `max_age=0` ile taze bir giriş ister; callback imzalı `auth_time` değerinin işlemi başlatma anından eski olmadığını, `sub` ve Keycloak `sid` değerlerini doğrular. Bu istekte `kc_action` yoktur. Native köprü girişi zorunlu yeniden doğrulamayla birleştirilemez (köprü özgün `auth_time` değerini taşır). `DELETE_ACCOUNT` ve Account Console hedef olarak kullanılmaz.
2. **YTÜ hesabı bağlama** (`POST /api/account/identity/ytu-link`, [ayrıntı](account-actions.md#ytü-hesabı-bağlama-kc_actionidp_link)): PAR gövdesi `kc_action=idp_link` ve `kc_action_parameter=<YTU_IDP_ALIAS>` (varsayılan `OBS`) taşır; `prompt`/`max_age` eklenmez, köprüyle ya da zorunlu yeniden doğrulamayla birleştirilemez ve `OAuth4WebApiProtocol` bu ikili dışındaki her `kc_action` değerini istek çıkmadan reddeder. Keycloak kişiyi IdP'ye (Microsoft) götürür, dönüşte IdP'nin first-broker-login akışını bağlama için çalıştırır (`first broker login for obs` review-profile açık olduğundan `e.` üzerinde profil inceleme sayfası görünebilir; `schoolEmail` mapper'ı FORCE olduğundan Microsoft UPN'i okul e-postasını yazar) ve `redirect_uri`'ye kodla birlikte `kc_action=idp_link&kc_action_status=success|cancelled|error` döner. Callback bu ikisini zorunlu tutar, kodu yeniden doğrulamadaki gibi değiştirir (aynı `sub`; `sid` değişebilir ve kabul edilir; token seti compare-and-swap ile yerine yazılır) ve `success` değerini `GET identity` üzerinden `verifiedYtu` okuyarak doğrular.

`idp_link` için Keycloak ön koşulları (K2 reconcile ile config-as-code): `account-center` istemcisinin `account.manage-account-links` client rolüne **scope mapping**'i olmalıdır (`IdpLinkAction` `client.hasScope` kontrolü yapar; hardcoded role mapper tek başına yetmez) ve bağlanan **kişi** `account.manage-account` ya da `account.manage-account-links` rolünü taşımalıdır. Production'da `default-roles-e-skylab` composite'inin `account.manage-account` içerdiği K2 runbook'unun çıktısıyla doğrulanır; içermiyorsa bu bir işletim adımıdır (rol composite'e eklenir), kod değişikliği değil. IdP alias'ı canlı realm'de `OBS`'tir; farklı bir alias yalnız `YTU_IDP_ALIAS` ile tanımlanır ve `^[A-Za-z0-9_-]{1,64}$` desenine uymak zorundadır.

## Account REST oturum mutation sözleşmesi

Tagged Keycloak `26.7.4` [`SessionResource`](https://github.com/keycloak/keycloak/blob/26.7.4/services/src/main/java/org/keycloak/services/resources/account/SessionResource.java) kaynak koduna göre kullanıcı-token sınırı şudur:

- `DELETE /realms/{realm}/account/sessions/{id}` yalnız `manage-account` rolüyle çalışır, bulunan online/offline session’ın kullanıcısı authenticated user ile eşleşirse backchannel logout yapar ve bulunmayan/başka kullanıcıya ait ID için de gövdesiz `204` döndürür.
- `DELETE /realms/{realm}/account/sessions` varsayılan `current=false` ile authenticated user’ın mevcut online/offline session’ı dışındaki oturumlarını backchannel logout ile kapatır ve gövdesiz `204` döndürür.
- Account Center browser’dan bu uçlara doğrudan erişmez. BFF, kullanıcı access token’ını kullanır; Admin API ve service account yoktur.
- Tekil işlemden önce kanonik `/sessions` listesinde aynı kullanıcının `current=false` kaydı HMAC referansıyla eşleştirilir. Böylece Keycloak ID tarayıcıya çıkmaz ve mevcut session hedeflenemez.
- Boş olmayan `/sessions` listesi tam bir `current=true` kaydı taşımak zorundadır. Sıfır veya birden fazla current kayıt sözleşme sapmasıdır; BFF referans üretmez ve tekil/toplu mutation çağrısı yapmaz. `[]` ayrı ve kullanılabilir boş durumdur.

Bu kaynak incelemesi response shape capture’ı değildir. Production’a açılmadan önce 26.7.4 production clone’da iki cihazla şu kanıtlar kaydedilmelidir: tekil kapatmanın ikinci çağrısının yine 204 olması; bilinmeyen ID’nin bilgi sızdırmadan 204 olması; koleksiyon DELETE’in current session’ı listede bırakması; kapatılan diğer Account Center session’ı için backchannel logout’un yerel kaydı yok etmesi; response’ların gövdesiz olması. Bu kanıt olmadan mutation adaptörü production-ready sayılmaz.
