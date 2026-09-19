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

Bu maddeler tamamlanana kadar yalnız fixture/unit testleri güvenilir kabul edilir; canlı `e.yildizskylab.com` smoke testi veya production deploy yapılmaz.
