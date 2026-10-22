import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "@/styles/globals.css";

export const metadata: Metadata = { title: "DeepSearch · 让好奇，找到方向", description: "从一个问题出发，发现值得阅读的网页。", referrer: "no-referrer", icons: { icon: "/icon.svg" }, robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = (await cookies()).get("ds_theme")?.value;
  return <html lang="zh-CN" data-theme={theme === "dark" || theme === "light" ? theme : undefined}><body><a className="skip-link" href="#main-content">跳转到主要内容</a>{children}</body></html>;
}
