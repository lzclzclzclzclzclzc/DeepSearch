"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BrandMark, Icon } from "@/components/icons";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Settings } from "./settings";
import { emptyFilters, type ApiError, type SearchFilters, type SearchResponse } from "@/shared/search";
import styles from "./search.module.css";

type ViewError = ApiError["error"];
type LocationState = { query: string; filters: SearchFilters; page: number; searchId: string | null; period: string };
function fromLocation(): LocationState {
  const params = new URLSearchParams(location.search);
  return { query: params.get("q") ?? "", page: Number(params.get("page") ?? 1), searchId: params.get("searchId"), period: params.get("time") ?? "all",
    filters: { languages: (params.get("lang")?.split(",").filter(value => value === "zh" || value === "en") ?? []) as SearchFilters["languages"],
      includeDomains: params.getAll("site"), excludeDomains: params.getAll("exclude"), after: params.get("after"), before: params.get("before") } };
}
function queryURL(query: string, filters: SearchFilters, period: string, page = 1, searchId?: string) {
  const params = new URLSearchParams({ q: query, page: String(page) });
  if (searchId) params.set("searchId", searchId);
  if (filters.languages.length) params.set("lang", filters.languages.join(","));
  filters.includeDomains.forEach(value => params.append("site", value)); filters.excludeDomains.forEach(value => params.append("exclude", value));
  if (filters.after) params.set("after", filters.after); if (filters.before) params.set("before", filters.before);
  if (period !== "all") params.set("time", period);
  return `/search?${params}`;
}
const examples = ["韦布望远镜的新发现", "如何开始学习 Rust", "适合周末的城市徒步路线"];
const formatTime = (date: string) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date));

