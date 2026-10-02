# Web handoff: Account Center'ın payı

SkyApp'in WebView'ında `my.yildizskylab.com`'u oturum açık açması **Web handoff**'tur (ADR-0048). Mekanizma Keycloak'taki `sky-handoff` sağlayıcısındadır; Account Center bu yolda aracı değil, sıradan bir **Handoff target**'tır: kendi OIDC girişini yapar ve uygulamanın token'ını, handoff kodunu ya da kanıt başlığını hiç görmez. Uçların, hata nedenlerinin ve hedef özniteliklerinin tam sözleşmesi Keycloak deposundadır ([`docs/sky-handoff-api.md`](https://github.com/skylab-kulubu/e-skylab-keycloak/blob/main/docs/sky-handoff-api.md)); bu belge yalnız Account Center'ın davranışını yazar.

Eski **native handoff** (Account Center'ın `POST /v1/native-handoff`, `GET /handoff` ve `POST /internal/v1/native-handoff/redeem` uçları, `sky-native-handoff` Keycloak authenticator'ı, HMAC/mTLS köprüsü) kaldırıldı; [aşağıda](#kaldırılan-native-handoff).

## Akış

1. SkyApp, kendi access token'ıyla Keycloak'tan `account-center` hedefi ve bir yol için 45 saniyelik, tek kullanımlık kod alır; WebView adresi kod başına gizli kanıt başlığıyla açar. (Keycloak.)
2. Keycloak yeni bir tarayıcı oturumu kurar ve WebView'ı hedefin giriş kapısına gönderir: `https://my.yildizskylab.com/api/auth/login?returnTo=<yol>`. (Keycloak; kapı yolu ve parametre adı `account-center` istemcisinin `sky.handoff.signInPath=/api/auth/login` ve `sky.handoff.returnParam=returnTo` özniteliklerindendir.)
3. Account Center `GET /api/auth/login` ile normal Authorization Code + S256 PKCE + PAR akışını başlatır; Keycloak yeni oturumdan sayfa göstermeden cevap verir. (Account Center.)
4. `GET /api/auth/callback` kodu değiştirir, ID token'ı doğrular, BFF oturumunu ve çerezi kurar ve `returnTo` sayfasına gider. (Account Center.)

## Account Center ne yapar

| Konu | Davranış | Kod |
| --- | --- | --- |
| Giriş kapısı | `GET /api/auth/login` handoff'u bilmez; sıradan girişle aynı uçtur. Anonim `login` bütçesi istemci başına 60 sn'de 10 istektir ([kenar güveni](auth-edge-trust.md#bütçeler)). | `src/app/api/auth/login/route.ts` |
| `returnTo` | Yalnız sabit sayfa listesinden biri kabul edilir (`/`, `/identity`, `/email`, `/security`, `/sessions`, `/permissions`, `/club-profile`, `/delete-account`). Sorgu ve parça atılır; listede olmayan bir yol ya da başka bir köken `/` olur. | `normalizeReturnTo`, `src/server/auth/oidc-flow.ts` |
| Oturum ömrü | `sky_session_expires` (Keycloak'ın bu oturumu bitireceği an) ID token'da geçerliyse BFF mutlak süresi `min(şimdi + yerel üst sınır, sky_session_expires)` olur. Yoksa ya da bozuksa başlangıç (`sky_session_started`, o da yoksa `auth_time`) + `OIDC_UPSTREAM_SESSION_MAX_SECONDS` tahmini kullanılır. Yerel üst sınır `min(8 saat, OIDC_UPSTREAM_SESSION_MAX_SECONDS)`'tur; boşta ömür 30 dakikadır. Süresi geçmiş Keycloak oturumu oturum yaratmaz (`oidc_login_failed` / `upstream_session_expired`, `/login?error=unavailable`). Ayrıntı: [Keycloak sözleşmesi](keycloak-26.7.4-contract.md#oturum-ömrü-claimleri). | `upstreamSessionBounds`, `SessionManager.create` |
| Bozuk claim | Var ama bozuk (yanlış tür, kesirli, aralık dışı) bir `sky_session_*` claim'i atılır ve girişte bir kez, değeri yazılmadan `oidc_session_claims` / `session_claim_ignored` loglanır; giriş sürer. | `src/server/auth/oidc-flow.ts` |
| `auth_time` | Handoff, uygulamadaki özgün `auth_time`'ı taşır. Account Center onu yalnız ID token'dan doğrular ve hiçbir yerde "taze giriş" saymaz: hassas işlemler `my.` içinde **Sudo mode** ister (5 dk), yöntemi olmayan kişinin Microsoft yedeği ayrı bir `prompt=login&max_age=0` turudur ve callback onun `auth_time` değerinin işlemi başlatma anından eski olmadığını arar. | `src/server/auth/sudo-routes.ts`, `oidc-flow.ts` |
| Görünüm | ID token'da `sky_embed` tam olarak `"skyapp"` ise callback, BFF oturumuyla aynı bitiş anında `__Host-sky-account-embed=skyapp` çerezini yazar; hesap sayfaları bu çerez varken mobil üst çubuğu çizmez (SkyApp'in kendi başlığı vardır). Çerez yalnız görünümdür, hiçbir yetki ona bağlı değildir; claim yoksa ya da başka bir değer taşıyorsa yazılmaz. Çerez çıkışta ya da claim'siz sonraki bir girişte silinmez; kendi bitiş anına kadar kalır. | `setEmbeddedAppCookie`, `src/app/(account)/layout.tsx` |
| Loglar | `oidc_login_started`, `oidc_login_completed`, `oidc_login_failed` (+ `providerStage`), `oidc_session_claims`. Handoff kodu, kanıt, yol ya da token hiçbir yerde yoktur: Account Center bunları almaz. | `src/server/auth/logging.ts` |

`sky_embed`, `sky_session_started` ve `sky_session_expires` `account-center` istemcisinin `account-center-core-claims` kapsamındaki mapper'larla ID token'a, access token'a ve introspection'a yazılır (Keycloak reconcile). Üçü de isteğe bağlıdır: yoklukları girişi bozmaz, yalnız yukarıdaki geri dönüşler devreye girer.

## Account Center'ın yapmadıkları

- Uygulamanın (`skyapp`) token'ını doğrulamaz, kabul etmez ve saklamaz.
- Handoff kodunu ya da `X-Sky-Handoff-Proof` başlığını okumaz. Kenarda (Traefik, Cloudflare) `X-Sky-*` başlıklarını silmek yanlıştır: `X-Sky-Sudo` ve `X-Sky-Handoff-Proof` istemcinin taşıdığı, kriptografik olarak doğrulanan değerlerdir; Account Center gelen hiçbir `X-Sky-*` başlığını okumaz.
- Hedef listesini ya da açık/kapalı durumunu yönetmez; bunlar Keycloak'taki istemci öznitelikleridir ve yalnız `/ADMIN` grubu üyeleri superadmin üzerinden değiştirir.

## Kaldırılan native handoff

Native handoff, ADR-0048 ile Web handoff'a bırakıldı ve Account Center'dan söküldü (account-center#41 ve #51):

- `POST /v1/native-handoff`, `GET /handoff` ve `POST /internal/v1/native-handoff/redeem` uç olarak yoktur. Proxy, ilk ikisini giriş yönlendirmesinden muaf tutar: eski bir SkyApp sürümü ya da kalmış bir handoff bağlantısı WebView'ında bir giriş formu değil, oturumsuz da `404` görür. Üçüncüsü dahil `/internal/*` her istekte oturumdan önce gövdesiz `404` alır ([kenar güveni](auth-edge-trust.md#public-yol-sınırı-internal-ve-well-known)). `pnpm test:retired-handoff` ve `pnpm test:edge-paths` bunu CI'da üretim derlemesiyle çalışan sunucuya karşı doğrular.
- PAR'a `sky_native_handoff` konmaz; `NATIVE_BRIDGE_HMAC_SECRET` ve `NATIVE_BRIDGE_MTLS_CLIENT_SHA256` okunmaz.
- `account_native_*` tabloları `0008_drop_native_handoff.sql` ile production'da 2026-09-25'te silindi; `0003`, geçmiş kaydı olarak yerinde durur.
- Keycloak tarafında `sky-native-handoff` authenticator'ı ve client-specific browser flow'u kaldırıldı (e-skylab-keycloak#34, SPI 1.13.0).

## İlgili belgeler

- [Keycloak sözleşmesi: oturum ömrü ve claim'ler](keycloak-26.7.4-contract.md#oturum-ömrü-claimleri)
- [Mimari: oturum ve çerezler](architecture.md#oturum-ve-çerezler)
- ADR-0048, "SkyApp-to-web handoff lives in Keycloak, not in Account center" (`skylab-kulubu/e-skylab`, `docs/adr/`).
