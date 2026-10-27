import type { Metadata, Viewport } from "next";
import StockTicker from "../components/ticker/StockTicker";
import { THEME_BOOT } from "../lib/theme";
import "./globals.css";
import "../components/views/views.css";

export const metadata: Metadata = {
  title: "WorkflwPro",
  description: "Run a 3-tier agent team from any browser.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d12",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is set by the boot script before hydration, so React shouldn't complain about it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <StockTicker />
        {children}
      </body>
    </html>
  );
}
