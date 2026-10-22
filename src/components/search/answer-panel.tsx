"use client";
import { useEffect, useRef, useState } from "react";
import type { Answer, AnswerBlock, Citation } from "@/shared/answer";
import { readSSE } from "@/shared/sse";
import { Icon } from "@/components/icons";
import styles from "./answer-panel.module.css";

export function AnswerPanel({ searchId, disabled, onSource }: { searchId: string; disabled: boolean; onSource: (id: string) => void }) {
  const [blocks, setBlocks] = useState<AnswerBlock[]>([]); const [sources, setSources] = useState<Citation[]>([]);
  const [phase, setPhase] = useState<"idle" | "preparing" | "generating" | "done" | "stopped" | "error">("idle");
  const [error, setError] = useState(""); const [generatedAt, setGeneratedAt] = useState(""); const [restoring, setRestoring] = useState(true);
  const active = useRef<AbortController | null>(null); const epoch = useRef(0);
  const busy = phase === "preparing" || phase === "generating";
  useEffect(() => {
    const controller = new AbortController(); const id = ++epoch.current;
    void fetch(`/api/search/${searchId}/answer`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) return;
      const { answer } = await response.json() as { answer: Answer | null };
      if (answer && id === epoch.current && !controller.signal.aborted) { setBlocks(answer.blocks); setSources(answer.sources); setGeneratedAt(answer.generatedAt); setPhase("done"); }
    }).catch(() => {}).finally(() => { if (id === epoch.current && !controller.signal.aborted) setRestoring(false); });
    return () => { ++epoch.current; controller.abort(); active.current?.abort(); };
  }, [searchId]);
  function stop() { ++epoch.current; active.current?.abort(); active.current = null; setPhase("stopped"); }
  async function generate() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; const id = ++epoch.current;
    setBlocks([]); setSources([]); setError(""); setGeneratedAt(""); setPhase("preparing");
    try {
      const response = await fetch(`/api/search/${searchId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID() }), signal: controller.signal });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message || "暂时无法生成总结。"); }
      if (!response.body) throw new Error("总结连接中断，请重试。");
      let completed = false;
      for await (const frame of readSSE(response.body)) {
        if (id !== epoch.current || controller.signal.aborted) return;
        const body = JSON.parse(frame.data);
        if (frame.event === "status") { setPhase(body.phase === "preparing" ? "preparing" : "generating"); if (body.sources) setSources(body.sources); }
        if (frame.event === "answer.block") setBlocks(previous => [...previous, body as AnswerBlock]);
        if (frame.event === "error") throw new Error(body.message || "总结生成中断。");
        if (frame.event === "done") { setBlocks(body.blocks); setSources(body.sources); setGeneratedAt(body.generatedAt); setPhase("done"); completed = true; }
      }
      if (!completed) throw new Error("总结连接中断，已保留收到的内容，可重试。");
    } catch (failure) {
      if (controller.signal.aborted || id !== epoch.current) return;
      setError(failure instanceof Error ? failure.message : "总结暂时无法完成，请稍后重试。"); setPhase("error");
    } finally { if (id === epoch.current) active.current = null; }
  }
  return <section id="answer-panel" tabIndex={-1} className={styles.panel} aria-label="AI 总结">
    <div className={styles.heading}><div><span className={styles.mark} aria-hidden="true">AI</span><h2>AI 总结</h2></div>
      {busy ? <button className="text-button" type="button" onClick={stop}><Icon name="close" size={14}/>停止生成</button> : phase !== "done" && <button className={styles.generate} type="button" onClick={() => void generate()} disabled={disabled || restoring}>{phase === "idle" ? "生成 AI 总结" : "重新生成"}<Icon name="arrow" size={15}/></button>}
    </div>
    {phase === "idle" && <p className={styles.description}>根据本次搜索的来源生成，点击后开始。</p>}
    {busy && <p className={styles.status} role="status"><span/>{phase === "preparing" ? "正在整理来源…" : "正在生成有来源的总结…"}</p>}
    <div className={styles.blocks} aria-live="polite" aria-relevant="additions">
      {blocks.map((block, index) => <div key={index} className={block.notice ? styles.notice : styles.block}>
        <p>{block.text}</p>{block.citations.map(id => { const source = sources.find(item => item.sourceId === id); return source && <button key={id} className={styles.citation} type="button" title={source.title} onClick={() => onSource(id)} aria-label={`查看来源 ${id}`}>{id}</button>; })}
      </div>)}
    </div>
    {phase === "stopped" && <p className={styles.description} role="status">已停止生成，已收到的内容保留在此。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {sources.length > 0 && (blocks.length > 0 || phase === "done") && <details className={styles.sources}><summary>参考来源 · {sources.length}</summary><ol>{sources.map(source => <li key={source.sourceId}><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.sourceId} · {source.title}<Icon name="external" size={11}/></a><span>{source.publishedAt ? `发布于 ${source.publishedAt.slice(0, 10)}` : "发布日期未知"} · 获取于 {new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(new Date(source.fetchedAt))}</span></li>)}</ol></details>}
    {phase === "done" && <p className={styles.description}>AI 根据网页证据整理，请结合原文核对。{generatedAt && <time dateTime={generatedAt}> {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(generatedAt))} 生成</time>}</p>}
  </section>;
}