export function SearchApp() {
  const [query, setQuery] = useState(""); const [filters, setFilters] = useState<SearchFilters>(emptyFilters);
  const [period, setPeriod] = useState("all"); const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<ViewError | null>(null); const [busy, setBusy] = useState(false); const [searched, setSearched] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false); const [siteMode, setSiteMode] = useState("include"); const [siteDraft, setSiteDraft] = useState("");
  const [customOpen, setCustomOpen] = useState(false); const [after, setAfter] = useState(""); const [before, setBefore] = useState("");
  const [notice, setNotice] = useState(""); const [clearing, setClearing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const request = useRef<AbortController | null>(null); const sequence = useRef(0); const composing = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null); const input = useRef<HTMLInputElement>(null);
  const lastAction = useRef<(() => void) | null>(null);
  const applied = useRef({ query: "", filters: emptyFilters(), period: "all" });

  const load = useCallback(async (state: LocationState, mode: "push" | "replace" | "none", fresh = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const id = ++sequence.current;
    setBusy(true); setError(null); setSearched(true);
    const action = () => void load(state, mode, fresh); lastAction.current = action;
    try {
      const response = state.searchId && !fresh ? await fetch(`/api/search/${encodeURIComponent(state.searchId)}?page=${state.page}`, { signal: controller.signal, cache: "no-store" }) :
        await fetch("/api/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: state.query, filters: state.filters }), signal: controller.signal });
      const body = await response.json() as SearchResponse | ApiError;
      if (id !== sequence.current) return;
      if (!response.ok || "error" in body) { setError("error" in body ? body.error : { code: "UPSTREAM_UNAVAILABLE", message: "搜索服务暂时不可用，请重试。", retryable: true }); return; }
      setData(body); applied.current = { query: body.query, filters: state.filters, period: state.period };
      if (mode !== "none") history[mode === "push" ? "pushState" : "replaceState"]({}, "", queryURL(body.query, state.filters, state.period, body.page, body.searchId));
      requestAnimationFrame(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: "start" }); });
    } catch (failure) {
      if (id !== sequence.current || controller.signal.aborted) return;
      setError({ code: "UPSTREAM_UNAVAILABLE", message: "连接中断，请检查网络后重试。", retryable: true });
    } finally { if (id === sequence.current) setBusy(false); }
  }, []);

  useEffect(() => {
    const restore = (first: boolean) => {
      const state = fromLocation(); setQuery(state.query); setFilters(state.filters); setPeriod(state.period);
      if (state.query) void load(state, first ? "replace" : "none");
      else { request.current?.abort(); ++sequence.current; setData(null); setError(null); setSearched(false); setBusy(false); }
    };
    restore(true); const pop = () => restore(false); window.addEventListener("popstate", pop);
    return () => { request.current?.abort(); window.removeEventListener("popstate", pop); };
  }, [load]);
  useEffect(() => { if (!notice) return; const timeout = setTimeout(() => setNotice(""), 4000); return () => clearTimeout(timeout); }, [notice]);
  function search(nextQuery = query, nextFilters = filters, nextPeriod = period) {
    const value = nextQuery.trim();
    if (!value) { setError({ code: "INVALID_QUERY", message: "请输入想查找的内容。", retryable: false }); input.current?.focus(); return; }
    if ([...value].length > 128) { setError({ code: "QUERY_TOO_LONG", message: "搜索词最多为 128 个字符。", retryable: false }); input.current?.focus(); return; }
    setQuery(nextQuery); setFilters(nextFilters); setPeriod(nextPeriod); setSiteOpen(false); setCustomOpen(false);
    void load({ query: value, filters: nextFilters, period: nextPeriod, page: 1, searchId: null }, "push", true);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!composing.current) search(); }
  function changeFilters(next: SearchFilters, nextPeriod = period) {
    setFilters(next); setPeriod(nextPeriod); setSiteOpen(false); setCustomOpen(false);
    if (searched && query.trim()) search(query, next, nextPeriod);
  }
  function changePeriod(value: string) {
    if (value === "custom") { setSiteOpen(false); setCustomOpen(true); setAfter(filters.after ?? ""); setBefore(filters.before ?? ""); return; }
    const date = new Date(); date.setDate(date.getDate() - (value === "week" ? 7 : 30));
    changeFilters({ ...filters, after: value === "all" ? null : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date), before: null }, value);
  }
  function page(number: number) {
    if (!data) return;
    void load({ ...applied.current, page: number, searchId: data.searchId }, "push");
  }
  async function share() {
    if (!data) return;
    try { await navigator.clipboard.writeText(location.origin + queryURL(applied.current.query, applied.current.filters, applied.current.period)); setNotice("搜索链接已复制，接收者将从第 1 页重新检索。"); }
    catch { setNotice("暂时无法复制链接，请检查浏览器剪贴板权限。"); }
  }
  async function clear() {
    setClearing(true); request.current?.abort(); ++sequence.current; setBusy(false);
    try {
      const response = await fetch("/api/session/data", { method: "DELETE" });
      if (!response.ok) throw new Error("clear failed");
      setData(null); setQuery(""); setFilters(emptyFilters()); setPeriod("all"); setError(null); setSearched(false);
      history.pushState({}, "", "/"); setNotice("本次会话的搜索数据已清除。"); input.current?.focus();
    } catch { setNotice("暂时无法清除会话数据，请稍后重试。"); }
    finally { setClearing(false); }
  }
  const activeFilters = filters.languages.length + filters.includeDomains.length + filters.excludeDomains.length + Number(Boolean(filters.after || filters.before));
  const form = <form className={`${styles.searchBox} ${searched ? styles.compactSearch : ""}`} onSubmit={submit} role="search">
    <Icon name="search" size={22}/><label className="sr-only" htmlFor="search-query">搜索关键词</label>
    <input ref={input} id="search-query" name="q" type="search" value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) event.preventDefault(); }} placeholder="搜索你想了解的任何事物" autoComplete="off" aria-describedby={error?.code === "QUERY_TOO_LONG" ? "search-error" : undefined}/>
    <button type="submit" className={styles.searchButton} aria-label="搜索" disabled={busy}><span>搜索</span><Icon name="arrow" size={19}/></button>
  </form>;

  return <div className={`${styles.app} ${searched ? styles.resultsMode : styles.homeMode}`}>
    <header className={styles.header}>
      <a href="/" className={styles.brand} aria-label="DeepSearch 首页"><BrandMark/><span>Deep<span className={styles.brandLight}>Search</span></span></a>
      {searched && <div className={styles.headerSearch}>{form}</div>}
      <div className={styles.headerActions}><span className={styles.headerLabel}>网页搜索</span><button className="icon-button" type="button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings"/></button><ThemeToggle/></div>
    </header>
    <main id="main-content" className={searched ? styles.resultsMain : styles.homeMain}>
      {!searched && <section className={styles.hero} aria-label="开始搜索">
        <div className={styles.kicker}><span className={styles.liveDot}/> 一个问题，无限可能 <span className={styles.kickerLine}/></div>
        <h1>让好奇，<br/><span>找到方向。</span><span className={styles.headingDot}>✳</span></h1>
        <p className={styles.heroDescription}>从灵光一闪，到清晰答案。<br className={styles.mobileBreak}/>在广阔的网络里，发现值得阅读的内容。</p>
        {form}
        <div className={styles.suggestions}><span>试着探索</span>{examples.map(example => <button key={example} type="button" onClick={() => search(example)}>{example}<Icon name="arrow" size={14}/></button>)}</div>
        <div className={styles.heroNote}><Icon name="globe" size={15}/><span>连接真实网页，让每一次发现都有出处。</span></div>
        <div className={styles.heroDecoration} aria-hidden="true"><div/><div/><span>OPEN A NEW PERSPECTIVE</span></div>
      </section>}
      {searched && <>
        <div className={styles.toolRow}><span className={styles.activeTab}><Icon name="globe" size={17}/>网页</span><div className={styles.toolRight}><span>找到线索，继续探索</span><button className="text-button" onClick={share} disabled={!data}><Icon name="share" size={16}/>分享搜索</button></div></div>
        <div className={styles.filters} aria-label="搜索筛选">
          <label className={styles.selectControl}><Icon name="clock" size={16}/><span className="sr-only">时间范围</span><select aria-label="时间范围" value={customOpen ? "custom" : period} onChange={event => changePeriod(event.target.value)}><option value="all">不限时间</option><option value="week">最近一周</option><option value="month">最近一月</option><option value="custom">自定义日期</option></select></label>
          <label className={styles.selectControl}><Icon name="globe" size={16}/><span className="sr-only">结果语言</span><select aria-label="结果语言" value={filters.languages.join(",")} onChange={event => changeFilters({ ...filters, languages: event.target.value ? event.target.value.split(",") as SearchFilters["languages"] : [] })}><option value="">不限语言</option><option value="zh">中文</option><option value="en">英文</option><option value="zh,en">中文和英文</option></select></label>
          <button className={`${styles.filterButton} ${siteOpen ? styles.filterActive : ""}`} aria-expanded={siteOpen} aria-controls="site-filter" onClick={() => { setSiteOpen(!siteOpen); setCustomOpen(false); setSiteDraft([...filters.includeDomains, ...filters.excludeDomains].join(", ")); setSiteMode(filters.excludeDomains.length ? "exclude" : "include"); }}><Icon name="filter" size={16}/>{filters.includeDomains.length + filters.excludeDomains.length ? "已筛选站点" : "全部站点"}<Icon name="chevron" size={12} style={{ transform: "rotate(90deg)" }}/></button>
          {activeFilters > 0 && <button className={styles.resetFilters} onClick={() => changeFilters(emptyFilters(), "all")}><Icon name="close" size={14}/>清除筛选</button>}
          {siteOpen && <form id="site-filter" className={styles.filterPanel} onSubmit={event => { event.preventDefault(); const domains = siteDraft.split(/[,，\s]+/u).filter(Boolean); changeFilters({ ...filters, includeDomains: siteMode === "include" ? domains : [], excludeDomains: siteMode === "exclude" ? domains : [] }); }}><div className={styles.panelHeading}>筛选来源站点<button type="button" className="icon-button" aria-label="关闭站点筛选" onClick={() => setSiteOpen(false)}><Icon name="close" size={16}/></button></div><label>筛选方式<select aria-label="站点筛选方式" value={siteMode} onChange={event => setSiteMode(event.target.value)}><option value="include">仅包含这些站点</option><option value="exclude">排除这些站点</option></select></label><label>域名<input value={siteDraft} onChange={event => setSiteDraft(event.target.value)} placeholder="例如 wikipedia.org" autoFocus/></label><p>最多 5 个域名，用逗号分隔，不含 https://。</p><button type="submit" className="primary-button">应用筛选<Icon name="arrow" size={16}/></button></form>}
          {customOpen && <form className={styles.filterPanel} onSubmit={event => { event.preventDefault(); changeFilters({ ...filters, after: after || null, before: before || null }, "custom"); }}><div className={styles.panelHeading}>自定义日期<button className="icon-button" aria-label="关闭日期筛选" type="button" onClick={() => setCustomOpen(false)}><Icon name="close" size={16}/></button></div><label>开始日期<input type="date" value={after} onChange={event => setAfter(event.target.value)}/></label><label>结束日期<input type="date" value={before} onChange={event => setBefore(event.target.value)}/></label><p>按网页发布时间筛选。</p><button type="submit" className="primary-button">应用日期<Icon name="arrow" size={16}/></button></form>}
        </div>
        {activeFilters > 0 && <div className={styles.filterSummary}>{filters.includeDomains.map(d => <span key={d}>仅限 {d}</span>)}{filters.excludeDomains.map(d => <span key={d}>排除 {d}</span>)}{(filters.after || filters.before) && <button type="button" onClick={() => { setSiteOpen(false); setCustomOpen(true); setAfter(filters.after ?? ""); setBefore(filters.before ?? ""); }} title="编辑日期范围">{filters.after ?? "不限起始"} — {filters.before ?? "不限结束"}<Icon name="filter" size={13}/></button>}</div>}
      </>}
      {error && <div id="search-error" className={styles.error} role="alert"><Icon name="alert" size={22}/><div><strong>{error.code === "SNAPSHOT_EXPIRED" ? "本次搜索已过期" : "这次搜索遇到了一点问题"}</strong><p>{error.message}</p>{data && <p>下方保留上次成功获取的结果。</p>}{error.code === "SNAPSHOT_EXPIRED" ? <button className="text-button" onClick={() => search()}>重新搜索<Icon name="arrow" size={15}/></button> : error.retryable && <button className="text-button" onClick={() => lastAction.current?.()}>重试<Icon name="arrow" size={15}/></button>}</div></div>}
      {searched && <div className={styles.resultGrid}><section className={styles.resultColumn} aria-busy={busy}>
        {data?.warnings.map(warning => <p className={styles.staleWarning} role="status" key={warning}>{warning}</p>)}
        <div className={styles.resultMeta}><h1 ref={heading} tabIndex={-1} className={styles.resultHeading}>{data ? data.snapshotCount ? <>第 {(data.page - 1) * 10 + 1}–{Math.min(data.page * 10, data.snapshotCount)} 条<span> / 本次共 {data.snapshotCount} 条</span></> : "本次未找到结果" : busy ? "正在查找相关网页…" : "搜索结果"}</h1>{data && <span className={styles.fetchedTime}>{formatTime(data.fetchedAt)} 获取{data.cache === "stale" ? " · 较早结果" : ""}</span>}</div>
        {busy && !data ? <div className={styles.skeletons} aria-label="正在加载搜索结果">{Array.from({ length: 5 }, (_, i) => <div className={styles.skeleton} key={i}><i/><b/><span/><span/></div>)}</div> : data?.snapshotCount === 0 ? <div className={styles.emptyState}><div className={styles.emptyIcon}><Icon name="search" size={28}/></div><h2>有时候，换个问法就能找到。</h2><p>试试更简短的关键词，<br/>或取消部分筛选，给发现多一点空间。</p>{activeFilters > 0 && <button className="primary-button" onClick={() => changeFilters(emptyFilters(), "all")}>取消筛选，重新搜索<Icon name="arrow" size={16}/></button>}</div> : <div className={busy ? styles.dimResults : ""}>{data?.results.map(result => <article className={styles.result} key={result.sourceId}>
          <div className={styles.source}><span className={styles.domainIcon} aria-hidden="true">{result.domain.replace(/^www\./, "").slice(0, 1).toUpperCase()}</span><div><span className={styles.siteName}>{result.siteName}</span><span className={styles.sourcePath}>{result.domain}{result.publishedAt && <><span> · </span><time dateTime={result.publishedAt}>{new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(result.publishedAt))}</time></>}</span></div><span className={styles.sourceNumber}>{result.sourceId}</span></div>
          <h2><a href={result.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{result.title}<Icon name="external" size={15}/></a></h2><p className={styles.snippet}>{result.snippet || "此网页暂未提供摘要，打开来源了解更多。"}</p>
        </article>)}</div>}
        {data && data.totalPages > 0 && <nav className={styles.pagination} aria-label="搜索结果分页"><button onClick={() => page(data.page - 1)} disabled={!data.hasPreviousPage} aria-label="上一页"><Icon name="chevron" size={16} style={{ transform: "rotate(180deg)" }}/><span>上一页</span></button><div className={styles.pageNumbers}>{Array.from({ length: data.totalPages }, (_, i) => i + 1).map(number => <button key={number} onClick={() => page(number)} aria-label={`第 ${number} 页`} aria-current={data.page === number ? "page" : undefined}>{number}</button>)}</div><span className={styles.mobilePage}>{data.page} / {data.totalPages}</span><button onClick={() => page(data.page + 1)} disabled={!data.hasNextPage} aria-label="下一页"><span>下一页</span><Icon name="chevron" size={16}/></button></nav>}
        {data && data.totalPages > 0 && <p className={styles.paginationNote}>{data.hasNextPage ? "每页 10 条 · 翻页继续浏览本次搜索结果" : "已到本次结果末页 · 试着调整关键词，发现更多"}</p>}
      </section><aside className={styles.aside}><span className={styles.asideSymbol}>↗</span><p className={styles.asideEyebrow}>FOLLOW YOUR CURIOSITY</p><h2>答案之外，<br/>还有新发现。</h2><p>打开原网页，阅读完整语境。<br/>让信息有来源，让探索有方向。</p><div className={styles.asideRule}/><span className={styles.asideNote}>保留来源顺序 · 每页 10 条</span>{data?.warnings.map(warning => <p className={styles.staleWarning} key={warning}>{warning}</p>)}</aside></div>}
      <p className="sr-only" role="status" aria-live="polite">{busy ? "正在加载，请稍候。" : data ? `已显示第 ${data.page} 页，本次共 ${data.snapshotCount} 条结果。` : ""}</p>
    </main>
    <footer className={styles.footer}><span className={styles.footerBrand}>DeepSearch<span>保持好奇，持续发现。</span></span><div><span className={styles.powered}>由 DeepSeek Search 提供检索</span><button onClick={clear} disabled={clearing} className="text-button"><Icon name="trash" size={14}/>{clearing ? "正在清除…" : "清除会话数据"}</button></div></footer>
    {notice && <div className={styles.toast} role="status"><Icon name="check" size={17}/>{notice}</div>}
    <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)}/>
  </div>;
}
