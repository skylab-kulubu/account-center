# Keycloak 26.7.4 sözleşmesi

Account Center Keycloak ile üç yüzeyde konuşur: **OIDC** (giriş, token yenileme, çıkış, backchannel logout), kullanıcı token'ıyla **Account REST** (salt okuma ve oturum silme) ve **sky-account SPI** (kimlik ve kimlik bilgisi değişiklikleri; [sky-account-api.md](sky-account-api.md)). Web handoff'ta yalnız bir hedeftir ([web-handoff.md](web-handoff.md)). Service account ve Admin REST kullanılmaz; her çağrı kişinin kendi sunucu-tarafı access token'ıyla yapılır.

Realm ve SPI config-as-code olarak `skylab-kulubu/e-skylab-keycloak` deposundadır (uzlaştırıcı `config/reconcile-account-center.sh`, runbook `docs/v2-identity-reconcile-runbook.md`). Bu belge Account Center kodunun Keycloak'tan **beklediği** sözleşmedir; kod bunu doğrular ve uyuşmazlıkta fail-closed olur. Fixture'lar (`tests/fixtures/keycloak-26.7.4-*.json`, `tests/fixtures/sky-account-v1-*.json`) tagged 26.7.4 kaynak kodundan türetilmiştir, canlı yanıt kaydı değildir.

## `account-center` istemcisi

