import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: "DeepSearch · 让好奇，找到方向",
  description: "从一个问题出发，发现值得阅读的网页。",
  referrer: "no-referrer",
  icons: {
    icon: [
      { url: "/brand/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
  },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = (await cookies()).get("ds_theme")?.value;
  return <html lang="zh-CN" data-theme={theme === "dark" || theme === "light" ? theme : undefined}><body><a className="skip-link" href="#main-content">跳转到主要内容</a>{children}</body></html>;
}
