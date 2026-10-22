"use client";
import { useState } from "react";
import Image from "next/image";
import styles from "./whale-mascot.module.css";

export function HomeWhale() {
  return <aside className={styles.home} aria-label="鲸鱼娘的问候" data-testid="home-whale">
    <p className={styles.bubble}>你要查什么呀</p>
    <Image src="/brand/whale-girl-peek.webp" width={640} height={1045} alt="" aria-hidden="true" draggable={false} unoptimized/>
  </aside>;
}

export function CornerWhale() {
  const [left, setLeft] = useState(false);
  return <button type="button" className={`${styles.corner} ${left ? styles.left : ""}`} onClick={() => setLeft(value => !value)}
    aria-label={left ? "把鲸鱼娘移到右下角" : "把鲸鱼娘移到左下角"} aria-pressed={left} data-side={left ? "left" : "right"} data-testid="corner-whale">
    <Image className={styles.chibi} src="/brand/whale-girl-chibi.webp" width={300} height={454} alt="" aria-hidden="true" draggable={false} unoptimized/>
  </button>;
}
