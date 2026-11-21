import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Asset Vault",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Every page is rendered per request: the CSP nonce (src/proxy.ts) is new each time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
