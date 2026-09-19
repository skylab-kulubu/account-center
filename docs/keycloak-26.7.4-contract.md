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

## Account REST okuma sözleşmesi

Account Center, service account veya Admin REST kullanmaz. Sunucu oturumundaki kullanıcı access token’ı tek `aud=account`, `azp=account-center`, `scope=openid`, eşleşen `iss/sub`, `RS256` ve `typ=JWT` şartlarıyla doğrulanmadan Account REST çağrısı yapılmaz.

Sürüm sabitlemesi şu fixture’larda tutulur:

- `tests/fixtures/keycloak-26.7.4-account-profile.json`
- `tests/fixtures/keycloak-26.7.4-account-credentials.json`
- `tests/fixtures/keycloak-26.7.4-account-sessions.json`
- `tests/fixtures/keycloak-26.7.4-account-devices.json`

Fixture’lar tagged `26.7.4` Java representation ve resource kodundaki alan sözleşmesini test eder. Foundation entegrasyonu şu anda yalnız canlı `/account/` profil okumasını kanıtlar. Credentials, canonical sessions ve optional devices payload’larının gerçek production-clone capture’ı release gate olarak açıktır; bu kanıt gelmeden Account REST adaptörü production-ready sayılmaz.
