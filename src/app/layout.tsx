import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import { ThemeScript } from "@skylab-kulubu/skylcn-ui";
import "./globals.css";
import "./account.css";

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
  colorScheme: "dark light",
  // skylcn-ui's dark --sidebar, the page surface
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fdfcfa" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://my.yildizskylab.com"),
  title: {
    default: "Hesap Merkezi | SKY LAB",
    template: "%s | SKY LAB Hesap Merkezi",
  },
  description: "SKY LAB hesabını, giriş yöntemlerini ve oturumlarını yönet.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  // The reader's light/dark/system choice (skylcn-ui, as in the panel and İletişim), set before paint.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="tr" className={`${spaceGrotesk.variable} ${spaceMono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body>{children}</body>
    </html>
  );
}
