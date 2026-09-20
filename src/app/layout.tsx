import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#08070b",
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

  return (
    <html lang="tr" className={spaceGrotesk.variable}>
      <body>{children}</body>
    </html>
  );
}
