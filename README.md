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
pnpm test:e2e
docker build -t account-center:local .
```

Production başlangıcında `.env.example` içindeki sunucu değişkenleri doğrulanır. Secret’lar `NEXT_PUBLIC_` önekiyle tanımlanamaz ve client bundle’a taşınmaz. Dosyadaki köşeli parantezli değerler bilerek geçersizdir; doğrudan kullanılırsa servis başlamaz. `SESSION_SECRET` üretmek için `openssl rand -base64 48` kullanılabilir. Keycloak client secret en az 32 karakterli gerçek confidential-client secret’ı olmalıdır.

## Sınırlar

- Kişisel bilgiler yalnız Keycloak’taki ad, soyad ve birincil e-postadır.
- Şifre, OTP ve passkey mutasyonları Keycloak AIA ile yapılır.
- Telefon, öğrenci kartı, kulüp rolleri, SkyPass ve uygulama verileri bu ürünün kapsamında değildir.
- Mobile repository değiştirilmez; WebView entegrasyonu ayrı, sürümlü bir sözleşmeyle teslim edilir.
- Hesap silme mevcut fiziksel kullanıcı silme endpoint’ini çağırmaz; dayanıklı silme/anonimleştirme akışı kullanır.

Ayrıntılar için [mimari notlara](docs/architecture.md) bakın.
