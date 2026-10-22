"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import styles from "./settings.module.css";
import type { DailyUsage } from "@/shared/search";

type Status = { configured: boolean; source: "personal" | "server" | "none"; state: "saved" | "invalid" | "balance" };
export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status | null>(null); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState<DailyUsage | null>(null); const [usageError, setUsageError] = useState(""); const [usageBusy, setUsageBusy] = useState(false);
  const money = (value: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
  async function refreshUsage(signal?: AbortSignal) {
    setUsageBusy(true); setUsageError("");
    try {
      const response = await fetch("/api/usage/today", { signal, cache: "no-store" });
      if (!response.ok) throw new Error("费用统计暂时不可用，请稍后刷新。");
      const body = await response.json(); if (!signal?.aborted) setUsage(body);
    } catch { if (!signal?.aborted) setUsageError("费用统计暂时不可用，请稍后刷新。"); }
    finally { if (!signal?.aborted) setUsageBusy(false); }
  }
  useEffect(() => {
    if (!open) { dialog.current?.close(); return; }
    dialog.current?.showModal(); setKey(""); setError(""); setNotice(""); setStatus(null);
    const controller = new AbortController();
    setUsage(null); void refreshUsage(controller.signal);
    void fetch("/api/session/config", { signal: controller.signal, cache: "no-store" }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "暂时无法读取配置。");
      setStatus(body);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "暂时无法读取配置。"); });
    return () => controller.abort();
  }, [open]);
  function close() { setKey(""); onClose(); }
  async function update(remove = false) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/session/config", { method: remove ? "DELETE" : "POST", headers: remove ? undefined : { "Content-Type": "application/json" }, body: remove ? undefined : JSON.stringify({ apiKey: key }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "暂时无法保存配置。");
      setStatus(body); setKey(""); setNotice(remove ? "个人密钥已移除。" : "密钥已保存，将在下次搜索时验证可用性。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法保存配置。"); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void update(); }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="settings-title" aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) close(); }} onClick={event => { if (event.target === dialog.current && !busy) close(); }}>
    <div className={styles.content}>
      <div className={styles.heading}><div><p>让探索继续</p><h2 id="settings-title">设置</h2></div><button type="button" className="icon-button" aria-label="关闭设置" disabled={busy} onClick={close}><Icon name="close"/></button></div>
      <div className={styles.sectionTitle}><Icon name="key" size={21}/><h3>配置 API key</h3></div>
      <p className={styles.description}>使用你的 DeepSeek API key 进行网页搜索。</p>
      {status && <p className={styles.keyStatus} role="status"><span/>{status.source === "personal" ? status.state === "invalid" ? "个人密钥无效，请更新" : status.state === "balance" ? "个人密钥账户余额不足" : "已配置个人密钥" : status.source === "server" ? "当前使用站点提供的密钥" : "尚未配置密钥"}</p>}
      <form onSubmit={submit}>
        <label className={styles.keyLabel} htmlFor="api-key">DeepSeek API key</label>
        <input id="api-key" name="deepseek-api-key" type="password" value={key} onChange={event => setKey(event.target.value)} placeholder={status?.source === "personal" ? "输入新的密钥以替换" : "输入你的 API key"} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={256} disabled={busy}/>
        <p className={styles.privacy}>密钥仅供当前会话使用，加密保存，最长保留 24 小时。清除会话数据会同时移除个人密钥。个人密钥优先于站点密钥；搜索费用计入你的 DeepSeek 账户。</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        <div className={styles.actions}>{status?.source === "personal" && <button className="text-button" type="button" disabled={busy} onClick={() => void update(true)}><Icon name="trash" size={15}/>移除个人密钥</button>}<button className="primary-button" type="submit" disabled={busy || !key.trim()}>{busy ? "正在保存…" : "保存密钥"}<Icon name="check" size={17}/></button></div>
      </form>
      <section className={styles.usageSection} aria-labelledby="usage-title" data-testid="today-spending" aria-busy={usageBusy}>
        <div className={styles.usageHeading}><h3 id="usage-title">今日开销</h3><button className="icon-button" type="button" aria-label="刷新今日开销" disabled={usageBusy} onClick={() => void refreshUsage()}><Icon name="clock" size={17}/></button></div>
        {usage ? <><p className={styles.usageDate}>{usage.day} · 北京时间 · 本站全部调用</p><p className={styles.usageTotal}>{money(usage.totalCny)}<span>估算合计</span></p><dl className={styles.usageDetails}><div><dt>已确认</dt><dd>{money(usage.confirmedCny)}</dd></div><div><dt>处理中</dt><dd>{money(usage.pendingCny)}</dd></div><div><dt>待核对</dt><dd>{money(usage.uncertainCny)}</dd></div></dl><p className={styles.usageDate}>今日请求 {usage.attempts} 次 · 计费搜索 {usage.paidSearches} 次</p></> : !usageError && <p className={styles.usageDate} role="status">正在读取今日开销…</p>}
        {usageError && <p className={styles.error} role="status">{usageError}</p>}
        <p className={styles.privacy}>仅统计本站调用，不包含其他客户端费用；超时等未确认请求暂按可能产生的费用计入，以 DeepSeek 实际账单为准。</p>
      </section>
      <a className={styles.getKey} href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">前往 DeepSeek 获取 API key<Icon name="external" size={13}/></a>
    </div>
  </dialog>;
}
