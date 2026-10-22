import type { CSSProperties } from "react";
import Image from "next/image";
export type IconName = "search" | "arrow" | "sun" | "moon" | "chevron" | "close" | "filter" | "globe" | "clock" | "share" | "trash" | "alert" | "check" | "external" | "settings" | "key";
const paths: Record<IconName, React.ReactNode> = {
  search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon: <path d="M20.5 14.1A8.6 8.6 0 0 1 9.9 3.5a8.6 8.6 0 1 0 10.6 10.6Z"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  filter: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  share: <><path d="M12 16V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2"/></>,
  trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
  alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  external: <><path d="M14 4h6v6m0-6-9 9M10 4H4v16h16v-6"/></>,
  settings: <><path d="m9 3-.6 2-2 .9-1.9-.5-2 3.4L4 10.2v2.6l-1.5 1.4 2 3.4 1.9-.5 2 .9L9 20h4l.6-2 2-.9 1.9.5 2-3.4-1.5-1.4v-2.6l1.5-1.4-2-3.4-1.9.5-2-.9L13 3Z"/><circle cx="11" cy="11.5" r="3"/></>,
  key: <><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/></>,
};
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
export function BrandMark({ size = 40 }: { size?: number }) {
  return <Image className="brand-mark" src="/brand/whale-girl.webp" width={size} height={size} alt="" aria-hidden="true" unoptimized priority/>;
}