- Confidential client; exact callback URI `https://my.yildizskylab.com/api/auth/callback`, redirect URI ve web origin'de wildcard yok.
- Implicit flow, Direct Access Grants ve service account kapalı; Authorization Code + **S256 PKCE** + **PAR** zorunlu; istemci kimlik doğrulaması `client_secret_basic`. Keşif (`/.well-known/openid-configuration`) bunları ilan etmiyorsa ya da uç noktalar `OIDC_ISSUER` gerçeği dışına çıkıyorsa (`src/server/auth/oidc-protocol.ts`, `validateOidcMetadataContract`) giriş açılmaz. `OIDC_CLIENT_ID` tam olarak `account-center` olmak zorundadır.
- Authorization isteğinin `scope` değeri tam olarak `openid`'dır; profile/email scope'u ya da mapper bağımlılığı yoktur. Browser URL'sinde yalnız `client_id` ve `request_uri` bulunur.
- Backchannel logout URL'si tam olarak `https://my.yildizskylab.com/api/auth/backchannel-logout`, yöntem OIDC form POST; front-channel logout kapalı.
- `OIDC_ISSUER` credentials/query/fragment içermeyen canonical `https://<host>/realms/<realm>` olmalıdır. `ACCOUNT_ACCESS_GATE_MODE=enforce` iken ayrıca tam olarak `https://e.yildizskylab.com/realms/e-skylab` olmalıdır (erişim engeli sözleşmesi, [mimari](architecture.md#hesap-erişim-engeli-redis)).
- İmzalı ID token (RS256) `sub` ve özgün `auth_time` taşımak zorundadır; `nonce` doğrulanır. `sid` olmadan oturum yine açılır ama Keycloak `sid` eşleşmeli backchannel logout onu bulamaz; Sudo modunun Microsoft yedeği ve YTÜ bağlama `sid` ister. `sky_session_expires`, `sky_session_started` ve `sky_embed` isteğe bağlıdır ([aşağıda](#oturum-ömrü-claimleri), [web-handoff.md](web-handoff.md)).

## Giriş formu (K4)

Parolayla giriş realm'in `browser plus passkey` akışındaki `sky-username-password-form` ile yapılır (K4, SPI `1.14.0`, e-skylab-keycloak#50 ve #54; realm geçişi 2 Ekim 2026'da uzlaştırıcıyla yapıldı). Kabul edilen tanımlayıcılar: kullanıcı adı, birincil e-posta (`email`), **YTÜ bağlantısı olan** hesabın okul e-postası (`schoolEmail`) ve kodla **doğrulanmış** kişisel e-posta (`personalEmail`); karşılaştırma harf duyarsızdır. Kanıtsız ya da belirsiz bir adres bilinmeyen kullanıcı gibi, yanlış parolayla aynı cevabı alır. Brute-force koruması, devre dışı hesap mesajları ve passkey ile YTÜ girişi Keycloak'ın kendisidir ve bu formdan etkilenmez. Account Center'ın kodu bu formu bilmez: OIDC akışı, token sözleşmesi ve Sudo modu (parola kanıtı SPI `POST sudo/password` ile verilir) değişmedi. Geri dönüş sırası [rollout-v2.md](rollout-v2.md#geri-dönüş)'dedir.

## Kullanıcı access token sözleşmesi

Sunucu oturumundaki access token aşağıdaki sözleşmeyi karşılamadan Account REST, sky-account ya da core çağrısı yapılmaz (`src/server/keycloak-account/access-token.ts`, `validateAccountAccessToken`); girişte, her yenilemede ve her kullanımda yeniden doğrulanır:

- JOSE başlığı `alg=RS256`, `typ=JWT`; `iss` yapılandırılan issuer; `sub` oturumun subject'i; `azp=account-center`; `scope=openid`.
- `aud` tam olarak `ACCEPTED_AUDIENCE_SETS` içindeki kümelerden birine eşittir (sıra önemsiz; tekrar, eksik ya da fazla audience reddedilir):
  - güncel küme `{"account", "core"}`: `core`, kişinin kendi core `/v1/users/me` uçları içindir (kulüp profili, ad eşitleme) ve core rolü getirmez;
  - eski küme `{"account"}` (Keycloak tek audience'ı düz string yazar; aynı kümedir): K2 öncesi biçim. **Hâlâ kabul edilir** ve her kabulde `token_audience_legacy` bilgi olayı loglanır (yalnız `requestId` ve `outcome`; claim ya da token yok). Sıkılaştırma [bekliyor](#geçiş-sırası).
  - `{"core"}` tek başına, `{"account","core","x"}` ve `{"account","account"}` reddedilir.
- `resource_access.account.roles` hem `manage-account` hem `view-profile` içerir; `resource_access.core` hangi değerle olursa olsun reddedilir (token core'da yetki taşımaz).
- İsteğe bağlı `sky_authorization` claim'i (K2'deki SPI mapper'ı, `sky_authorization.${client_id}.roles`) `{ [clientId]: string[] }` olarak ayrıştırılır: en fazla 64 istemci, istemci başına 256 rol, ad 255 karakter, boşluksuz istemci kimliği, kontrol karakteri ve tekrar yok, `__proto__`/`constructor`/`prototype` anahtarı yok. Biçim sapması token'ı bütünüyle reddeder. Claim yalnız salt okunur **Yetkilerim** görünümü içindir; Account Center içinde hiçbir yetki vermez.
- `exp` geçmişteyse `AccountAccessTokenExpiredError`; token yenilenir (refresh token yalnız şifreli sunucu oturumundadır; yenilenen token aynı sözleşmeden geçer, aksi hâlde refresh token iptal edilir).

### Geçiş sırası

`aud` değişikliği Keycloak tarafında **K2 reconcile** ile gelir (`account-center-account-api` kapsamına `core` audience mapper'ı, `account.manage-account-links` hardcoded rolü ve `sky_authorization` client-role mapper'ı; audience-resolve mapper yok). Production'da K2 22 Eylül 2026'da uygulandı ve `core` mapper'ı Account Center v2 imajı çıktıktan sonra geri konuldu ([rollout-v2.md](rollout-v2.md)); bugün token'lar `["account","core"]` taşır.

Eski küme yine de kabul edilir, çünkü sıkılaştırma (**A0c**) yapılmadı. Sıra:

1. Production loglarında, son oturum yenilemesinden sonra (en az 8 saat) `token_audience_legacy` olayı **sıfır** olmalıdır. Olay sürüyorsa K2 tamamlanmamıştır ya da bir istemci eski kapsamla token alıyordur; sıkılaştırılmaz.
2. `ACCEPTED_AUDIENCE_SETS`'ten `legacy` girdisi, `token_audience_legacy` olayı ve testleri kaldırılır (A0c); bu belge, README ve mimari tek küme `{"account","core"}` olarak güncellenir.

Geri alma: sıkılaştırmadan sonra K2'yi geri almak (`core` audience'ını kaldırmak) bütün oturumları kilitler.

## Account REST (salt okuma)

Adaptör (`src/server/keycloak-account/adapter.ts`, taban `${OIDC_ISSUER}/account/`) yalnız `GET` ve `DELETE` yapar; `POST /account` ve `/admin` yoktur. İstek zaman aşımı 5 saniye, yanıt `application/json` olmak zorundadır ve 512 KiB'la sınırlıdır; bilinen alan/tür sözleşmesinden sapan yanıt fail-closed olur (API `application/problem+json`, sayfalar güvenli Türkçe durum kartı; upstream gövdesi, alan değeri ve token hata ya da loga yazılmaz).

| Uç | Kullanan | Not |
| --- | --- | --- |
| `GET /account/?userProfileMetadata=true` | `/` özeti, kulüp profili (core kapalıyken kimlik özeti), `GET /api/account` | View model: kullanıcı adı, ad, soyad, birincil e-posta ve doğrulanma, yalnız `schoolEmail`/`personalEmail`/`skyNumber`/`department`/`university` öznitelikleri (ilk değer) ve `userProfileMetadata.attributes[]` içinden `name`/`displayName`/`required`/`readOnly`/`validators`/`annotations`. Diğer öznitelikler (`skyMail`, `usernameChangedAt`, `locale`…) düşer. |
| `GET /account/credentials` | `/` özeti, `GET /api/account` | Yalnız parola/OTP/passkey özeti; credential kimlikleri ve verileri tarayıcıya çıkmaz. |
| `GET /account/sessions`, `GET /account/sessions/devices` | Oturumlar sayfası, `GET /api/account` | `/sessions` kanonik listedir; `devices` isteğe bağlıdır (`404` kabul edilir) ve yalnız işletim sistemi/cihaz etiketi sağlar. IP adresleri, istemci listeleri ve Keycloak oturum kimlikleri tarayıcıya çıkmaz. |
| `GET /account/groups?briefRepresentation=false` | Yetkilerim | Yalnız grup `id`/`name`/`path`/`attributes` (ör. `display_name_tr`); `realmRoles`/`clientRoles` düşer. |
| `DELETE /account/sessions/{id}`, `DELETE /account/sessions` | Oturumlar sayfası | Aşağıda. |

Adaptör `GET /account/linked-accounts` ve `GET /account/linked-accounts/{alias}` okumalarını da uygular, fakat hiçbir sayfa ya da uç onları çağırmaz (fixture'larla sabitlenmiş, kullanılmayan yüzey). Keycloak 26.7.4'te `linked-accounts/{alias}` **deprecated**'dir: `allow-client-initiated-account-linking` açık değilse `404` döner ve açıkken bile `client_id=account-console` ile URI üretir. YTÜ hesabı bağlama bu yüzden Account REST ile değil `kc_action=idp_link` ile yapılır ([aşağıda](#zorunlu-yeniden-doğrulama-ve-tek-application-initiated-action-idp_link)).

### Oturum silme

Tagged Keycloak `26.7.4` `SessionResource` kaynak koduna göre (canlı yanıt kaydı değildir):

- `DELETE /account/sessions/{id}` yalnız `manage-account` rolüyle çalışır; bulunan oturum kişiye aitse backchannel logout yapar, bulunmayan ya da başkasına ait kimlik için de gövdesiz `204` döner.
- `DELETE /account/sessions` varsayılan `current=false` ile kişinin mevcut oturumu dışındaki bütün oturumlarını kapatır ve gövdesiz `204` döner.
- Tarayıcı Keycloak oturum kimliğini hiç görmez. Tekil kapatmada servis önce kanonik `/sessions` listesini okur, satırı oturuma bağlı HMAC referansıyla (`current=false`, sabit-zamanlı karşılaştırma) eşler ve ancak sonra `DELETE` çağırır; bulunmayan, başka yerel oturuma bağlı ya da önceden kapatılmış referans idempotent no-op'tur, mevcut oturum için referans üretilmez.
- Boş olmayan listede tam bir `current=true` kaydı zorunludur; sıfır ya da birden fazla kayıt sözleşme sapmasıdır ve referans üretilmeden/mutation yapılmadan kapanır. Gerçek boş liste kullanılabilir boş durumdur. Toplu kapatma yalnız mevcut oturumdan başka bir kayıt varsa çağrılır.
- Kapatılan başka Account Center oturumu Keycloak'ın backchannel logout'uyla yerel kaydı yok eder (aşağıda).

## Backchannel logout

`POST /api/auth/backchannel-logout` (`application/x-www-form-urlencoded`, en fazla 16 KiB, tek `logout_token`). Token RS256/JWKS ile `iss`, `aud=account-center`, `events` (`http://schemas.openid.net/event/backchannel-logout` anahtarı, boş `{}` değer), `iat` (en çok 5 dakika eski, 5 sn saat sapması), `jti` ve `sid` ya da `sub` ile doğrulanır; `nonce` bulunmaz; JOSE `typ` yoksa ya da `logout+jwt` ise kabul edilir. JTI özeti 10 dakika saklanır; replay aynı PostgreSQL transaction'ında yakalanır ve oturumlar hard-delete edilir. Hata cevapları `400 invalid_request` (replay dahil), doğrulanamayan altyapı `503`'tür.

## Oturum ömrü claim'leri

ID token'a `account-center` istemcisindeki SKY LAB mapper'ları üç isteğe bağlı claim yazar (ayrıntı: e-skylab-keycloak `docs/sky-handoff-api.md`). BFF mutlak oturum süresini `min(şimdi + yerel üst sınır, Keycloak oturumunun bitişi)` olarak hesaplar; yerel üst sınır `min(8 saat, OIDC_UPSTREAM_SESSION_MAX_SECONDS)`'tur ve geçmiş ya da geçersiz bitiş oturum yaratmaz.

- `sky_session_expires`: Keycloak'ın bu SSO oturumunu en uzun ömürle kapatacağı an (epoch saniye; beni-hatırla ve istemci geçersiz kılmaları dahil). `auth_time`'dan sonra ve en fazla 31 gün ileride olmalıdır. Geçmişte kalmışsa oturum bitmiştir: giriş reddedilir (`oidc_login_failed` / `upstream_session_expired`).
- `sky_session_started`: Keycloak kullanıcı oturumunun gerçek başlangıcı. Güvenli bir tam sayı olmalı ve `auth_time − 5 sn` ile `şimdi + 5 sn` arasında kalmalıdır; aksi hâlde yok sayılır ve başlangıç `auth_time` olur. Canlı oturumda `prompt=login` ile yeniden doğrulanan kişide `started` eski kalır, `auth_time` ilerler; bu durum normaldir ve loglanmaz.
- Claim `sky_session_expires` yoksa ya da geçersizse bitiş `başlangıç + OIDC_UPSTREAM_SESSION_MAX_SECONDS` olarak tahmin edilir (`OIDC_UPSTREAM_SESSION_MAX_SECONDS` 60 sn – 30 gün; doğrulanmış Keycloak SSO Session Max değerinden beslenir). Bu tahmin yolunda BFF oturumu Keycloak oturumundan biraz uzun görünebilir; Keycloak oturumu bitince refresh reddedilir.
- Var ama bozuk (yanlış tür, kesirli, aralık dışı) bir claim atılır ve girişte bir kez, değeri yazılmadan `oidc_session_claims` / `session_claim_ignored` olarak loglanır.
- `auth_time` değişmez ve hiçbir akış onu taze giriş saymaz; bkz. Sudo modu ([mimari](architecture.md#sudo-modu)).
- `sky_embed` yalnız görünümü etkiler ([web-handoff.md](web-handoff.md)).

## Zorunlu yeniden doğrulama ve tek application-initiated action (`idp_link`)

Parola, TOTP ve passkey değişiklikleri Keycloak'ın application-initiated action'larıyla değil `my.` içinde sky-account SPI ile yapılır ([account-actions.md](account-actions.md)). Keycloak'a giden istek türleri:

1. **Sudo modunun Microsoft yedeği** (`POST /api/account/sudo/reauthenticate`; yalnız parolası, passkey'i ve TOTP'si olmayan kişi için): `prompt=login` ve `max_age=0` ile taze giriş. Callback imzalı `auth_time` değerinin işlemi başlatma anından (5 sn sapma payıyla) eski olmadığını, `sub` eşleşmesini ve `sid` varlığını doğrular (yeni bir `sid` kabul edilir), token setini değiştirir ve taze ID token'ı sky-account `POST sudo/authentication` ucuna sunar. Bu istekte `kc_action` yoktur. Web handoff'tan gelen oturum uygulamanın özgün `auth_time` değerini taşıdığı için bu kontrolü tek başına geçemez.
2. **YTÜ hesabı bağlama** (`POST /api/account/identity/ytu-link`; geri alınamaz olduğu için Sudo modu kapısından geçer): PAR gövdesi `kc_action=idp_link` ve `kc_action_parameter=<YTU_IDP_ALIAS>` (varsayılan `OBS`) taşır; `prompt`/`max_age` eklenmez. `OAuth4WebApiProtocol.begin`, `YTU_IDP_ALIAS` dışındaki her alias'ı, `idp_link` dışındaki her `kc_action` değerini ve zorunlu yeniden doğrulamayla birleşimi, istek çıkmadan reddeder (`^[A-Za-z0-9_-]{1,64}$`, hem açılışta hem protokolde). Keycloak kişiyi IdP'ye (Microsoft) götürür, dönüşte IdP'nin first-broker-login akışını bağlama için çalıştırır (`first broker login for obs` review-profile açık olduğundan `e.` üzerinde profil inceleme sayfası görünebilir; `schoolEmail` mapper'ı FORCE olduğundan Microsoft UPN'i okul e-postasını yazar) ve `redirect_uri`'ye kodla birlikte `kc_action=idp_link&kc_action_status=success|cancelled|error` döner. Callback bu ikisini zorunlu tutar, kodu yeniden doğrulamadaki gibi değiştirir (aynı `sub`; `sid` değişebilir ve kabul edilir; token seti compare-and-swap ile yerine yazılır) ve `success` değerini `GET identity` ile `verifiedYtu` okuyarak doğrular; ayrıntı [account-actions.md](account-actions.md#ytü-hesabı-bağlama-kc_actionidp_link).

`idp_link` için Keycloak ön koşulları (K2 reconcile ile config-as-code): `account-center` istemcisinin `account.manage-account-links` client rolüne **scope mapping**'i (`IdpLinkAction` `client.hasScope` kontrolü yapar; hardcoded role mapper tek başına yetmez) ve bağlanan **kişinin** `account.manage-account` ya da `account.manage-account-links` rolünü taşıması. Production'da `default-roles-e-skylab` composite'inin `account.manage-account` içerdiği K2 runbook'unun çıktısıyla doğrulanır; içermiyorsa bu bir işletim adımıdır (rol composite'e eklenir), kod değişikliği değil. Account Center `DELETE_ACCOUNT` ve Account Console'u hedef olarak kullanmaz.

## sky-account SPI ve sudo token

Taban `${OIDC_ISSUER}/sky-account/v1`; istemci aynı kullanıcı access token'ını bearer olarak gönderir (SPI `azp=account-center`, `aud ∋ account` ve `manage-account` rolünü arar; bu yüzden `account` audience'ı her iki küme için de şarttır). Hassas uçlarda ek olarak `X-Sky-Sudo: <sudo token>` taşınır. Sudo token Keycloak'ın realm anahtarıyla imzaladığı opak bir JWT'dir (`typ=sky-sudo`, `aud=["sky-account","core"]`, beş dakika); Account Center onu yalnız şifreli oturum kaydında saklar, içine bakmaz, tarayıcıya vermez ve hesap silmede core'a `X-Sky-Sudo` olarak sunar (core onu realm introspection'ıyla doğrular). Uç sözleşmesi, hata kodları ve hız sınırları [sky-account-api.md](sky-account-api.md)'dedir.

## Keycloak sürümü ve fixture'lar

Account Center `26.7.4`'e sabitlenmiştir; Keycloak, SPI ve fixture'lar birlikte yükseltilir. Account REST fixture'ları: `keycloak-26.7.4-account-{profile,credentials,sessions,devices,groups,linked-accounts,linked-account-uri}.json`; keşif: `keycloak-26.7.4-discovery.json` (ağ çağrısı yapmaz). Fixture'lar kasıtlı olarak sözleşme dışı öznitelikler, IP adresleri, credential kimlikleri ve grup rol eşlemeleri içerir; testler bunların view model'lere sızmadığını kanıtlar.
