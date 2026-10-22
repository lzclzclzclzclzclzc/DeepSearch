import { z } from "zod";
import { SearchError, type SearchResult } from "@/shared/search";
import { getConfig } from "@/server/infra/config";

export const upstreamSchema = z.object({ results: z.array(z.object({
  title: z.string().max(4000), url: z.string().max(8192), snippet: z.string().max(10000),
  summary: z.string().nullish().default(""), content: z.string().nullish().default(""),
  site_name: z.string().nullish(), site_icon: z.string().nullish(), date: z.string().nullish(),
  rerank_score: z.number().min(0).max(3).optional(), authority: z.number().int().min(-1).max(4).optional(),
})).max(50) });
export type Evidence = SearchResult & { summary: string };

export function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.includes(":") || /^(?:127|10|0|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(host)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid", "msclkid"].includes(key.toLowerCase())) url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}
export function normalizeResults(raw: unknown): Evidence[] {
  const parsed = upstreamSchema.safeParse(raw);
  if (!parsed.success) throw new SearchError("UPSTREAM_UNAVAILABLE", "搜索服务返回了无法识别的数据，请稍后重试。", 502, true);
  const seen = new Set<string>();
  return parsed.data.results.flatMap(result => {
    const canonical = canonicalUrl(result.url);
    if (!canonical || seen.has(canonical)) return [];
    seen.add(canonical);
    const domain = new URL(result.url).hostname;
    return [{ sourceId: `S${String(seen.size).padStart(2, "0")}`, title: result.title.trim() || domain,
      url: result.url, domain, siteName: result.site_name?.trim() || domain, snippet: result.snippet,
      summary: result.summary || "", publishedAt: result.date && Number.isFinite(Date.parse(result.date)) ? new Date(result.date).toISOString() : null }];
  });
}
export class UpstreamFailure extends Error {
  constructor(public status: number, public retryDelay: number, public uncertain: boolean) { super("Upstream request failed"); }
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
}
export async function requestSearch(query: string, signal: AbortSignal, apiKey?: string): Promise<{ results: Evidence[]; billed: boolean }> {
  const config = getConfig();
  const key = apiKey ?? config.DEEPSEEK_API_KEY;
  if (!key) throw new SearchError("API_KEY_INVALID", "请先在设置中配置 API key。", 400);
  let response: Response;
  try {
    response = await fetch("https://api.deepseek.com/v1/tools/search", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: 50, need_content: false }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.SEARCH_TIMEOUT_MS)]), cache: "no-store", redirect: "error",
    });
  } catch { throw new UpstreamFailure(0, 200 + Math.floor(Math.random() * 150), true); }
  if (!response.ok) {
    const after = response.headers.get("retry-after");
    const delay = after ? (/^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now())) : 200 + Math.floor(Math.random() * 150);
    await response.body?.cancel();
    throw new UpstreamFailure(response.status, Number.isFinite(delay) ? delay : 1000, false);
  }
  // Bound decoded response size even if the supplier omits Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamFailure(502, 0, true);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_000_000) { await reader.cancel(); throw new Error("oversize"); } chunks.push(value); }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const results = normalizeResults(payload);
    return { results, billed: upstreamSchema.parse(payload).results.length > 0 };
  } catch { throw new UpstreamFailure(502, 0, true); }
}
