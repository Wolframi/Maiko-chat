import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
});

const body = Manrope({
  variable: "--font-dm",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Pulse — чат",
  description: "Минималистичный онлайн-чат: ЛС, группы и каналы",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Pulse",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e0e10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${display.variable} ${body.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
