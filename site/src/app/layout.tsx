import type { Metadata, Viewport } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import { BootPoller } from "@/components/chat/BootPoller";
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
  title: "Майко — чат",
  description: "Минималистичный онлайн-чат: ЛС, группы и каналы",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Майко",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0c10",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
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
        <BootPoller />
        {children}
      </body>
    </html>
  );
}
