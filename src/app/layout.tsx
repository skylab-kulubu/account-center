import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { ThemeScript } from "@skylab-kulubu/skylcn-ui";
import { TasarimSaglayici } from "@/components/tasarim-baglam";
import { currentTasarim } from "@/server/tasarim";
import "./globals.css";
import "./tasarim.css";

// skylcn-ui's tokens read the faces from these two variables (ADR 0055).
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--skylcn-font-sans",
  display: "swap",
});

// Only the TOTP secret and technical details are set in mono, so it is not preloaded on every page.
const spaceMono = Space_Mono({
  subsets: ["latin", "latin-ext"],
  weight: "400",
  variable: "--skylcn-font-mono",
  display: "swap",
  preload: false,
});

export const viewport: Viewport = {
  colorScheme: "dark",
  // skylcn-ui's dark --sidebar, the page surface
  themeColor: "#0a0a0a",
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://my.yildizskylab.com"),
  title: {
    default: "Hesap Merkezi | SKY LAB",
    template: "%s | SKY LAB Hesap Merkezi",
  },
  description: "SKY LAB hesabını, giriş yöntemlerini ve oturumlarını güvenle yönet.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  // GEÇİCİ tasarım anahtarı: yeni yönlerde açık/koyu tema (skylcn ThemeScript, Panel ile aynı).
  const tasarim = await currentTasarim();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html
      lang="tr"
      className={`${spaceGrotesk.variable} ${spaceMono.variable}`}
      data-tasarim={tasarim === "eski" ? undefined : tasarim}
      suppressHydrationWarning={tasarim !== "eski"}
    >
      {tasarim === "eski" ? null : <head><ThemeScript nonce={nonce} /></head>}
      <body>
        <TasarimSaglayici value={tasarim}>{children}</TasarimSaglayici>
      </body>
    </html>
  );
}
