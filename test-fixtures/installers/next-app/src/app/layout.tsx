import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Installer Fixture — Next App Router",
  description:
    "Minimal real create-next-app scaffold for the installer harness",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
