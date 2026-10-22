"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  function toggle() {
    const next = dark ? "light" : "dark"; document.documentElement.dataset.theme = next;
    document.cookie = `ds_theme=${next}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    setDark(!dark);
  }
  return <button className="icon-button theme-toggle" type="button" onClick={toggle} aria-label={dark ? "切换为浅色主题" : "切换为深色主题"} title={dark ? "切换为浅色主题" : "切换为深色主题"}><Icon name={dark ? "sun" : "moon"}/></button>;
}
